import { drive_v3, google } from "googleapis";
import { AuthenticationError, ProviderError } from "./errors";
import { ChangeEvent, GoogleOAuthCredentials, ProviderAdapter, ProviderCredentials, FileRecord } from "./types";

function toFileRecord(file: drive_v3.Schema$File, fallbackName = ""): FileRecord {
  const record: FileRecord = {
    id: file.id ?? "",
    name: file.name ?? fallbackName,
  };

  if (file.mimeType) record.mimeType = file.mimeType;
  if (file.createdTime) record.createdAt = file.createdTime;
  if (file.modifiedTime) record.modifiedAt = file.modifiedTime;
  if (file.size) record.size = Number(file.size);
  if (file.webViewLink) record.webUrl = file.webViewLink;

  return record;
}

export class GoogleDriveProvider implements ProviderAdapter {
  private driveClient?: drive_v3.Drive;

  async initialize(credentials: ProviderCredentials): Promise<void> {
    const googleCredentials = credentials as GoogleOAuthCredentials;
    const hasToken = Boolean(googleCredentials.accessToken || googleCredentials.refreshToken);

    if (!hasToken) {
      throw new AuthenticationError(
        "Google credentials must include at least accessToken or refreshToken for OAuth 2.0 authentication."
      );
    }

    const auth = new google.auth.OAuth2(
      googleCredentials.clientId,
      googleCredentials.clientSecret,
      googleCredentials.redirectUri
    );

    const oauthCredentials: { access_token?: string; refresh_token?: string | null } = {};
    if (googleCredentials.accessToken) {
      oauthCredentials.access_token = googleCredentials.accessToken;
    }
    if (googleCredentials.refreshToken) {
      oauthCredentials.refresh_token = googleCredentials.refreshToken;
    }
    auth.setCredentials(oauthCredentials);

    this.driveClient = google.drive({ version: "v3", auth });
  }

  resolveFolderId(folderRef: string): string {
    const trimmed = folderRef.trim();

    const foldersMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (foldersMatch?.[1]) {
      return foldersMatch[1];
    }

    const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParamMatch?.[1]) {
      return idParamMatch[1];
    }

    return trimmed;
  }

  async listFiles(folderId: string): Promise<FileRecord[]> {
    const client = this.getClient();
    try {
      const response = await client.files.list({
        q: `'${folderId}' in parents and trashed=false and name!='metadata.json'`,
        fields: "files(id,name,mimeType,createdTime,modifiedTime,size,webViewLink)",
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      return (response.data.files ?? []).map((file) => toFileRecord(file));
    } catch (error) {
      throw new ProviderError(`Google listFiles failed: ${(error as Error).message}`);
    }
  }

  async getFileContent(folderId: string, name: string): Promise<string | null> {
    const client = this.getClient();

    try {
      const metadataFileId = await this.findFileIdByName(folderId, name);
      if (!metadataFileId) {
        return null;
      }

      const response = await client.files.get(
        {
          fileId: metadataFileId,
          alt: "media",
          supportsAllDrives: true,
        },
        {
          responseType: "text",
        }
      );

      return String(response.data ?? "");
    } catch (error) {
      throw new ProviderError(`Google getFileContent failed: ${(error as Error).message}`);
    }
  }

  async upsertFile(folderId: string, name: string, content: string, mimeType = "application/json"): Promise<FileRecord> {
    const client = this.getClient();

    try {
      const existingFileId = await this.findFileIdByName(folderId, name);
      let response;

      if (existingFileId) {
        response = await client.files.update({
          fileId: existingFileId,
          media: {
            mimeType,
            body: content,
          },
          fields: "id,name,mimeType,createdTime,modifiedTime,size,webViewLink",
          supportsAllDrives: true,
        });
      } else {
        response = await client.files.create({
          requestBody: {
            name,
            parents: [folderId],
            mimeType,
          },
          media: {
            mimeType,
            body: content,
          },
          fields: "id,name,mimeType,createdTime,modifiedTime,size,webViewLink",
          supportsAllDrives: true,
        });
      }

      const file = response.data;
      return toFileRecord(file, name);
    } catch (error) {
      throw new ProviderError(`Google upsertFile failed: ${(error as Error).message}`);
    }
  }

  async getInitialSyncToken(_folderId: string): Promise<string | undefined> {
    const client = this.getClient();
    try {
      const response = await client.changes.getStartPageToken({ supportsAllDrives: true });
      return response.data.startPageToken ?? undefined;
    } catch (error) {
      throw new ProviderError(`Google getInitialSyncToken failed: ${(error as Error).message}`);
    }
  }

  async getIncrementalChanges(folderId: string, syncToken?: string): Promise<{ events: ChangeEvent[]; syncToken?: string }> {
    const client = this.getClient();
    const events: ChangeEvent[] = [];

    try {
      let pageToken = syncToken ?? (await this.getInitialSyncToken(folderId));
      if (!pageToken) {
        return { events: [] };
      }

      let newSyncToken: string | undefined;

      while (pageToken) {
        const listResult = await client.changes.list({
          pageToken,
          spaces: "drive",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,createdTime,modifiedTime,size,webViewLink,parents))",
        });
        const changeList: drive_v3.Schema$ChangeList = listResult.data;

        const changes = changeList.changes ?? [];
        for (const change of changes) {
          const file = change.file;
          const inTargetFolder = file?.parents?.includes(folderId) ?? false;
          if (!inTargetFolder && !change.removed) {
            continue;
          }

          if (change.removed) {
            if (!change.fileId) {
              continue;
            }
            events.push({
              type: "removed",
              file: { id: change.fileId },
              timestamp: new Date().toISOString(),
            });
          } else if (file?.id && file.name !== "metadata.json") {
            const record = toFileRecord(file);
            events.push({
              type: "updated",
              file: record,
              timestamp: new Date().toISOString(),
            });
          }
        }

        const nextPageToken: string | undefined = changeList.nextPageToken ?? undefined;
        newSyncToken = changeList.newStartPageToken ?? newSyncToken;
        pageToken = nextPageToken;
      }

      if (newSyncToken) {
        return { events, syncToken: newSyncToken };
      }

      if (syncToken) {
        return { events, syncToken };
      }

      return { events };
    } catch (error) {
      throw new ProviderError(`Google getIncrementalChanges failed: ${(error as Error).message}`);
    }
  }

  private getClient(): drive_v3.Drive {
    if (!this.driveClient) {
      throw new ProviderError("Google provider is not initialized. Call connect('google', credentials) first.");
    }
    return this.driveClient;
  }

  private async findFileIdByName(folderId: string, fileName: string): Promise<string | undefined> {
    const client = this.getClient();
    const response = await client.files.list({
      q: `'${folderId}' in parents and trashed=false and name='${fileName.replace(/'/g, "\\'")}'`,
      fields: "files(id,name)",
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return response.data.files?.[0]?.id ?? undefined;
  }
}
