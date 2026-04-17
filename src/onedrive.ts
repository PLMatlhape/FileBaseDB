import "isomorphic-fetch";
import { Client } from "@microsoft/microsoft-graph-client";
import { AuthenticationError, ProviderError } from "./errors";
import { isTransientProviderError, RetryOptions, runWithRetry, withRetryDefaults } from "./retry";
import { safeErrorMessage, redactSecrets } from "./security";
import { ChangeEvent, OneDriveOAuthCredentials, ProviderAdapter, ProviderCredentials, FileRecord } from "./types";

type GraphItem = {
  id?: string;
  name?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  parentReference?: { id?: string };
  deleted?: unknown;
};

type GraphDeltaResponse = {
  value?: GraphItem[];
  "@odata.deltaLink"?: string;
  "@odata.nextLink"?: string;
};

function toFileRecord(item: GraphItem, fallbackName = ""): FileRecord {
  const record: FileRecord = {
    id: item.id ?? "",
    name: item.name ?? fallbackName,
  };

  if (item.file?.mimeType) record.mimeType = item.file.mimeType;
  if (item.createdDateTime) record.createdAt = item.createdDateTime;
  if (item.lastModifiedDateTime) record.modifiedAt = item.lastModifiedDateTime;
  if (typeof item.size === "number") record.size = item.size;
  if (item.webUrl) record.webUrl = item.webUrl;

  return record;
}

export class OneDriveProvider implements ProviderAdapter {
  private graphClient?: Client;
  private accessToken?: string;
  private readonly retryOptions: RetryOptions;

  constructor(retryOptions?: Partial<RetryOptions>) {
    this.retryOptions = withRetryDefaults(retryOptions);
  }

  async initialize(credentials: ProviderCredentials): Promise<void> {
    const oneDriveCredentials = credentials as OneDriveOAuthCredentials;
    if (!oneDriveCredentials.accessToken) {
      throw new AuthenticationError("OneDrive credentials must include accessToken for OAuth 2.0 authentication.");
    }

    this.accessToken = oneDriveCredentials.accessToken;
    this.graphClient = Client.init({
      authProvider: (done) => {
        done(null, oneDriveCredentials.accessToken);
      },
    });
  }

  resolveFolderId(folderRef: string): string {
    const trimmed = folderRef.trim();

    const itemMatch = trimmed.match(/\/items\/([^/?]+)/);
    if (itemMatch?.[1]) {
      return decodeURIComponent(itemMatch[1]);
    }

    const idParamMatch = trimmed.match(/[?&](?:id|resid)=([^&]+)/i);
    if (idParamMatch?.[1]) {
      return decodeURIComponent(idParamMatch[1]);
    }

    return trimmed;
  }

  async listFiles(folderId: string): Promise<FileRecord[]> {
    const client = this.getClient();

    try {
      const response = await this.withProviderRetry(() =>
        client
          .api(`/me/drive/items/${encodeURIComponent(folderId)}/children`)
          .query({ "$select": "id,name,file,folder,size,createdDateTime,lastModifiedDateTime,webUrl" })
          .get()
      );

      const items = (response.value ?? []) as GraphItem[];
      return items
        .filter((item) => item.file && item.name !== "metadata.json")
        .map((item) => toFileRecord(item));
    } catch (error) {
      throw new ProviderError(`OneDrive listFiles failed: ${safeErrorMessage(error, "Unexpected Microsoft Graph API error.")}`);
    }
  }

  async getFileContent(folderId: string, name: string): Promise<string | null> {
    try {
      const { directoryPath, fileName } = this.splitPath(name);
      const targetFolderId = await this.resolveDirectoryFolderId(folderId, directoryPath, false);
      if (!targetFolderId) {
        return null;
      }

      const file = await this.findFileByName(targetFolderId, fileName);
      if (!file?.id) {
        return null;
      }
      const fileId = file.id;

      const response = await this.withProviderRetry(() =>
        this.graphFetch(`/me/drive/items/${encodeURIComponent(fileId)}/content`)
      );
      return await response.text();
    } catch (error) {
      throw new ProviderError(`OneDrive getFileContent failed: ${safeErrorMessage(error, "Unexpected Microsoft Graph API error.")}`);
    }
  }

  async upsertFile(folderId: string, name: string, content: string | Buffer, mimeType = "application/json"): Promise<FileRecord> {
    try {
      const { directoryPath, fileName } = this.splitPath(name);
      const targetFolderId = await this.resolveDirectoryFolderId(folderId, directoryPath, true);

      const response = await this.withProviderRetry(() =>
        this.graphFetch(
          `/me/drive/items/${encodeURIComponent(targetFolderId)}:/${encodeURIComponent(fileName)}:/content`,
          {
            method: "PUT",
            headers: {
              "Content-Type": mimeType,
            },
            body: content,
          }
        )
      );

      const file = (await response.json()) as GraphItem;
      return toFileRecord(file, fileName);
    } catch (error) {
      throw new ProviderError(`OneDrive upsertFile failed: ${safeErrorMessage(error, "Unexpected Microsoft Graph API error.")}`);
    }
  }

  async getInitialSyncToken(folderId: string): Promise<string | undefined> {
    try {
      const delta = await this.withProviderRetry(() =>
        this.getAllDeltaPages(`/me/drive/items/${encodeURIComponent(folderId)}/delta`)
      );
      return delta.syncToken;
    } catch (error) {
      throw new ProviderError(`OneDrive getInitialSyncToken failed: ${safeErrorMessage(error, "Unexpected Microsoft Graph API error.")}`);
    }
  }

  async getIncrementalChanges(folderId: string, syncToken?: string): Promise<{ events: ChangeEvent[]; syncToken?: string }> {
    try {
      const start = syncToken ?? `/me/drive/items/${encodeURIComponent(folderId)}/delta`;
      const delta = await this.withProviderRetry(() => this.getAllDeltaPages(start));

      const events: ChangeEvent[] = [];
      for (const item of delta.items) {
        if (!item.id || item.name === "metadata.json") {
          continue;
        }

        const parentMatches = !item.parentReference?.id || item.parentReference.id === folderId;
        if (!parentMatches) {
          continue;
        }

        if (item.deleted) {
          events.push({
            type: "removed",
            file: { id: item.id },
            timestamp: new Date().toISOString(),
          });
        } else if (item.file) {
          const record = toFileRecord(item);
          events.push({
            type: "updated",
            file: record,
            timestamp: new Date().toISOString(),
          });
        }
      }

      const nextSyncToken = delta.syncToken ?? syncToken;
      if (nextSyncToken) {
        return { events, syncToken: nextSyncToken };
      } else {
        return { events };
      }
    } catch (error) {
      throw new ProviderError(`OneDrive getIncrementalChanges failed: ${safeErrorMessage(error, "Unexpected Microsoft Graph API error.")}`);
    }
  }

  private async findFileByName(folderId: string, fileName: string): Promise<GraphItem | undefined> {
    const files = await this.listFilesAndMetadata(folderId);
    return files.find((file) => file.name === fileName);
  }

  private async listFilesAndMetadata(folderId: string): Promise<GraphItem[]> {
    const client = this.getClient();
    const response = await this.withProviderRetry(() =>
      client
        .api(`/me/drive/items/${encodeURIComponent(folderId)}/children`)
        .query({ "$select": "id,name,file,folder,size,createdDateTime,lastModifiedDateTime,webUrl,parentReference" })
        .get()
    );

    return (response.value ?? []) as GraphItem[];
  }

  private splitPath(pathOrName: string): { directoryPath: string; fileName: string } {
    const normalized = pathOrName.replace(/\\/g, "/").trim();
    const cleaned = normalized.replace(/^\/+|\/+$/g, "");
    if (!cleaned) {
      throw new ProviderError("File path is empty.");
    }

    const parts = cleaned.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
      throw new ProviderError("File path must include a file name.");
    }

    return {
      directoryPath: parts.join("/"),
      fileName,
    };
  }

  private async resolveDirectoryFolderId(
    rootFolderId: string,
    directoryPath: string,
    createIfMissing: boolean
  ): Promise<string | undefined> {
    if (!directoryPath) {
      return rootFolderId;
    }

    const segments = directoryPath.split("/").filter(Boolean);
    let currentFolderId = rootFolderId;

    for (const segment of segments) {
      const existing = await this.findChildFolderByName(currentFolderId, segment);
      if (existing?.id) {
        currentFolderId = existing.id;
        continue;
      }

      if (!createIfMissing) {
        return undefined;
      }

      currentFolderId = await this.createFolder(currentFolderId, segment);
    }

    return currentFolderId;
  }

  private async findChildFolderByName(parentFolderId: string, folderName: string): Promise<GraphItem | undefined> {
    const items = await this.listFilesAndMetadata(parentFolderId);
    return items.find((item) => item.name === folderName && Boolean(item.folder));
  }

  private async createFolder(parentFolderId: string, folderName: string): Promise<string> {
    const response = await this.withProviderRetry(() =>
      this.graphFetch(`/me/drive/items/${encodeURIComponent(parentFolderId)}/children`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: folderName,
          folder: {},
          "@microsoft.graph.conflictBehavior": "rename",
        }),
      })
    );

    const item = (await response.json()) as GraphItem;
    if (!item.id) {
      throw new ProviderError(`OneDrive create folder failed for '${folderName}'.`);
    }

    return item.id;
  }

  private getClient(): Client {
    if (!this.graphClient) {
      throw new ProviderError("OneDrive provider is not initialized. Call connect('onedrive', credentials) first.");
    }

    return this.graphClient;
  }

  private async graphFetch(pathOrUrl: string, init?: RequestInit): Promise<Response> {
    if (!this.accessToken) {
      throw new ProviderError("OneDrive access token is missing. Provider is not initialized.");
    }

    const isAbsolute = /^https?:\/\//i.test(pathOrUrl);
    const url = isAbsolute ? pathOrUrl : `https://graph.microsoft.com/v1.0${pathOrUrl}`;

    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderError(`Graph request failed (${response.status}): ${redactSecrets(errorText)}`);
    }

    return response;
  }

  private async withProviderRetry<T>(task: () => Promise<T>): Promise<T> {
    return runWithRetry(task, this.retryOptions, isTransientProviderError);
  }

  private async getAllDeltaPages(startPathOrUrl: string): Promise<{ items: GraphItem[]; syncToken?: string }> {
    const allItems: GraphItem[] = [];
    let current: string | undefined = startPathOrUrl;
    let finalDeltaLink: string | undefined;
    let safetyCounter = 0;

    while (current && safetyCounter < 50) {
      safetyCounter += 1;
      const response = await this.graphFetch(current);
      const body = (await response.json()) as GraphDeltaResponse;

      allItems.push(...(body.value ?? []));
      if (body["@odata.deltaLink"]) {
        finalDeltaLink = body["@odata.deltaLink"];
      }

      current = body["@odata.nextLink"];
    }

    if (finalDeltaLink) {
      return { items: allItems, syncToken: finalDeltaLink };
    } else {
      return { items: allItems };
    }
  }
}
