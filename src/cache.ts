import { CacheStore } from "./types";
import sqlite3 from "sqlite3";

type CacheEntry<T> = {
  value: T;
  expiresAt?: number;
};

export class InMemoryCache implements CacheStore {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    const entry: CacheEntry<unknown> = ttlMs ? { value, expiresAt: Date.now() + ttlMs } : { value };
    this.store.set(key, entry);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  dispose(): void {
    this.clear();
  }
}

export class SQLiteCache implements CacheStore {
  readonly engine = "sqlite";
  private readonly memory = new InMemoryCache();
  private readonly db: sqlite3.Database;

  constructor(dbPath = ":memory:") {
    this.db = new sqlite3.Database(dbPath);
    this.db.serialize(() => {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS cache (cacheKey TEXT PRIMARY KEY, cacheValue TEXT NOT NULL, expiresAt INTEGER NULL)"
      );
      this.db.all("SELECT cacheKey, cacheValue, expiresAt FROM cache", (error, rows) => {
        if (error || !rows) {
          return;
        }

        for (const row of rows as Array<{ cacheKey: string; cacheValue: string; expiresAt: number | null }>) {
          try {
            const parsed = JSON.parse(row.cacheValue) as unknown;
            if (row.expiresAt && Date.now() > row.expiresAt) {
              this.memory.delete(row.cacheKey);
              this.db.run("DELETE FROM cache WHERE cacheKey = ?", [row.cacheKey]);
            } else {
              const ttlMs = row.expiresAt ? Math.max(row.expiresAt - Date.now(), 1) : undefined;
              this.memory.set(row.cacheKey, parsed, ttlMs);
            }
          } catch {
            this.db.run("DELETE FROM cache WHERE cacheKey = ?", [row.cacheKey]);
          }
        }
      });
    });
  }

  get<T>(key: string): T | undefined {
    return this.memory.get<T>(key);
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    this.memory.set(key, value, ttlMs);
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;

    let serialized = "null";
    try {
      serialized = JSON.stringify(value);
    } catch {
      return;
    }

    this.db.run(
      "INSERT INTO cache(cacheKey, cacheValue, expiresAt) VALUES(?,?,?) ON CONFLICT(cacheKey) DO UPDATE SET cacheValue=excluded.cacheValue, expiresAt=excluded.expiresAt",
      [key, serialized, expiresAt]
    );
  }

  delete(key: string): void {
    this.memory.delete(key);
    this.db.run("DELETE FROM cache WHERE cacheKey = ?", [key]);
  }

  clear(): void {
    this.memory.clear();
    this.db.run("DELETE FROM cache");
  }

  dispose(): void {
    this.memory.clear();
    this.db.close((error) => {
      if (error) {
        // Best-effort cleanup; consumers already disconnected.
      }
    });
  }
}
