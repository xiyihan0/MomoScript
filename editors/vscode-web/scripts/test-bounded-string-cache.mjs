import assert from "node:assert/strict";
import { BoundedStringCache } from "../src/boundedStringCache.ts";

assert.throws(() => new BoundedStringCache(0), RangeError);

const cache = new BoundedStringCache(16);
cache.set("a", "aaa");
cache.set("b", "bbb");
assert.equal(cache.get("a"), "aaa", "cache hits must refresh recency");
cache.set("c", "ccc");
assert.equal(cache.get("b"), undefined, "least-recently-used entry must be evicted");
assert.equal(cache.get("a"), "aaa");
assert.equal(cache.get("c"), "ccc");
assert.equal(cache.bytes, 16);

cache.set("a", "oversized");
assert.equal(cache.get("a"), undefined, "oversized replacements must not remain cached");
assert.equal(cache.bytes, 8);
assert.equal(cache.size, 1);

cache.set("c", "x");
assert.equal(cache.get("c"), "x");
assert.equal(cache.bytes, 4, "replacement must update key and value accounting");
cache.clear();
assert.equal(cache.bytes, 0);
assert.equal(cache.size, 0);

const longKeys = new BoundedStringCache(31);
longKeys.set("manifest".repeat(3), "x");
assert.equal(longKeys.size, 0, "an oversized key must not bypass the byte limit");
longKeys.set("1234567", "x");
longKeys.set("7654321", "y");
assert.equal(longKeys.get("1234567"), undefined, "key bytes must participate in LRU eviction");
assert.equal(longKeys.get("7654321"), "y");
assert.equal(longKeys.bytes, 16);

console.log(JSON.stringify({ bounded: true, lru: true, keyAndValueBytes: true }));
