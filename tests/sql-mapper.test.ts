import { test } from "node:test";
import assert from "node:assert";
import { createFileBaseDB, createTableDB, ProviderAdapter, FileRecord } from "../src";
import { ConfigurationError } from "../src/errors";

class MockProvider implements ProviderAdapter {
  private files = new Map<string, string>();

  async initialize(): Promise<void> {}

  resolveFolderId(): string {
    return "test-folder";
  }

  async listFiles(): Promise<FileRecord[]> {
    return Array.from(this.files.entries()).map(([name]) => ({
      id: name,
      name,
      mimeType: "application/json",
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    }));
  }

  async getFileContent(_: string, name: string): Promise<string | null> {
    return this.files.get(name) ?? null;
  }

  async upsertFile(_: string, name: string, content: string | Buffer): Promise<FileRecord> {
    this.files.set(name, typeof content === "string" ? content : content.toString("utf8"));
    return { id: name, name, mimeType: "application/json" };
  }

  async getInitialSyncToken(): Promise<string | undefined> {
    return undefined;
  }

  async getIncrementalChanges(): Promise<{ events: [] }> {
    return { events: [] };
  }
}

async function createHarness() {
  const provider = new MockProvider();
  const db = createFileBaseDB("google", provider, { cacheTtlMs: 1000 });
  await db.useFolder("test-folder");
  const tables = await createTableDB(db);
  return { provider, db, tables };
}

test("SQL mapper creates indexed tables and records", async () => {
  const { db, tables } = await createHarness();

  try {
    await tables.createTable({
      tableName: "users",
      columns: {
        id: { type: "string" },
        name: { type: "string" },
        role: { type: "string" },
      },
      primaryKey: "id",
    });

    const recordId = await tables.insert("users", {
      id: "u1",
      name: "John Doe",
      role: "admin",
    });

    assert.strictEqual(recordId, "users-u1");
    assert.strictEqual((await tables.query("users", { role: "admin" })).length, 1);
    assert.strictEqual((await tables.count("users")), 1);
  } finally {
    db.disconnect();
  }
});

test("SQL mapper imports CREATE TABLE schemas", async () => {
  const { db, tables } = await createHarness();

  try {
    const schemas = await tables.importSqlSchema(`
      CREATE TABLE users (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(50)
      );

      CREATE TABLE orders (
        order_id INT PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        created_at DATETIME
      );
    `);

    assert.strictEqual(schemas.length, 2);
    assert.strictEqual(schemas[0]?.tableName, "users");
    assert.strictEqual(schemas[1]?.tableName, "orders");
  } finally {
    db.disconnect();
  }
});

test("SQL mapper updates and deletes records", async () => {
  const { db, tables } = await createHarness();

  try {
    await tables.createTable({
      tableName: "users",
      columns: {
        id: { type: "string" },
        name: { type: "string" },
      },
      primaryKey: "id",
    });

    await tables.insert("users", { id: "u1", name: "John" });
    await tables.update("users", "u1", { name: "Jane" });

    const updated = await tables.read("users", "u1");
    assert.strictEqual(updated?.name, "Jane");

    await tables.delete("users", "u1");
    assert.strictEqual(await tables.read("users", "u1"), null);
  } finally {
    db.disconnect();
  }
});

test("SQL mapper rejects invalid records", async () => {
  const { db, tables } = await createHarness();

  try {
    await tables.createTable({
      tableName: "users",
      columns: {
        id: { type: "string" },
        age: { type: "number" },
      },
      primaryKey: "id",
    });

    await assert.rejects(
      () => tables.insert("users", { id: "u1", age: "bad" as unknown as number }),
      ConfigurationError
    );
  } finally {
    db.disconnect();
  }
});