# Copilot Instructions for FileBaseDB

## Build, test, and lint commands

```bash
npm install
npm run build
```

- Build uses `tsc -p tsconfig.json` and emits to `dist/`.
- Clean build output: `npm run clean`
- Run example app against real provider credentials: `npm run dev`
- Run CLI from source: `npm run cli -- --provider <google|onedrive> --folder <folderIdOrLink> --credentials <path>`

There are currently no repository test scripts (`npm test`) or lint scripts (`npm run lint`), and no configured single-test command in this repository.

## High-level architecture

- `src/index.ts` is the SDK orchestrator. `connect()` creates a provider (`GoogleDriveProvider` or `OneDriveProvider`), then `useFolder()` binds a folder-scoped session and initializes metadata + sync token state.
- `src/types.ts` defines the central abstraction: `ProviderAdapter`. Provider implementations in `src/google.ts` and `src/onedrive.ts` must normalize folder references, list files, read/write `metadata.json`, and provide incremental change events/tokens.
- `src/metadata.ts` manages the authoritative `metadata.json` file inside the cloud folder. It loads/saves the document, rebuilds indexes (`tags`, `categories`) on writes, and executes metadata-aware filtering.
- `src/cache.ts` provides two interchangeable cache stores behind `CacheStore`: in-memory default and `SQLiteCache` (persistent mirror + in-memory fast path). `FileBaseDB` caches file lists and metadata documents separately.
- Incremental sync is provider-driven: `subscribe()` in `src/index.ts` polls `getIncrementalChanges()`, reconciles removed file metadata, invalidates cached file lists, and emits change events.
- `src/cli.ts` is a thin wrapper over the SDK: parse args -> read credentials JSON -> `connect()` -> `useFolder()` -> `getFiles(filters)`.

## Key conventions specific to this codebase

- Treat each cloud folder as a dataset; every non-`metadata.json` file is a record.
- `metadata.json` is reserved internal state and is explicitly excluded from normal file listings/change outputs in provider adapters.
- Call order matters: `connect()` -> `useFolder()` must happen before `getFiles()`, metadata mutation, or `subscribe()`.
- Metadata updates are merge-based by `fileId` (`addMetadata`/`updateMetadata` preserve existing keys unless overwritten).
- Filter behavior is strict and intentionally simple:
  - `type` does case-insensitive substring match on MIME type.
  - `metadata` filter is exact key/value equality.
  - `fromDate`/`toDate` compare against file `modifiedAt`.
- Cache key strategy is stable and cross-module: `files:<provider>:<folderId>` for file lists and `metadata:<folderId>` for metadata docs.
- Errors should surface as typed SDK errors from `src/errors.ts` (`AuthenticationError`, `ConfigurationError`, `ProviderError`, `MetadataError`) rather than generic `Error`.
- TypeScript strictness is part of the project contract (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` in `tsconfig.json`).
