import "isomorphic-fetch";
import { Client } from "@microsoft/microsoft-graph-client";
import { AuthenticationError, ProviderError } from "./errors";
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
      const response = await client
        .api(`/me/drive/items/${encodeURIComponent(folderId)}/children`)
        .query({ "$select": "id,name,file,folder,size,createdDateTime,lastModifiedDateTime,webUrl" })
        .get();

      const items = (response.value ?? []) as GraphItem[];
      return items
        .filter((item) => item.file && item.name !== "metadata.json")
        .map((item) => toFileRecord(item));
    } catch (error) {
      throw new ProviderError(`OneDrive listFiles failed: ${(error as Error).message}`);
    }
  }

  async getFileContent(folderId: string, name: string): Promise<string | null> {
    try {
      const file = await this.findFileByName(folderId, name);
      if (!file?.id) {
        return null;
      }

      const response = await this.graphFetch(`/me/drive/items/${encodeURIComponent(file.id)}/content`);
      return await response.text();
    } catch (error) {
      throw new ProviderError(`OneDrive getFileContent failed: ${(error as Error).message}`);
    }
  }

  async upsertFile(folderId: string, name: string, content: string, mimeType = "application/json"): Promise<FileRecord> {
    try {
      const response = await this.graphFetch(
        `/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:/content`,
        {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
          },
          body: content,
        }
      );

      const file = (await response.json()) as GraphItem;
      return toFileRecord(file, name);
    } catch (error) {
      throw new ProviderError(`OneDrive upsertFile failed: ${(error as Error).message}`);
    }
  }

  async getInitialSyncToken(folderId: string): Promise<string | undefined> {
    try {
      const delta = await this.getAllDeltaPages(`/me/drive/items/${encodeURIComponent(folderId)}/delta`);
      return delta.syncToken;
    } catch (error) {
      throw new ProviderError(`OneDrive getInitialSyncToken failed: ${(error as Error).message}`);
    }
  }

  async getIncrementalChanges(folderId: string, syncToken?: string): Promise<{ events: ChangeEvent[]; syncToken?: string }> {
    try {
      const start = syncToken ?? `/me/drive/items/${encodeURIComponent(folderId)}/delta`;
      const delta = await this.getAllDeltaPages(start);

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

      return {
        events,
        syncToken: delta.syncToken ?? syncToken,
      };
    } catch (error) {
      throw new ProviderError(`OneDrive getIncrementalChanges failed: ${(error as Error).message}`);
    }
  }

  private async findFileByName(folderId: string, fileName: string): Promise<GraphItem | undefined> {
    const files = await this.listFilesAndMetadata(folderId);
    return files.find((file) => file.name === fileName);
  }

  private async listFilesAndMetadata(folderId: string): Promise<GraphItem[]> {
    const client = this.getClient();
    const response = await client
      .api(`/me/drive/items/${encodeURIComponent(folderId)}/children`)
      .query({ "$select": "id,name,file,folder,size,createdDateTime,lastModifiedDateTime,webUrl,parentReference" })
      .get();

    return (response.value ?? []) as GraphItem[];
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
      throw new ProviderError(`Graph request failed (${response.status}): ${errorText}`);
    }

    return response;
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

    return {
      items: allItems,
      syncToken: finalDeltaLink,
    };
  }
}
