# FileBaseDB

FileBaseDB is a TypeScript/Node.js library that turns Google Drive or OneDrive folders into lightweight, metadata-aware datasets.

- Dataset: one cloud folder
- Record: one file in that folder
- Metadata store: metadata.json in the same folder
- Optional SQL mapper: table-like schemas and CRUD over JSON record files

Supported runtime: Node.js 20+

## Production readiness status

Current status: production-capable for file-centric workloads with documented limits.

Ready now:

- OAuth-based provider connectivity (Google Drive, OneDrive)
- Metadata indexing and filtering
- Incremental sync subscriptions
- Local caching (memory and SQLite option)
- Built-in retry/backoff for transient provider failures
- Conflict-aware metadata and table operations
- Telemetry hooks for retry/throttle/conflict events
- Typed error model
- Secret redaction in key error paths
- CI build/test/security workflow support

Still recommended before high-scale or mission-critical use:

- Integration tests in your own environment and quotas
- Concurrency strategy for competing writes
- Operational monitoring around provider/API failures

## Install

```bash
npm install filebasedb
```

## Quick start

```ts
import { connect } from "filebasedb";

const db = await connect("google", {
  accessToken: process.env.GOOGLE_ACCESS_TOKEN,
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
});

await db.useFolder("<folder-id-or-link>");

const files = await db.getFiles({ tag: "invoice", type: "pdf" });
console.log(files);

db.disconnect();
```

## Core capabilities

- Connect to Google Drive or OneDrive using OAuth credentials
- Resolve and bind a folder as an active dataset
- Read file records with metadata filters
- Add/update/remove metadata entries
- Subscribe to incremental folder changes
- Read/write content files directly using SDK methods

## SQL mapper capabilities

The SQL mapper offers table-like behavior on top of folder storage:

- createTable(schema)
- insert/read/update/delete
- query(filter)
- count
- import SQL CREATE TABLE schema text or files

Storage layout per table:

- each table is created as a subfolder under the linked main folder
- schema and index are stored inside that subfolder
- all records for that table are stored inside the same subfolder

Write-conflict behavior:

- insert throws conflict when primary key already exists
- update/delete can use optimistic checks via expectedUpdatedAt

Example:

```ts
import { connect, createTableDB } from "filebasedb";

const db = await connect("google", credentials);
await db.useFolder(folderId);

const tables = await createTableDB(db);

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
  id: "p-001",
  name: "Margherita Pizza",
  price: 9.99,
  active: true,
});
```

Advanced SQL mapper example (namespace + telemetry + table file listing + layout migration):

```ts
import { connect, createTableDB, migrateTableLayout } from "filebasedb";

const db = await connect("onedrive", credentials, {
  telemetry: {
    onEvent: (event) => {
      console.log("[filebasedb]", event.type, event.source, event.message);
    },
  },
});

await db.useFolder(folderId);

const tenantTables = await createTableDB(db, {
  namespace: "tenant-a",
  telemetry: {
    onEvent: (event) => {
      if (event.type === "conflict") {
        console.warn("Conflict event", event);
      }
    },
  },
});

await tenantTables.createTable({
  tableName: "orders",
  columns: {
    id: { type: "string" },
    total: { type: "number" },
  },
  primaryKey: "id",
});

const files = await tenantTables.listTableFiles("orders");
await migrateTableLayout(db, { namespace: "tenant-a" });
```

## Image storage and rendering

FileBaseDB can store binary files (including images) in provider folders and return metadata that apps can render.

- Upload image with writeFile(path, buffer, mimeType)
- Persist returned drive/graph file id and web URL in metadata or SQL mapper table
- Render in frontend with URL or backend-proxied fetch

Important: FileBaseDB does not render images itself.

## API summary

- connect(provider, credentials, options?)
- useFolder(folderIdOrLink)
- getFiles(filters?)
- addMetadata(fileId, metadata)
- updateMetadata(fileId, metadata)
- removeMetadata(fileId)
- writeFile(name, content, mimeType?)
- readFile(name)
- deleteFile(name)
- subscribe(folderId, callback)
- disconnect()
- createTableDB(db, options?)
- migrateTableLayout(db, options?)

## Required scopes

Google Drive:

- https://www.googleapis.com/auth/drive

OneDrive (Microsoft Graph):

- Files.ReadWrite.All

## Configuration options

connect options:

- cacheTtlMs
- pollingIntervalMs
- useSQLiteCache
- sqliteDbPath
- retry.maxAttempts/baseDelayMs/maxDelayMs/jitterRatio
- writeConflict.policy/maxRetries/backoffMs
- telemetry.onEvent(event)

SQL mapper options:

- namespace
- telemetry.onEvent(event)

## Limitations

- Not a full SQL engine
- No multi-record ACID transactions
- Query performance depends on provider API and folder size
- No built-in RBAC beyond provider permissions
- High-concurrency write coordination is app responsibility

## When to use vs when not to use

| Scenario | Fit |
| --- | --- |
| Data already lives in Drive/OneDrive folders | Strong |
| File-centric apps with metadata filtering | Strong |
| Internal tools and moderate traffic workloads | Strong |
| Complex relational joins/analytics workloads | Weak |
| Strict multi-record transactions (ACID) required | Weak |
| Very high write concurrency across many workers | Weak |

## Production readiness guidance

Practical readiness: **8/10** for lightweight-to-moderate production workloads.

Ready now:

- Retry with backoff/jitter for transient provider failures
- Conflict-aware metadata and table updates
- Telemetry hooks for retry/throttle/conflict events
- Incremental sync subscriptions and metadata indexing
- Namespaced SQL mapper layout and table layout migration helper

Recommended before high-scale, mission-critical workloads:

- Define SLOs, alerts, and dashboards around provider/API failure rates
- Run smoke tests in target tenant with real quotas and auth flow
- Add app-level strategy for hot-row contention and idempotency
- Validate backup/restore process for target provider folders

## Testing and release checks

Run locally:

```bash
npm run build
npm test
```

Run environment-specific integration smoke test (real OAuth app + quota):

```bash
# set FILEBASEDB_SMOKE_TEST=1, FILEBASEDB_PROVIDER, FILEBASEDB_FOLDER_ID,
# and provider credentials in env first
npm run test:smoke
```

Release checklist:

- PUBLISHING_CHECKLIST.md

Security policy:

- SECURITY.md

## Developer deep-dive

### Internal architecture

Core modules:

- `src/index.ts`: SDK orchestration (`connect`, `useFolder`, file ops, subscriptions)
- `src/google.ts` and `src/onedrive.ts`: provider adapters implementing `ProviderAdapter`
- `src/metadata.ts`: `metadata.json` lifecycle, indexes, and conflict-aware commits
- `src/cache.ts`: in-memory and SQLite cache implementations
- `src/retry.ts`: retry/backoff/jitter and transient failure classification
- `src/sql-mapper.ts`: table abstraction, index files, schema import, namespace support
- `src/errors.ts`: typed error model

### Runtime data model

- Dataset = one cloud folder
- Record = one file
- Metadata index = `metadata.json`
- SQL mapper table layout = `<namespace?>/<table>/_schema.json`, `<namespace?>/<table>/_index.json`, and record JSON files

### Request flow

1. `connect(provider, credentials, options)` initializes a provider adapter.
2. `useFolder(folderIdOrLink)` resolves and binds the active dataset folder.
3. `getFiles(filters)` combines provider file listing + metadata filtering.
4. Metadata writes (`addMetadata`, `updateMetadata`, `removeMetadata`) are conflict-aware and indexed.
5. `subscribe()` polls provider incremental APIs and reconciles metadata/cache.

### Production integration notes

- Treat FileBaseDB as a file-centric data layer, not a full transactional database.
- Use app-level idempotency and contention handling for hot records.
- Consume telemetry events (`retry`, `conflict`, `throttle`) for observability.
- Keep OAuth secrets out of logs and source control; provider scopes are your effective permission boundary.

## Developer documentation

- DEVELOPER_MANUAL.md
- FILEBASEDB_OVERVIEW.md
- CONTRIBUTING.md

## Repository layout

- src/: library source
- tests/: unit tests
- examples/: usage samples

## License

Apache 2.0. See LICENSE.
