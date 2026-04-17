import { FileBaseDB } from "./index";
import { ConfigurationError, MetadataError, WriteConflictError } from "./errors";

export type ColumnType = "string" | "number" | "boolean" | "date";

export interface TableSchemaColumn {
  type: ColumnType;
  nullable?: boolean;
  default?: unknown;
}

export interface TableSchema {
  tableName: string;
  columns: Record<string, TableSchemaColumn>;
  primaryKey: string;
  createdAt?: string;
}

export interface RecordWithMeta {
  [key: string]: unknown;
  _recordId: string;
  _createdAt: string;
  _updatedAt: string;
}

interface TableIndex {
  tableName: string;
  primaryKey: string;
  createdAt: string;
  updatedAt: string;
  records: Record<string, { fields: Record<string, string> }>;
  fieldValues: Record<string, Record<string, string[]>>;
}

interface ParsedSqlTable {
  tableName: string;
  columns: Record<string, TableSchemaColumn>;
  primaryKey: string;
}

const SCHEMA_SUFFIX = ".schema.json";
const INDEX_SUFFIX = ".index.json";
const TABLE_SCHEMA_FILE = "_schema.json";
const TABLE_INDEX_FILE = "_index.json";

export class FileBasedTableDB {
  private schemas: Map<string, TableSchema> = new Map();
  private indexes: Map<string, TableIndex> = new Map();

  constructor(private db: FileBaseDB) {}

  async createTable(schema: TableSchema): Promise<void> {
    this.validateSchema(schema);

    const tableSchema: TableSchema = {
      ...schema,
      createdAt: new Date().toISOString(),
    };

    const tableIndex = this.createEmptyIndex(tableSchema);

    this.schemas.set(schema.tableName, tableSchema);
    this.indexes.set(schema.tableName, tableIndex);

    await this.db.writeFile(
      this.schemaFileName(schema.tableName),
      JSON.stringify(tableSchema, null, 2),
      "application/json"
    );

    await this.saveIndex(schema.tableName);
  }

  async importSqlFile(fileName: string): Promise<TableSchema[]> {
    const sql = await this.db.readFile(fileName);
    if (!sql) {
      throw new ConfigurationError(`SQL file '${fileName}' was not found in the folder.`);
    }

    return this.importSqlSchema(sql);
  }

  async importSqlSchema(sql: string): Promise<TableSchema[]> {
    const parsedTables = this.parseSqlSchema(sql);
    const createdSchemas: TableSchema[] = [];

    for (const table of parsedTables) {
      const schema: TableSchema = {
        tableName: table.tableName,
        columns: table.columns,
        primaryKey: table.primaryKey,
      };

      await this.createTable(schema);
      createdSchemas.push(schema);
    }

    return createdSchemas;
  }

  async getTableSchema(tableName: string): Promise<TableSchema> {
    const cached = this.schemas.get(tableName);
    if (cached) {
      return cached;
    }

    const content =
      (await this.db.readFile(this.schemaFileName(tableName))) ??
      (await this.db.readFile(this.legacySchemaFileName(tableName)));
    if (!content) {
      throw new ConfigurationError(`Table '${tableName}' does not exist`);
    }

    const schema = JSON.parse(content) as TableSchema;
    this.validateSchema(schema);
    this.schemas.set(tableName, schema);
    return schema;
  }

  async insert(tableName: string, data: Record<string, unknown>): Promise<string> {
    const schema = await this.getTableSchema(tableName);
    this.validateRecord(data, schema);

    const primaryKeyValue = String(data[schema.primaryKey]);
    if (!primaryKeyValue) {
      throw new ConfigurationError(`Primary key field '${schema.primaryKey}' is required`);
    }

    const existing = await this.read(tableName, primaryKeyValue);
    if (existing && !this.isDeleted(existing)) {
      throw new WriteConflictError(
        `Record '${primaryKeyValue}' already exists in table '${tableName}'. Use update() or a new primary key.`
      );
    }

    const recordId = `${tableName}-${primaryKeyValue}`;
    const now = new Date().toISOString();

    const record: RecordWithMeta = {
      ...data,
      _recordId: recordId,
      _createdAt: now,
      _updatedAt: now,
    };

    await this.db.writeFile(
      this.recordFileName(tableName, recordId),
      JSON.stringify(record, null, 2),
      "application/json"
    );

    await this.upsertIndexRecord(tableName, recordId, record);
    await this.addMetadata(tableName, recordId, { status: "active" });

    return recordId;
  }

  async read(tableName: string, primaryKeyValue: string): Promise<RecordWithMeta | null> {
    const recordId = `${tableName}-${primaryKeyValue}`;
    const content = await this.db.readFile(this.recordFileName(tableName, recordId));
    if (!content) {
      return null;
    }

    const record = JSON.parse(content) as RecordWithMeta;
    if (this.isDeleted(record)) {
      return null;
    }

    return record;
  }

  async update(
    tableName: string,
    primaryKeyValue: string,
    data: Partial<Record<string, unknown>>,
    options?: WriteConflictOptions
  ): Promise<void> {
    const schema = await this.getTableSchema(tableName);
    const existing = await this.read(tableName, primaryKeyValue);

    if (!existing) {
      throw new MetadataError(`Record '${primaryKeyValue}' not found in table '${tableName}'`);
    }

    this.ensureNoWriteConflict(tableName, primaryKeyValue, existing, options);

    const updated: RecordWithMeta = {
      ...existing,
      ...data,
      _updatedAt: new Date().toISOString(),
    };

    this.validateRecord(updated, schema);

    const recordId = existing._recordId;
    await this.db.writeFile(
      this.recordFileName(tableName, recordId),
      JSON.stringify(updated, null, 2),
      "application/json"
    );

    await this.upsertIndexRecord(tableName, recordId, updated);
    await this.addMetadata(tableName, recordId, { status: "updated" });
  }

  async delete(
    tableName: string,
    primaryKeyValue: string,
    hardDelete = false,
    options?: WriteConflictOptions
  ): Promise<void> {
    const existing = await this.read(tableName, primaryKeyValue);

    if (!existing) {
      throw new MetadataError(`Record '${primaryKeyValue}' not found in table '${tableName}'`);
    }

    this.ensureNoWriteConflict(tableName, primaryKeyValue, existing, options);

    const recordId = existing._recordId;

    if (hardDelete) {
      await this.removeFromIndex(tableName, recordId);
      await this.addMetadata(tableName, recordId, {
        status: "deleted",
        deletedAt: new Date().toISOString(),
      });
      return;
    }

    const updated = {
      ...existing,
      _deleted: true,
      _deletedAt: new Date().toISOString(),
    };

    await this.db.writeFile(
      this.recordFileName(tableName, recordId),
      JSON.stringify(updated, null, 2),
      "application/json"
    );

    await this.removeFromIndex(tableName, recordId);
  }

  async query(
    tableName: string,
    filters?: Record<string, unknown>,
    limit = 1000
  ): Promise<RecordWithMeta[]> {
    await this.getTableSchema(tableName);
    const index = await this.loadIndex(tableName);

    const recordIds = this.resolveCandidateRecordIds(index, filters).slice(0, limit);
    const results: RecordWithMeta[] = [];

    for (const recordId of recordIds) {
      const content = await this.db.readFile(this.recordFileName(tableName, recordId));
      if (!content) {
        continue;
      }

      const record = JSON.parse(content) as RecordWithMeta;
      if (this.isDeleted(record)) {
        continue;
      }

      if (this.matchesFilters(record, filters)) {
        results.push(record);
      }
    }

    return results;
  }

  async count(tableName: string): Promise<number> {
    const index = await this.loadIndex(tableName);
    return Object.keys(index.records).length;
  }

  async dropTable(tableName: string): Promise<void> {
    this.schemas.delete(tableName);
    this.indexes.delete(tableName);
    await this.addMetadata(tableName, "schema", { status: "dropped" });
  }

  private validateSchema(schema: TableSchema): void {
    if (!schema.tableName?.trim()) {
      throw new ConfigurationError("Table schema must have tableName.");
    }

    if (!schema.primaryKey?.trim()) {
      throw new ConfigurationError("Table schema must have a primaryKey.");
    }

    if (!schema.columns || Object.keys(schema.columns).length === 0) {
      throw new ConfigurationError("Table schema must have columns.");
    }

    if (!schema.columns[schema.primaryKey]) {
      throw new ConfigurationError(`Primary key '${schema.primaryKey}' not found in columns`);
    }
  }

  private validateRecord(record: Record<string, unknown>, schema: TableSchema): void {
    for (const [columnName, columnDef] of Object.entries(schema.columns)) {
      const value = record[columnName];

      if (value === undefined || value === null) {
        if (!columnDef.nullable && columnDef.default === undefined) {
          throw new ConfigurationError(`Column '${columnName}' is required and cannot be null`);
        }
        continue;
      }

      const valueType = typeof value;
      if (columnDef.type === "date") {
        const isDate = value instanceof Date;
        const isDateString = typeof value === "string" && !Number.isNaN(Date.parse(value));
        if (!isDate && !isDateString) {
          throw new ConfigurationError(`Column '${columnName}' must be a date, got ${valueType}`);
        }
        continue;
      }

      if (columnDef.type !== valueType) {
        throw new ConfigurationError(`Column '${columnName}' must be ${columnDef.type}, got ${valueType}`);
      }
    }
  }

  private matchesFilters(record: Record<string, unknown>, filters?: Record<string, unknown>): boolean {
    if (!filters) {
      return true;
    }

    for (const [key, expectedValue] of Object.entries(filters)) {
      const recordValue = record[key];
      if (!this.valuesEqual(recordValue, expectedValue)) {
        return false;
      }
    }

    return true;
  }

  private valuesEqual(left: unknown, right: unknown): boolean {
    if (left instanceof Date || right instanceof Date) {
      return new Date(left as never).toISOString() === new Date(right as never).toISOString();
    }

    if (typeof left === "string" && this.isDateLike(left) && typeof right === "string" && this.isDateLike(right)) {
      return new Date(left).toISOString() === new Date(right).toISOString();
    }

    return left === right;
  }

  private isDateLike(value: string): boolean {
    return !Number.isNaN(Date.parse(value));
  }

  private isDeleted(record: RecordWithMeta): boolean {
    return record._deleted === true;
  }

  private ensureNoWriteConflict(
    tableName: string,
    primaryKeyValue: string,
    existing: RecordWithMeta,
    options?: WriteConflictOptions
  ): void {
    const expectedUpdatedAt = options?.expectedUpdatedAt;
    const onConflict = options?.onConflict ?? "fail";

    if (!expectedUpdatedAt || onConflict === "overwrite") {
      return;
    }

    const currentUpdatedAt = String(existing._updatedAt ?? "");
    if (currentUpdatedAt !== expectedUpdatedAt) {
      throw new WriteConflictError(
        `Write conflict for '${tableName}/${primaryKeyValue}'. Expected _updatedAt '${expectedUpdatedAt}', current value is '${currentUpdatedAt}'.`
      );
    }
  }

  private async addMetadata(
    tableName: string,
    recordId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.db.addMetadata(recordId, {
        table: tableName,
        ...metadata,
      });
    } catch (error) {
      console.warn(
        `Failed to update metadata for ${recordId}:`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  private createEmptyIndex(schema: TableSchema): TableIndex {
    const fieldValues: Record<string, Record<string, string[]>> = {};
    for (const columnName of Object.keys(schema.columns)) {
      fieldValues[columnName] = {};
    }

    return {
      tableName: schema.tableName,
      primaryKey: schema.primaryKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      records: {},
      fieldValues,
    };
  }

  private async loadIndex(tableName: string): Promise<TableIndex> {
    const cached = this.indexes.get(tableName);
    if (cached) {
      return cached;
    }

    const content =
      (await this.db.readFile(this.indexFileName(tableName))) ??
      (await this.db.readFile(this.legacyIndexFileName(tableName)));
    if (!content) {
      const schema = await this.getTableSchema(tableName);
      const created = this.createEmptyIndex(schema);
      this.indexes.set(tableName, created);
      await this.saveIndex(tableName);
      return created;
    }

    const parsed = JSON.parse(content) as TableIndex;
    this.indexes.set(tableName, parsed);
    return parsed;
  }

  private async saveIndex(tableName: string): Promise<void> {
    const index = await this.loadIndex(tableName);
    index.updatedAt = new Date().toISOString();
    this.indexes.set(tableName, index);
    await this.db.writeFile(
      this.indexFileName(tableName),
      JSON.stringify(index, null, 2),
      "application/json"
    );
  }

  private async upsertIndexRecord(
    tableName: string,
    recordId: string,
    record: Record<string, unknown>
  ): Promise<void> {
    const index = await this.loadIndex(tableName);

    await this.removeFromIndex(tableName, recordId, false);

    const normalizedFields: Record<string, string> = {};
    for (const [field, value] of Object.entries(record)) {
      const key = this.indexKey(value);
      if (key === undefined) {
        continue;
      }

      normalizedFields[field] = key;
      if (!index.fieldValues[field]) {
        index.fieldValues[field] = {};
      }

      if (!index.fieldValues[field][key]) {
        index.fieldValues[field][key] = [];
      }

      if (!index.fieldValues[field][key].includes(recordId)) {
        index.fieldValues[field][key].push(recordId);
      }
    }

    index.records[recordId] = { fields: normalizedFields };
    index.updatedAt = new Date().toISOString();
    this.indexes.set(tableName, index);
    await this.saveIndex(tableName);
  }

  private async removeFromIndex(tableName: string, recordId: string, persist = true): Promise<void> {
    const index = await this.loadIndex(tableName);
    const existing = index.records[recordId];
    if (!existing) {
      return;
    }

    for (const [field, valueKey] of Object.entries(existing.fields)) {
      const fieldIndex = index.fieldValues[field];
      if (!fieldIndex) {
        continue;
      }

      const recordIds = fieldIndex[valueKey];
      if (!recordIds) {
        continue;
      }

      fieldIndex[valueKey] = recordIds.filter((id) => id !== recordId);
      if (fieldIndex[valueKey].length === 0) {
        delete fieldIndex[valueKey];
      }
    }

    delete index.records[recordId];
    index.updatedAt = new Date().toISOString();
    this.indexes.set(tableName, index);

    if (persist) {
      await this.saveIndex(tableName);
    }
  }

  private resolveCandidateRecordIds(index: TableIndex, filters?: Record<string, unknown>): string[] {
    const recordIds = Object.keys(index.records);
    if (!filters || Object.keys(filters).length === 0) {
      return recordIds;
    }

    const indexedCandidates: string[][] = [];

    for (const [field, expectedValue] of Object.entries(filters)) {
      const key = this.indexKey(expectedValue);
      if (key === undefined) {
        return recordIds;
      }

      const fieldIndex = index.fieldValues[field];
      const matches = fieldIndex?.[key];
      if (!matches) {
        return [];
      }

      indexedCandidates.push(matches);
    }

    if (indexedCandidates.length === 0) {
      return recordIds;
    }

    return indexedCandidates.reduce((acc, next) => acc.filter((id) => next.includes(id)));
  }

  private indexKey(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return "null";
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
      return String(value);
    }

    return undefined;
  }

  private schemaFileName(tableName: string): string {
    return `${tableName}/${TABLE_SCHEMA_FILE}`;
  }

  private indexFileName(tableName: string): string {
    return `${tableName}/${TABLE_INDEX_FILE}`;
  }

  private recordFileName(tableName: string, recordId: string): string {
    return `${tableName}/${recordId}.json`;
  }

  private legacySchemaFileName(tableName: string): string {
    return `${tableName}${SCHEMA_SUFFIX}`;
  }

  private legacyIndexFileName(tableName: string): string {
    return `${tableName}${INDEX_SUFFIX}`;
  }

  private parseSqlSchema(sql: string): ParsedSqlTable[] {
    const cleaned = this.stripSqlComments(sql);
    const createTableRegex = /CREATE\s+TABLE\s+([`"\[]?)([\w.-]+)\1\s*\((.*?)\)\s*;/gis;
    const tables: ParsedSqlTable[] = [];

    for (const match of cleaned.matchAll(createTableRegex)) {
      const tableName = (match[2] ?? "").trim();
      const body = match[3] ?? "";
      const parts = this.splitSqlDefinitions(body);
      const columns: Record<string, TableSchemaColumn> = {};
      let primaryKey = "";

      for (const part of parts) {
        const parsedColumn = this.parseSqlDefinition(part.trim());
        if (!parsedColumn) {
          continue;
        }

        if (parsedColumn.kind === "primary-key") {
          primaryKey = parsedColumn.columnName;
          continue;
        }

        columns[parsedColumn.columnName] = parsedColumn.column;
        if (parsedColumn.isPrimaryKey) {
          primaryKey = parsedColumn.columnName;
        }
      }

      if (!primaryKey) {
        throw new ConfigurationError(`Table '${tableName}' is missing a primary key in the SQL schema.`);
      }

      tables.push({ tableName, columns, primaryKey });
    }

    if (tables.length === 0) {
      throw new ConfigurationError("No CREATE TABLE statements were found in the SQL schema.");
    }

    return tables;
  }

  private stripSqlComments(sql: string): string {
    return sql
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/--.*$/gm, "");
  }

  private splitSqlDefinitions(body: string): string[] {
    const parts: string[] = [];
    let current = "";
    let depth = 0;

    for (const char of body) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth = Math.max(0, depth - 1);
      }

      if (char === "," && depth === 0) {
        if (current.trim()) {
          parts.push(current.trim());
        }
        current = "";
        continue;
      }

      current += char;
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  private parseSqlDefinition(
    definition: string
  ): { kind: "column"; columnName: string; column: TableSchemaColumn; isPrimaryKey: boolean } | { kind: "primary-key"; columnName: string } | null {
    const primaryKeyMatch = /^PRIMARY\s+KEY\s*\(([`"\[]?)([\w.-]+)\1\)$/i.exec(definition);
    if (primaryKeyMatch) {
      return { kind: "primary-key", columnName: (primaryKeyMatch[2] ?? "").trim() };
    }

    const columnMatch = /^([`"\[]?)([\w.-]+)\1\s+([\w()0-9,]+)([\s\S]*)$/i.exec(definition);
    if (!columnMatch) {
      return null;
    }

    const columnName = (columnMatch[2] ?? "").trim();
    const sqlType = (columnMatch[3] ?? "").trim();
    const rest = columnMatch[4] ?? "";

    const isPrimaryKey = /PRIMARY\s+KEY/i.test(rest);
    const nullable = !/NOT\s+NULL/i.test(rest);
    const column: TableSchemaColumn = {
      type: this.mapSqlTypeToColumnType(sqlType),
      nullable,
    };

    return { kind: "column", columnName, column, isPrimaryKey };
  }

  private mapSqlTypeToColumnType(sqlType: string): ColumnType {
    const normalized = sqlType.toLowerCase();
    if (
      normalized.includes("int") ||
      normalized.includes("decimal") ||
      normalized.includes("numeric") ||
      normalized.includes("float") ||
      normalized.includes("double") ||
      normalized.includes("real")
    ) {
      return "number";
    }

    if (normalized.includes("bool") || normalized.includes("bit")) {
      return "boolean";
    }

    if (
      normalized.includes("date") ||
      normalized.includes("time")
    ) {
      return "date";
    }

    return "string";
  }
}

export async function createTableDB(db: FileBaseDB): Promise<FileBasedTableDB> {
  return new FileBasedTableDB(db);
}

export interface WriteConflictOptions {
  expectedUpdatedAt?: string;
  onConflict?: "fail" | "overwrite";
}