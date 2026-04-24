import { MetadataError, WriteConflictError } from "./errors";
import { safeErrorMessage } from "./security";
import {
  CacheStore,
  FileFilters,
  FileMetadataEntry,
  FileRecord,
  FileWithMetadata,
  MetadataDocument,
  ProviderAdapter,
  TelemetryHook,
} from "./types";

const METADATA_FILE_NAME = "metadata.json";

type WriteConflictOptions = {
  policy: "retry-merge" | "fail-fast";
  maxRetries: number;
  backoffMs: number;
};

function createEmptyMetadataDocument(): MetadataDocument {
  return {
    version: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    entries: {},
    indexes: {
      tags: {},
      categories: {},
    },
  };
}

export class MetadataManager {
  private readonly provider: ProviderAdapter;
  private readonly folderId: string;
  private readonly cache: CacheStore;
  private readonly cacheTtlMs: number;
  private readonly writeConflict: WriteConflictOptions;
  private readonly telemetry: TelemetryHook | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    provider: ProviderAdapter,
    folderId: string,
    cache: CacheStore,
    cacheTtlMs: number,
    writeConflict: WriteConflictOptions,
    telemetry?: TelemetryHook
  ) {
    this.provider = provider;
    this.folderId = folderId;
    this.cache = cache;
    this.cacheTtlMs = cacheTtlMs;
    this.writeConflict = writeConflict;
    this.telemetry = telemetry;
  }

  private get cacheKey(): string {
    return `metadata:${this.folderId}`;
  }

  async load(forceRefresh = false): Promise<MetadataDocument> {
    const cached = this.cache.get<MetadataDocument>(this.cacheKey);
    if (!forceRefresh) {
      if (cached) {
        return cached;
      }
    }

    try {
      const content = await this.provider.getFileContent(this.folderId, METADATA_FILE_NAME);
      if (!content) {
        if (cached) {
          return cached;
        }

        const empty = createEmptyMetadataDocument();
        this.cache.set(this.cacheKey, empty, this.cacheTtlMs);
        return empty;
      }

      const parsed = JSON.parse(content) as MetadataDocument;
      if (!parsed.entries || !parsed.indexes) {
        throw new MetadataError("Invalid metadata.json format. Expected entries and indexes.");
      }

      if (typeof parsed.revision !== "number") {
        parsed.revision = 0;
      }
      parsed.indexes = this.rebuildIndexes(parsed.entries);
      this.cache.set(this.cacheKey, parsed, this.cacheTtlMs);
      return parsed;
    } catch (error) {
      if (error instanceof MetadataError) {
        throw error;
      }
      throw new MetadataError(`Failed to load metadata.json: ${safeErrorMessage(error, "Unexpected metadata error.")}`);
    }
  }

  async save(document: MetadataDocument): Promise<void> {
    const payload = JSON.stringify(document, null, 2);
    try {
      await this.provider.upsertFile(this.folderId, METADATA_FILE_NAME, payload, "application/json");
      this.cache.set(this.cacheKey, document, this.cacheTtlMs);
    } catch (error) {
      throw new MetadataError(`Failed to save metadata.json: ${safeErrorMessage(error, "Unexpected metadata error.")}`);
    }
  }

  async addOrUpdateMetadata(fileId: string, metadataObject: Record<string, unknown>): Promise<FileMetadataEntry> {
    return this.withWriteLock(async () => {
      let result: FileMetadataEntry | undefined;

      await this.commitWithConflictHandling((document) => {
        const previous = document.entries[fileId];
        const entry: FileMetadataEntry = {
          fileId,
          updatedAt: new Date().toISOString(),
          ...(previous ?? {}),
          ...metadataObject,
        };

        document.entries[fileId] = entry;
        result = entry;
      }, `metadata entry '${fileId}'`);

      if (!result) {
        throw new MetadataError(`Failed to update metadata entry '${fileId}'.`);
      }

      return result;
    });
  }

  async removeMetadata(fileId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      let removed = false;
      await this.commitWithConflictHandling((document) => {
        if (!document.entries[fileId]) {
          return false;
        }

        delete document.entries[fileId];
        removed = true;
        return true;
      }, `remove metadata entry '${fileId}'`);

      return removed;
    });
  }

  async removeMetadataForMissingFiles(existingFiles: FileRecord[]): Promise<void> {
    await this.withWriteLock(async () => {
      const existingFileIds = new Set(existingFiles.map((file) => file.id));
      await this.commitWithConflictHandling((document) => {
        let removedAny = false;
        for (const fileId of Object.keys(document.entries)) {
          if (!existingFileIds.has(fileId)) {
            delete document.entries[fileId];
            removedAny = true;
          }
        }
        return removedAny;
      }, "remove metadata for missing files");
    });
  }

  async queryFiles(files: FileRecord[], filters?: FileFilters): Promise<FileWithMetadata[]> {
    const metadata = await this.load();
    const candidateFileIds = this.resolveCandidateFileIds(metadata, filters);
    const results: FileWithMetadata[] = files.map((file) => {
      const entry = metadata.entries[file.id];
      return entry ? { ...file, metadata: entry } : { ...file };
    });

    if (!filters) {
      return results;
    }

    return results.filter((file) => {
      if (candidateFileIds && !candidateFileIds.has(file.id)) {
        return false;
      }

      return this.matchesFilters(file, filters);
    });
  }

  private resolveCandidateFileIds(
    metadata: MetadataDocument,
    filters?: FileFilters
  ): Set<string> | undefined {
    if (!filters) {
      return undefined;
    }

    const candidates: Array<Set<string>> = [];
    if (filters.tag) {
      candidates.push(new Set(metadata.indexes.tags[filters.tag] ?? []));
    }

    if (filters.category) {
      candidates.push(new Set(metadata.indexes.categories[filters.category] ?? []));
    }

    const metadataCategory = filters.metadata?.["category"];
    if (typeof metadataCategory === "string") {
      candidates.push(new Set(metadata.indexes.categories[metadataCategory] ?? []));
    }

    if (candidates.length === 0) {
      return undefined;
    }

    let intersection = candidates[0] ?? new Set<string>();
    for (let index = 1; index < candidates.length; index += 1) {
      const next = candidates[index];
      if (!next) {
        continue;
      }
      intersection = new Set([...intersection].filter((fileId) => next.has(fileId)));
    }

    return intersection;
  }

  private matchesFilters(file: FileWithMetadata, filters: FileFilters): boolean {
    const metadata = file.metadata;

    if (filters.type) {
      const typeMatches = (file.mimeType ?? "").toLowerCase().includes(filters.type.toLowerCase());
      if (!typeMatches) {
        return false;
      }
    }

    if (filters.tag) {
      const tags = metadata?.tags ?? [];
      if (!tags.includes(filters.tag)) {
        return false;
      }
    }

    if (filters.category) {
      if (metadata?.category !== filters.category) {
        return false;
      }
    }

    if (filters.fromDate) {
      const modifiedAt = file.modifiedAt ? Date.parse(file.modifiedAt) : NaN;
      const from = Date.parse(filters.fromDate);
      if (!Number.isNaN(from) && (Number.isNaN(modifiedAt) || modifiedAt < from)) {
        return false;
      }
    }

    if (filters.toDate) {
      const modifiedAt = file.modifiedAt ? Date.parse(file.modifiedAt) : NaN;
      const to = Date.parse(filters.toDate);
      if (!Number.isNaN(to) && (Number.isNaN(modifiedAt) || modifiedAt > to)) {
        return false;
      }
    }

    if (filters.metadata) {
      for (const [key, expectedValue] of Object.entries(filters.metadata)) {
        if (!metadata || metadata[key] !== expectedValue) {
          return false;
        }
      }
    }

    return true;
  }

  private rebuildIndexes(entries: Record<string, FileMetadataEntry>): MetadataDocument["indexes"] {
    const tags: Record<string, string[]> = {};
    const categories: Record<string, string[]> = {};

    for (const [fileId, entry] of Object.entries(entries)) {
      const entryTags = entry.tags ?? [];
      for (const tag of entryTags) {
        if (!tags[tag]) {
          tags[tag] = [];
        }
        tags[tag].push(fileId);
      }

      if (entry.category) {
        const existing = categories[entry.category] ?? [];
        existing.push(fileId);
        categories[entry.category] = existing;
      }
    }

    return { tags, categories };
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release!();
    }
  }

  private async commitWithConflictHandling(
    mutate: (document: MetadataDocument) => boolean | void,
    operationLabel: string
  ): Promise<void> {
    const attempts = Math.max(1, this.writeConflict.maxRetries + 1);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const base = await this.load(true);
      const baseRevision = base.revision ?? 0;
      const baseUpdatedAt = base.updatedAt;
      const draft = this.cloneDocument(base);

      const changed = mutate(draft) !== false;
      if (!changed) {
        return;
      }

      draft.updatedAt = new Date().toISOString();
      draft.revision = baseRevision + 1;
      draft.indexes = this.rebuildIndexes(draft.entries);

      const latest = await this.load(true);
      const latestRevision = latest.revision ?? 0;
      const conflict = latestRevision !== baseRevision || latest.updatedAt !== baseUpdatedAt;
      if (conflict) {
        this.telemetry?.onEvent?.({
          type: "conflict",
          source: "metadata.commit",
          message: `Conflict while ${operationLabel}. revision ${baseRevision} -> ${latestRevision}.`,
          timestamp: new Date().toISOString(),
        });

        if (this.writeConflict.policy === "fail-fast") {
          throw new WriteConflictError(
            `Write conflict detected while attempting to ${operationLabel}. Current revision changed from ${baseRevision} to ${latestRevision}.`
          );
        }

        if (attempt >= attempts) {
          throw new WriteConflictError(
            `Write conflict could not be resolved after ${attempts} attempts while attempting to ${operationLabel}.`
          );
        }

        await sleep(this.writeConflict.backoffMs * attempt);
        this.telemetry?.onEvent?.({
          type: "retry",
          source: "metadata.commit",
          attempt,
          message: `Retrying ${operationLabel} after conflict.`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      await this.save(draft);

      const confirmed = await this.load(true);
      const confirmedRevision = confirmed.revision ?? 0;
      if (confirmedRevision !== draft.revision) {
        this.telemetry?.onEvent?.({
          type: "conflict",
          source: "metadata.postSaveCheck",
          message: `Post-save revision mismatch while ${operationLabel}. expected ${draft.revision}, got ${confirmedRevision}.`,
          timestamp: new Date().toISOString(),
        });

        if (this.writeConflict.policy === "fail-fast" || attempt >= attempts) {
          throw new WriteConflictError(
            `Write conflict detected after save while attempting to ${operationLabel}. Expected revision ${draft.revision}, got ${confirmedRevision}.`
          );
        }

        await sleep(this.writeConflict.backoffMs * attempt);
        this.telemetry?.onEvent?.({
          type: "retry",
          source: "metadata.postSaveCheck",
          attempt,
          message: `Retrying ${operationLabel} after post-save revision mismatch.`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      return;
    }
  }

  private cloneDocument(document: MetadataDocument): MetadataDocument {
    return JSON.parse(JSON.stringify(document)) as MetadataDocument;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
