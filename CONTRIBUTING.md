# Contributing to FileBaseDB

Thank you for contributing.

## 1) Development setup

Requirements:

- Node.js 20+
- npm

Install:

```bash
npm install
```

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

## 2) Project structure

- src/index.ts: SDK entry point
- src/google.ts: Google provider adapter
- src/onedrive.ts: OneDrive provider adapter
- src/metadata.ts: metadata.json read/write and indexes
- src/cache.ts: in-memory and SQLite cache
- src/sql-mapper.ts: SQL-style table abstraction
- src/types.ts: public contracts
- src/errors.ts: typed errors
- tests/: unit tests

## 3) Coding guidelines

- Keep changes focused and minimal
- Preserve public API stability unless versioning indicates break
- Use typed errors instead of generic Error
- Do not log tokens or secrets
- Keep strict TypeScript compatibility

## 4) Testing expectations

Before opening a PR:

1. Run npm test locally
2. Validate build output in dist/
3. Confirm no credentials are committed
4. Ensure changed behavior is covered with tests when feasible

## 5) Security and secrets

- Never commit access tokens, refresh tokens, client secrets, or local .env values
- Redact sensitive values in logs and error messages
- Report vulnerabilities privately; see SECURITY.md

## 6) Commit and PR quality

PRs should include:

- concise description of the change
- rationale and impact
- test evidence (command + result)
- docs updates when behavior changes

## 7) Versioning and release notes

- Follow semantic versioning
- Document breaking changes clearly
- Use PUBLISHING_CHECKLIST.md before release tags

## 8) Scope for contributions

High-value contributions:

- provider reliability improvements (retry/backoff patterns)
- performance improvements for large-folder queries
- better SQL mapper indexing and conflict handling
- tests for edge cases and provider failures
- documentation and examples
