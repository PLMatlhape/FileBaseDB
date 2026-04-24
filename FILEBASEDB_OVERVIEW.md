# FileBaseDB: Detailed Overview

## What is FileBaseDB?

FileBaseDB is a cloud-folder data access library for Node.js applications.

It turns Google Drive or OneDrive folders into structured, queryable datasets by combining:

- native file storage (the folder)
- metadata indexing (metadata.json)
- optional SQL-style mapper (table schemas + record files + indexes)

## What does it do?

FileBaseDB provides a single API to:

1. Connect to Google Drive or OneDrive with OAuth
2. Bind to one folder as an active dataset
3. List files and query them with metadata filters
4. Add/update/remove metadata for each file
5. Subscribe to provider incremental changes
6. Manage lifecycle and local caching

With the SQL mapper, it can additionally:

- create table schemas
- insert/read/update/delete record files
- query record sets using filter lookups
- import CREATE TABLE SQL schemas

## What can you build with it?

Suitable workloads:

- document repositories with tags and categories
- image or media libraries with metadata
- lightweight admin dashboards and CMS-like flows
- low-to-medium throughput internal tools
- portable, cloud-account-native file datasets

## What it is not

FileBaseDB is not:

- a transactional relational database engine
- a full SQL execution engine
- an analytics engine for large aggregations
- a replacement for systems requiring strict ACID transactions

## Internal model

Core layer:

- folder = dataset
- file = record
- metadata.json = metadata index document

SQL mapper layer:

- table schema file: <table>/_schema.json
- table index file: <table>/_index.json
- records: <table>/<table>-<pk>.json

## Performance characteristics

- Provider API latency dominates operation speed
- Core file querying can degrade with very large folder counts
- SQL mapper index files improve exact-match filter candidate selection
- Records are still hydrated from file content for final results

## Security model

- No central FileBaseDB-hosted data plane
- Data stays in user-owned provider account
- OAuth tokens supplied by integrating application
- Library includes token redaction on error surfaces

## Key limitations

1. No multi-record atomic transactions
2. No joins/complex SQL query planner
3. Concurrency conflicts need app-level strategy
4. Provider quotas and throttling apply
5. Access control is provider-driven, not FileBaseDB-native RBAC

## Recommended use pattern

Use FileBaseDB where storage-native file workflows matter.

Use a traditional SQL/NoSQL database when you need:

- strict transactions
- high write concurrency
- complex joins/reporting
- mission-critical low-latency query guarantees

Hybrid architecture is often best:

- FileBaseDB for files/assets + descriptive metadata
- SQL database for transactional business state
