import { test } from "node:test";
import assert from "node:assert";
import { createFileBaseDB, createTableDB, migrateTableLayout, ProviderAdapter, FileRecord } from "../src";
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

  async deleteFile(_: string, name: string): Promise<boolean> {
    return this.files.delete(name);
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

test("SQL mapper supports namespaced table folders and listTableFiles", async () => {
  const provider = new MockProvider();
  const db = createFileBaseDB("google", provider, { cacheTtlMs: 1000 });
  await db.useFolder("test-folder");
  const tables = await createTableDB(db, { namespace: "tenant-a" });

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
    const files = await tables.listTableFiles("users");

    assert.ok(files.includes("tenant-a/users/_schema.json"));
    assert.ok(files.includes("tenant-a/users/_index.json"));
    assert.ok(files.some((file) => file.endsWith("/users-u1.json")));
  } finally {
    db.disconnect();
  }
});

test("SQL mapper migrates legacy root schema and index layout", async () => {
  const provider = new MockProvider();
  const db = createFileBaseDB("google", provider, { cacheTtlMs: 1000 });
  await db.useFolder("test-folder");

  const schemaJson = JSON.stringify({
    tableName: "products",
    columns: {
      id: { type: "string" },
    },
    primaryKey: "id",
  });

  const indexJson = JSON.stringify({
    tableName: "products",
    primaryKey: "id",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    records: {},
    fieldValues: { id: {} },
  });

  await db.writeFile("products.schema.json", schemaJson, "application/json");
  await db.writeFile("products.index.json", indexJson, "application/json");

  const result = await migrateTableLayout(db);

  assert.deepStrictEqual(result.migratedTables, ["products"]);
  assert.equal(await db.readFile("products/_schema.json"), schemaJson);
  assert.equal(await db.readFile("products/_index.json"), indexJson);
  assert.equal(await db.readFile("products.schema.json"), null);
  assert.equal(await db.readFile("products.index.json"), null);

  db.disconnect();
});