import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCache } from "../src/cache";
import { MetadataManager } from "../src/metadata";
import {
  ChangeEvent,
  FileRecord,
  ProviderAdapter,
  ProviderCredentials,
} from "../src/types";

class MockProvider implements ProviderAdapter {
  private readonly store = new Map<string, string>();

  async initialize(_credentials: ProviderCredentials): Promise<void> {
    return;
  }

  resolveFolderId(folderRef: string): string {
    return folderRef;
  }

  async listFiles(_folderId: string): Promise<FileRecord[]> {
    return [];
  }

  async getFileContent(folderId: string, name: string): Promise<string | null> {
    const key = `${folderId}/${name}`;
    return this.store.get(key) ?? null;
  }

  async upsertFile(
    folderId: string,
    name: string,
    content: string | Buffer,
    _mimeType?: string
  ): Promise<FileRecord> {
    const key = `${folderId}/${name}`;
    this.store.set(key, typeof content === "string" ? content : content.toString("utf8"));
    return { id: key, name };
  }

  async deleteFile(folderId: string, name: string): Promise<boolean> {
    const key = `${folderId}/${name}`;
    return this.store.delete(key);
  }

  async getInitialSyncToken(_folderId: string): Promise<string | undefined> {
    return undefined;
  }

  async getIncrementalChanges(
    _folderId: string,
    _syncToken?: string
  ): Promise<{ events: ChangeEvent[]; syncToken?: string }> {
    return { events: [] };
  }
}

test("MetadataManager merges metadata updates by fileId", async () => {
  const provider = new MockProvider();
  const manager = new MetadataManager(provider, "folder-1", new InMemoryCache(), 1_000, {
    policy: "retry-merge",
    maxRetries: 2,
    backoffMs: 10,
  });

  await manager.addOrUpdateMetadata("file-1", { category: "finance", reviewer: "alice" });
  const merged = await manager.addOrUpdateMetadata("file-1", { reviewer: "bob", tags: ["invoice"] });

  assert.equal(merged.fileId, "file-1");
  assert.equal(merged.category, "finance");
  assert.equal(merged.reviewer, "bob");
  assert.deepEqual(merged.tags, ["invoice"]);
});

test("MetadataManager queryFiles respects tag, type and metadata filters", async () => {
  const provider = new MockProvider();
  const manager = new MetadataManager(provider, "folder-2", new InMemoryCache(), 1_000, {
    policy: "retry-merge",
    maxRetries: 2,
    backoffMs: 10,
  });

  await manager.addOrUpdateMetadata("f1", { tags: ["invoice"], category: "finance", reviewer: "team-a" });
  await manager.addOrUpdateMetadata("f2", { tags: ["draft"], category: "ops", reviewer: "team-b" });

  const files: FileRecord[] = [
    { id: "f1", name: "invoice.pdf", mimeType: "application/pdf", modifiedAt: "2026-04-15T00:00:00.000Z" },
    { id: "f2", name: "photo.jpg", mimeType: "image/jpeg", modifiedAt: "2026-04-16T00:00:00.000Z" },
  ];

  const result = await manager.queryFiles(files, {
    tag: "invoice",
    type: "pdf",
    metadata: { reviewer: "team-a" },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "f1");
  assert.equal(result[0]?.metadata?.category, "finance");
});
