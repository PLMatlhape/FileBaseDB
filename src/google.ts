import { drive_v3, google } from "googleapis";
import { Readable } from "node:stream";
import { AuthenticationError, ProviderError } from "./errors";
import { isTransientProviderError, RetryOptions, runWithRetry, withRetryDefaults } from "./retry";
import { safeErrorMessage } from "./security";
import { ChangeEvent, GoogleOAuthCredentials, ProviderAdapter, ProviderCredentials, FileRecord, TelemetryHook } from "./types";

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
  private readonly retryOptions: RetryOptions;
  private readonly telemetry: TelemetryHook | undefined;

  constructor(retryOptions?: Partial<RetryOptions>, telemetry?: TelemetryHook) {
    this.retryOptions = withRetryDefaults(retryOptions);
    this.telemetry = telemetry;
  }

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
      const response = await this.withProviderRetry(() =>
        client.files.list({
          q: `'${folderId}' in parents and trashed=false and name!='metadata.json'`,
          fields: "files(id,name,mimeType,createdTime,modifiedTime,size,webViewLink)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        "listFiles"
      );

      return (response.data.files ?? []).map((file) => toFileRecord(file));
    } catch (error) {
      throw new ProviderError(`Google listFiles failed: ${safeErrorMessage(error, "Unexpected Google Drive API error.")}`);
    }
  }

  async getFileContent(folderId: string, name: string): Promise<string | null> {
    const client = this.getClient();
    const { directoryPath, fileName } = this.splitPath(name);

    try {
      const targetFolderId = await this.resolveDirectoryFolderId(folderId, directoryPath, false);
      if (!targetFolderId) {
        return null;
      }

      const metadataFileId = await this.findFileIdByName(targetFolderId, fileName);
      if (!metadataFileId) {
        return null;
      }

      const response = await this.withProviderRetry(() =>
        client.files.get(
          {
            fileId: metadataFileId,
            alt: "media",
            supportsAllDrives: true,
          },
          {
            responseType: "text",
          }
        ),
        "getFileContent"
      );

      return String(response.data ?? "");
    } catch (error) {
      throw new ProviderError(`Google getFileContent failed: ${safeErrorMessage(error, "Unexpected Google Drive API error.")}`);
    }
  }

  async upsertFile(folderId: string, name: string, content: string | Buffer, mimeType = "application/json"): Promise<FileRecord> {
    const client = this.getClient();
    const uploadBody = typeof content === "string" ? content : Readable.from([content]);
    const { directoryPath, fileName } = this.splitPath(name);

    try {
      const targetFolderId = await this.resolveDirectoryFolderId(folderId, directoryPath, true);
      if (!targetFolderId) {
        throw new ProviderError(`Google upsertFile failed: could not resolve target folder for '${name}'.`);
      }
      const existingFileId = await this.findFileIdByName(targetFolderId, fileName);
      let response;

      if (existingFileId) {
        response = await this.withProviderRetry(() =>
          client.files.update({
            fileId: existingFileId,
            media: {
              mimeType,
              body: uploadBody,
            },
            fields: "id,name,mimeType,createdTime,modifiedTime,size,webViewLink",
            supportsAllDrives: true,
          }),
          "upsertFile:update"
        );
      } else {
        response = await this.withProviderRetry(() =>
          client.files.create({
            requestBody: {
              name: fileName,
              parents: [targetFolderId],
              mimeType,
            },
            media: {
              mimeType,
              body: uploadBody,
            },
            fields: "id,name,mimeType,createdTime,modifiedTime,size,webViewLink",
            supportsAllDrives: true,
          }),
          "upsertFile:create"
        );
      }

      const file = response.data;
      return toFileRecord(file, fileName);
    } catch (error) {
      throw new ProviderError(`Google upsertFile failed: ${safeErrorMessage(error, "Unexpected Google Drive API error.")}`);
    }
  }

  async deleteFile(folderId: string, name: string): Promise<boolean> {
    const client = this.getClient();
    const { directoryPath, fileName } = this.splitPath(name);

    try {
      const targetFolderId = await this.resolveDirectoryFolderId(folderId, directoryPath, false);
      if (!targetFolderId) {
        return false;
      }

      const fileId = await this.findFileIdByName(targetFolderId, fileName);
      if (!fileId) {
        return false;
      }

      await this.withProviderRetry(
        () =>
          client.files.delete({
            fileId,
            supportsAllDrives: true,
          }),
        "deleteFile"
      );

      return true;
    } catch (error) {
      throw new ProviderError(`Google deleteFile failed: ${safeErrorMessage(error, "Unexpected Google Drive API error.")}`);
    }
  }

  async getInitialSyncToken(_folderId: string): Promise<string | undefined> {
    const client = this.getClient();
    try {
      const response = await this.withProviderRetry(() =>
        client.changes.getStartPageToken({ supportsAllDrives: true })
      , "getInitialSyncToken");
      return response.data.startPageToken ?? undefined;
    } catch (error) {
      throw new ProviderError(`Google getInitialSyncToken failed: ${safeErrorMessage(error, "Unexpected Google Drive API error.")}`);
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
        const currentPageToken = pageToken;
        const listResult = await this.withProviderRetry(() =>
          client.changes.list({
            pageToken: currentPageToken,
            spaces: "drive",
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,createdTime,modifiedTime,size,webViewLink,parents))",
          }),
          "getIncrementalChanges"
        );
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
      throw new ProviderError(`Google getIncrementalChanges failed: ${safeErrorMessage(error, "Unexpected Google Drive API error.")}`);
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
    const response = await this.withProviderRetry(() =>
      client.files.list({
        q: `'${folderId}' in parents and trashed=false and name='${fileName.replace(/'/g, "\\'")}'`,
        fields: "files(id,name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      "findFileIdByName"
    );

    return response.data.files?.[0]?.id ?? undefined;
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
      const existing = await this.findChildFolderIdByName(currentFolderId, segment);
      if (existing) {
        currentFolderId = existing;
        continue;
      }

      if (!createIfMissing) {
        return undefined;
      }

      currentFolderId = await this.createFolder(currentFolderId, segment);
    }

    return currentFolderId;
  }

  private async findChildFolderIdByName(parentFolderId: string, folderName: string): Promise<string | undefined> {
    const client = this.getClient();
    const escapedName = folderName.replace(/'/g, "\\'");
    const response = await this.withProviderRetry(() =>
      client.files.list({
        q: `'${parentFolderId}' in parents and trashed=false and name='${escapedName}' and mimeType='application/vnd.google-apps.folder'`,
        fields: "files(id,name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      "findChildFolderIdByName"
    );

    return response.data.files?.[0]?.id ?? undefined;
  }

  private async createFolder(parentFolderId: string, folderName: string): Promise<string> {
    const client = this.getClient();
    const created = await this.withProviderRetry(() =>
      client.files.create({
        requestBody: {
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentFolderId],
        },
        fields: "id",
        supportsAllDrives: true,
      }),
      "createFolder"
    );

    const id = created.data.id;
    if (!id) {
      throw new ProviderError(`Google create folder failed for '${folderName}'.`);
    }

    return id;
  }

  private async withProviderRetry<T>(task: () => Promise<T>, source: string): Promise<T> {
    const context = {
      source: `google.${source}`,
      provider: "google" as const,
      ...(this.telemetry ? { telemetry: this.telemetry } : {}),
    };
    return runWithRetry(task, this.retryOptions, isTransientProviderError, context);
  }
}
