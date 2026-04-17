export type ProviderName = "google" | "onedrive";

export interface GoogleOAuthCredentials {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface OneDriveOAuthCredentials {
  accessToken: string;
}

export type ProviderCredentials = GoogleOAuthCredentials | OneDriveOAuthCredentials;

export interface FileRecord {
  id: string;
  name: string;
  mimeType?: string;
  createdAt?: string;
  modifiedAt?: string;
  size?: number;
  webUrl?: string;
}

export interface FileFilters {
  tag?: string;
  category?: string;
  type?: string;
  fromDate?: string;
  toDate?: string;
  metadata?: Record<string, unknown>;
}

export interface FileMetadataEntry {
  fileId: string;
  tags?: string[];
  category?: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface MetadataDocument {
  version: number;
  updatedAt: string;
  entries: Record<string, FileMetadataEntry>;
  indexes: {
    tags: Record<string, string[]>;
    categories: Record<string, string[]>;
  };
}

export interface FileWithMetadata extends FileRecord {
  metadata?: FileMetadataEntry;
}

export type ChangeType = "added" | "updated" | "removed";

export interface ChangeEvent {
  type: ChangeType;
  file: Partial<FileRecord> & { id: string };
  timestamp: string;
}

export type FolderChangeCallback = (events: ChangeEvent[]) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface ProviderAdapter {
  initialize(credentials: ProviderCredentials): Promise<void>;
  resolveFolderId(folderRef: string): string;
  listFiles(folderId: string): Promise<FileRecord[]>;
  getFileContent(folderId: string, name: string): Promise<string | null>;
  upsertFile(folderId: string, name: string, content: string, mimeType?: string): Promise<FileRecord>;
  getInitialSyncToken(folderId: string): Promise<string | undefined>;
  getIncrementalChanges(folderId: string, syncToken?: string): Promise<{ events: ChangeEvent[]; syncToken?: string }>;
}

export interface CacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
}

export interface FileBaseDBOptions {
  cacheTtlMs?: number;
  pollingIntervalMs?: number;
  useSQLiteCache?: boolean;
  sqliteDbPath?: string;
}
