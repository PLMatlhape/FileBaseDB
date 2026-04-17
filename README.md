# FileBaseDB

FileBaseDB is a TypeScript/Node.js developer library that treats cloud folders as lightweight databases.

- **Dataset** = a Google Drive or OneDrive folder
- **Record** = a file in that folder
- **Schema/metadata** = `metadata.json` stored in the folder

It is designed for simple, low-friction file-based applications where you need queryable metadata without operating a traditional DB server.

## Features

- OAuth 2.0 token-based authentication for Google Drive and Microsoft Graph (OneDrive)
- Folder ID/link mapping to a dataset context
- Query files with filters (`tag`, `type`, date range, metadata fields)
- Add/update/remove metadata in `metadata.json`
- Incremental sync with provider change APIs:
	- Google Drive `changes` API + page tokens
	- OneDrive `delta` API + delta links
- Local caching and precomputed metadata indexes (tags + categories)
- Optional CLI for local query testing

## Installation

```bash
npm install filebasedb
```

For local development:

```bash
npm install
npm run build
```

## Required Scopes

- **Google Drive**: `https://www.googleapis.com/auth/drive`
- **OneDrive (Graph)**: `Files.ReadWrite.All`

## Quick Start

```ts
import { connect } from "filebasedb";

async function main() {
	const db = await connect("google", {
		accessToken: process.env.GOOGLE_ACCESS_TOKEN,
		refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
		clientId: process.env.GOOGLE_CLIENT_ID,
		clientSecret: process.env.GOOGLE_CLIENT_SECRET,
		redirectUri: process.env.GOOGLE_REDIRECT_URI,
	});

	await db.useFolder("1A2B3C-your-folder-id");

	const files = await db.getFiles({ tag: "invoice", type: "pdf" });
	console.log(files);

	await db.addMetadata("file-id-123", {
		tags: ["invoice", "approved"],
		category: "finance",
		reviewer: "team-a",
	});

	const unsubscribe = db.subscribe("1A2B3C-your-folder-id", (events) => {
		console.log("changes", events);
	});

	setTimeout(() => {
		unsubscribe();
		db.disconnect();
	}, 30000);
}

void main();
```

## Public API

### `connect(provider, credentials, options?)`

Creates a provider session.

- `provider`: `"google" | "onedrive"`
- `credentials`:
	- Google: `{ accessToken?, refreshToken?, clientId?, clientSecret?, redirectUri? }`
	- OneDrive: `{ accessToken }`
- `options`:
	- `cacheTtlMs?: number`
	- `pollingIntervalMs?: number`
	- `useSQLiteCache?: boolean`
	- `sqliteDbPath?: string`

### `useFolder(folderIdOrLink)`

Resolves and stores the active dataset folder.

### `getFiles(filters?)`

Returns files merged with metadata entries.

Supported filters:

- `tag`
- `category`
- `type` (matches MIME type)
- `fromDate` / `toDate` (ISO date)
- `metadata` (exact key/value matching)

### `addMetadata(fileId, metadataObject)`

Adds or updates metadata entry for a file and rewrites `metadata.json`.

### `updateMetadata(fileId, metadataObject)`

Explicit alias of `addMetadata`.

### `removeMetadata(fileId)`

Removes a metadata entry.

### `subscribe(folderId, callback)`

Starts incremental polling and emits file change events.

Returns an `unsubscribe()` function.

## Workflow Mapping

1. **Setup**: install package, configure OAuth credentials and folder ID.
2. **Folder Mapping**: call `useFolder` to bind dataset context.
3. **Query Layer**: call `getFiles` with optional filters.
4. **Metadata Management**: call `addMetadata`/`removeMetadata`, persisted in `metadata.json`.
5. **Performance Optimizations**:
	 - local cache for file and metadata data
	 - incremental sync tokens for provider changes
	 - precomputed metadata indexes for tags/categories

## Project Structure

```text
src/
	index.ts        # main SDK entry
	google.ts       # Google Drive provider
	onedrive.ts     # OneDrive provider
	metadata.ts     # metadata.json management + indexes
	cache.ts        # local cache implementations
	cli.ts          # optional CLI
	types.ts        # public type contracts
	errors.ts       # custom typed errors
examples/
	demo.ts
```

## CLI (Optional)

Build first:

```bash
npm run build
```

Run via source:

```bash
npm run cli -- --provider google --folder <folderId> --credentials ./credentials.json --tag invoice
```

Installed binary:

```bash
filebasedb --provider onedrive --folder <folderId> --credentials ./credentials.json --type image
```

`credentials.json` examples:

Google:

```json
{
	"accessToken": "...",
	"refreshToken": "...",
	"clientId": "...",
	"clientSecret": "...",
	"redirectUri": "http://localhost"
}
```

OneDrive:

```json
{
	"accessToken": "..."
}
```

## Extensibility

To add another provider (for example Firebase or Azure Blob):

1. Implement `ProviderAdapter` methods.
2. Register provider in `createProvider(...)` in `src/index.ts`.
3. Reuse `MetadataManager` and cache logic unchanged.

## Error Handling

The SDK provides typed errors:

- `AuthenticationError`
- `ConfigurationError`
- `ProviderError`
- `MetadataError`

These include descriptive messages to simplify troubleshooting in API integrations.

## License

Apache 2.0. See [LICENSE](./LICENSE).