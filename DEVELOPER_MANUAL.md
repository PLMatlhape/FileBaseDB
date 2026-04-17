# FileBaseDB Developer Manual

This manual explains how to configure, integrate, and operate FileBaseDB in production applications.

## 1) What FileBaseDB Is

FileBaseDB is a Node.js/TypeScript SDK that treats one cloud folder as a dataset.

- Provider support: Google Drive and OneDrive
- Record model: each file is a record
- Metadata model: metadata is stored in metadata.json inside the same folder
- Optional table layer: SQL-style table schemas and CRUD using the SQL mapper

## 2) Runtime and prerequisites

- Node.js 20+
- OAuth app configured for target provider
- Folder access permissions granted to the authenticated account

## 3) Installation

```bash
npm install filebasedb
```

## 4) Provider configuration

### Google Drive

Required scope:

- https://www.googleapis.com/auth/drive

Credentials shape:

```ts
{
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}
```

### OneDrive

Required scope:

- Files.ReadWrite.All

Credentials shape:

```ts
{
  accessToken: string;
}
```

## 5) Core integration flow

```ts
import { connect } from "filebasedb";

const db = await connect("google", credentials, {
  cacheTtlMs: 30000,
  pollingIntervalMs: 20000,
  retry: {
    maxAttempts: 4,
    baseDelayMs: 200,
    maxDelayMs: 3000,
    jitterRatio: 0.2,
  },
  writeConflict: {
    policy: "retry-merge",
    maxRetries: 3,
    backoffMs: 120,
  },
  telemetry: {
    onEvent: (event) => {
      console.log(event.type, event.source, event.message);
    },
  },
});

await db.useFolder(folderIdOrLink);
const files = await db.getFiles();

await db.addMetadata(files[0].id, {
  tags: ["invoice"],
  category: "finance",
  reviewer: "ops",
});

db.disconnect();
```

## 6) Querying files

Supported filters:

- tag
- category
- type (case-insensitive MIME substring)
- fromDate, toDate
- metadata object exact key/value matching

```ts
const result = await db.getFiles({
  tag: "invoice",
  type: "pdf",
  metadata: { reviewer: "ops" },
});
```

## 7) Metadata lifecycle

Metadata is persisted to metadata.json in the active folder.

- addMetadata(fileId, patch)
- updateMetadata(fileId, patch)
- removeMetadata(fileId)

Notes:

- Writes are merge-based by fileId
- Indexes for tags and categories are rebuilt automatically

## 8) Subscriptions and sync

Use subscribe to receive incremental change events.

```ts
const unsubscribe = db.subscribe(folderId, (events) => {
  // added/updated/removed
});

// later
unsubscribe();
db.disconnect();
```

## 9) SQL mapper usage

The SQL mapper adds a table-like abstraction over file storage.

Table organization:

- each table name maps to a subfolder in the linked folder
- schema + index files are saved in that table subfolder
- table records are saved in that same table subfolder

```ts
import { connect, createTableDB, migrateTableLayout } from "filebasedb";

const db = await connect("google", credentials);
await db.useFolder(folderId);

const tables = await createTableDB(db, {
  namespace: "tenant-a",
});

await tables.createTable({
  tableName: "products",
  columns: {
    id: { type: "string" },
    name: { type: "string" },
    price: { type: "number" },
    active: { type: "boolean" },
  },
  primaryKey: "id",
});

await tables.insert("products", {
  id: "p-1",
  name: "Pizza",
  price: 12.99,
  active: true,
});

const product = await tables.read("products", "p-1");
await tables.update(
  "products",
  "p-1",
  { price: 13.49 },
  { expectedUpdatedAt: product?._updatedAt }
);

const files = await tables.listTableFiles("products");
console.log(files);

await migrateTableLayout(db, { namespace: "tenant-a" });
```

### SQL schema import

If developers already have SQL CREATE TABLE definitions, import them:

```ts
await tables.importSqlSchema(`
  CREATE TABLE products (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    active BOOLEAN
  );
`);
```

You can also upload a .sql file into the folder and call importSqlFile(fileName).

## 10) Image storage and rendering

FileBaseDB can store image files in Drive/OneDrive and return file metadata.

- Upload: db.writeFile("images/photo.png", buffer, "image/png")
- Store returned file id/webUrl in metadata or SQL mapper table
- Frontend renders using URL or backend proxy endpoint

Important:

- FileBaseDB does not render images itself
- If files are private, frontends should use backend-authenticated fetch or signed/shareable links

## 11) Production hardening checklist

- Store OAuth credentials in secure secret management
- Use least-privilege scopes
- Do not log raw tokens or secrets
- Configure built-in retry/backoff and monitor telemetry events
- Use dedicated folders per environment (dev/stage/prod)
- Use db.disconnect() on shutdown
- Run npm test in CI for every change
- Run environment-specific smoke checks against real OAuth apps/quotas:

```bash
# set FILEBASEDB_SMOKE_TEST=1 and provider env variables first
npm run test:smoke
```

## 12) Error model

Typed errors:

- AuthenticationError
- ConfigurationError
- ProviderError
- MetadataError

Recommended handling:

- Map auth errors to 401/403
- Map config errors to 400
- Map provider errors to 502/503 with retry strategy
- Keep raw provider error text out of user-facing responses

## 13) Limits and design expectations

- Not a replacement for full SQL databases
- No ACID multi-record transactions
- Query speed depends on provider API + folder size
- SQL mapper improves lookup for exact-match filters using table index files, but still reads files for result hydration

## 14) Suggested architecture pattern

Use FileBaseDB for file-centric datasets and attach metadata, often alongside a traditional database for transactional workloads.

Examples:

- FileBaseDB: documents, images, binary assets, simple catalog records
- SQL DB: payments, inventory locking, accounting transactions, high-concurrency updates
