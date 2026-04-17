import { InMemoryCache, SQLiteCache } from "./cache";
import { ConfigurationError, FileBaseDBError } from "./errors";
import { GoogleDriveProvider } from "./google";
import { MetadataManager } from "./metadata";
import { OneDriveProvider } from "./onedrive";
import {
  CacheStore,
  ChangeEvent,
  FileBaseDBOptions,
  FileFilters,
  FileMetadataEntry,
  FileRecord,
  FileWithMetadata,
  FolderChangeCallback,
  ProviderAdapter,
  ProviderCredentials,
  ProviderName,
  Unsubscribe,
} from "./types";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_POLLING_INTERVAL_MS = 20_000;

export class FileBaseDB {
  private readonly providerName: ProviderName;
  private readonly provider: ProviderAdapter;
  private readonly cache: CacheStore;
  private readonly cacheTtlMs: number;
  private readonly pollingIntervalMs: number;

  private folderId?: string;
  private metadataManager?: MetadataManager;
  private syncToken?: string;
  private subscriptionTimers = new Set<NodeJS.Timeout>();

  private constructor(providerName: ProviderName, provider: ProviderAdapter, options?: FileBaseDBOptions) {
    this.providerName = providerName;
    this.provider = provider;
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    this.cache = options?.useSQLiteCache ? new SQLiteCache(options?.sqliteDbPath) : new InMemoryCache();
  }

  /**
   * Authenticate and create a FileBaseDB session for a cloud provider.
   */
  static async connect(
    providerName: ProviderName,
    credentials: ProviderCredentials,
    options?: FileBaseDBOptions
  ): Promise<FileBaseDB> {
    const provider = createProvider(providerName);
    await provider.initialize(credentials);
    return new FileBaseDB(providerName, provider, options);
  }

  async useFolder(folderRef: string): Promise<this> {
    const resolvedFolderId = this.provider.resolveFolderId(folderRef);
    if (!resolvedFolderId) {
      throw new ConfigurationError("useFolder failed: folder ID/link is invalid or empty.");
    }

    this.folderId = resolvedFolderId;
    this.metadataManager = new MetadataManager(this.provider, resolvedFolderId, this.cache, this.cacheTtlMs);
    this.syncToken = await this.provider.getInitialSyncToken(resolvedFolderId);
    return this;
  }

  async getFiles(filters?: FileFilters): Promise<FileWithMetadata[]> {
    const folderId = this.requireFolderId();
    const metadata = this.requireMetadataManager();

    const cacheKey = this.filesCacheKey(folderId);
    const cached = this.cache.get<FileRecord[]>(cacheKey);
    const files = cached ?? (await this.provider.listFiles(folderId));

    if (!cached) {
      this.cache.set(cacheKey, files, this.cacheTtlMs);
    }

    await metadata.removeMetadataForMissingFiles(files);
    return metadata.queryFiles(files, filters);
  }

  async addMetadata(fileId: string, metadataObject: Record<string, unknown>): Promise<FileMetadataEntry> {
    if (!fileId.trim()) {
      throw new ConfigurationError("addMetadata failed: fileId is required.");
    }

    const metadata = this.requireMetadataManager();
    const entry = await metadata.addOrUpdateMetadata(fileId, metadataObject);
    this.invalidateFilesCache();
    return entry;
  }

  /**
   * Explicit alias for metadata updates. Existing keys are merged by fileId.
   */
  async updateMetadata(fileId: string, metadataObject: Record<string, unknown>): Promise<FileMetadataEntry> {
    return this.addMetadata(fileId, metadataObject);
  }

  async removeMetadata(fileId: string): Promise<boolean> {
    const metadata = this.requireMetadataManager();
    const removed = await metadata.removeMetadata(fileId);
    this.invalidateFilesCache();
    return removed;
  }

  subscribe(folderRef: string, callback: FolderChangeCallback): Unsubscribe {
    const targetFolderId = this.provider.resolveFolderId(folderRef);
    if (!targetFolderId) {
      throw new ConfigurationError("subscribe failed: folderId/link is invalid.");
    }

    if (!this.folderId || this.folderId !== targetFolderId) {
      throw new ConfigurationError(
        "subscribe failed: folder is not active. Call useFolder(folderId) with the same folder before subscribing."
      );
    }

    const timer = setInterval(async () => {
      try {
        const { events, syncToken } = await this.provider.getIncrementalChanges(targetFolderId, this.syncToken);
        if (syncToken) {
          this.syncToken = syncToken;
        }

        if (events.length > 0) {
          await this.reconcileMetadata(events);
          this.invalidateFilesCache();
          await callback(events);
        }
      } catch (error) {
        const wrapped = new FileBaseDBError(
          `Subscription polling failed for ${this.providerName}/${targetFolderId}: ${(error as Error).message}`,
          "SUBSCRIPTION_ERROR"
        );
        await callback([
          {
            type: "updated",
            file: { id: "subscription-error", name: wrapped.message },
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    }, this.pollingIntervalMs);

    this.subscriptionTimers.add(timer);

    return () => {
      clearInterval(timer);
      this.subscriptionTimers.delete(timer);
    };
  }

  disconnect(): void {
    for (const timer of this.subscriptionTimers) {
      clearInterval(timer);
    }
    this.subscriptionTimers.clear();
    this.cache.clear();
  }

  private async reconcileMetadata(events: ChangeEvent[]): Promise<void> {
    const metadata = this.requireMetadataManager();
    const removed = events.filter((event) => event.type === "removed").map((event) => event.file.id);
    for (const fileId of removed) {
      await metadata.removeMetadata(fileId);
    }
  }

  private requireFolderId(): string {
    if (!this.folderId) {
      throw new ConfigurationError("No folder selected. Call useFolder(folderId) before querying files.");
    }

    return this.folderId;
  }

  private requireMetadataManager(): MetadataManager {
    if (!this.metadataManager) {
      throw new ConfigurationError("Metadata manager is not initialized. Call useFolder(folderId) first.");
    }

    return this.metadataManager;
  }

  private filesCacheKey(folderId: string): string {
    return `files:${this.providerName}:${folderId}`;
  }

  private invalidateFilesCache(): void {
    if (!this.folderId) {
      return;
    }

    this.cache.delete(this.filesCacheKey(this.folderId));
  }
}

function createProvider(provider: ProviderName): ProviderAdapter {
  if (provider === "google") {
    return new GoogleDriveProvider();
  }

  if (provider === "onedrive") {
    return new OneDriveProvider();
  }

  throw new ConfigurationError(`Unsupported provider: ${provider}`);
}

export async function connect(
  provider: ProviderName,
  credentials: ProviderCredentials,
  options?: FileBaseDBOptions
): Promise<FileBaseDB> {
  return FileBaseDB.connect(provider, credentials, options);
}

export * from "./types";
export * from "./errors";
