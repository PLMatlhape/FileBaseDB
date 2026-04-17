import { MetadataError } from "./errors";
import {
  CacheStore,
  FileFilters,
  FileMetadataEntry,
  FileRecord,
  FileWithMetadata,
  MetadataDocument,
  ProviderAdapter,
} from "./types";

const METADATA_FILE_NAME = "metadata.json";

function createEmptyMetadataDocument(): MetadataDocument {
  return {
    version: 1,
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

  constructor(provider: ProviderAdapter, folderId: string, cache: CacheStore, cacheTtlMs: number) {
    this.provider = provider;
    this.folderId = folderId;
    this.cache = cache;
    this.cacheTtlMs = cacheTtlMs;
  }

  private get cacheKey(): string {
    return `metadata:${this.folderId}`;
  }

  async load(forceRefresh = false): Promise<MetadataDocument> {
    if (!forceRefresh) {
      const cached = this.cache.get<MetadataDocument>(this.cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const content = await this.provider.getFileContent(this.folderId, METADATA_FILE_NAME);
      if (!content) {
        const empty = createEmptyMetadataDocument();
        this.cache.set(this.cacheKey, empty, this.cacheTtlMs);
        return empty;
      }

      const parsed = JSON.parse(content) as MetadataDocument;
      if (!parsed.entries || !parsed.indexes) {
        throw new MetadataError("Invalid metadata.json format. Expected entries and indexes.");
      }

      parsed.indexes = this.rebuildIndexes(parsed.entries);
      this.cache.set(this.cacheKey, parsed, this.cacheTtlMs);
      return parsed;
    } catch (error) {
      if (error instanceof MetadataError) {
        throw error;
      }
      throw new MetadataError(`Failed to load metadata.json: ${(error as Error).message}`);
    }
  }

  async save(document: MetadataDocument): Promise<void> {
    const payload = JSON.stringify(document, null, 2);
    try {
      await this.provider.upsertFile(this.folderId, METADATA_FILE_NAME, payload, "application/json");
      this.cache.set(this.cacheKey, document, this.cacheTtlMs);
    } catch (error) {
      throw new MetadataError(`Failed to save metadata.json: ${(error as Error).message}`);
    }
  }

  async addOrUpdateMetadata(fileId: string, metadataObject: Record<string, unknown>): Promise<FileMetadataEntry> {
    const document = await this.load();
    const previous = document.entries[fileId];

    const entry: FileMetadataEntry = {
      fileId,
      updatedAt: new Date().toISOString(),
      ...(previous ?? {}),
      ...metadataObject,
    };

    document.entries[fileId] = entry;
    document.updatedAt = new Date().toISOString();
    document.indexes = this.rebuildIndexes(document.entries);

    await this.save(document);
    return entry;
  }

  async removeMetadata(fileId: string): Promise<boolean> {
    const document = await this.load();
    if (!document.entries[fileId]) {
      return false;
    }

    delete document.entries[fileId];
    document.updatedAt = new Date().toISOString();
    document.indexes = this.rebuildIndexes(document.entries);
    await this.save(document);
    return true;
  }

  async removeMetadataForMissingFiles(existingFiles: FileRecord[]): Promise<void> {
    const document = await this.load();
    const existingFileIds = new Set(existingFiles.map((file) => file.id));

    let removedAny = false;
    for (const fileId of Object.keys(document.entries)) {
      if (!existingFileIds.has(fileId)) {
        delete document.entries[fileId];
        removedAny = true;
      }
    }

    if (removedAny) {
      document.updatedAt = new Date().toISOString();
      document.indexes = this.rebuildIndexes(document.entries);
      await this.save(document);
    }
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
}
