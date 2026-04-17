import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCache } from "../src/cache";

test("InMemoryCache stores and retrieves values", () => {
  const cache = new InMemoryCache();
  cache.set("k1", { value: 42 });

  assert.deepEqual(cache.get<{ value: number }>("k1"), { value: 42 });
});

test("InMemoryCache expires values with ttl", async () => {
  const cache = new InMemoryCache();
  cache.set("k2", "temp", 20);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(cache.get("k2"), undefined);
});

test("InMemoryCache delete and clear remove entries", () => {
  const cache = new InMemoryCache();
  cache.set("a", 1);
  cache.set("b", 2);

  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);

  cache.clear();
  assert.equal(cache.get("b"), undefined);
});
