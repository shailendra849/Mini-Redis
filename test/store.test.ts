import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execute } from "../src/commands.js";
import { Store } from "../src/store.js";

describe("Store", () => {
  it("evicts least-recently-used keys and refreshes recency on GET", () => {
    // Each 1-byte key + 1-byte value costs 66 bytes with the +64 overhead.
    const store = new Store(66 * 2);
    store.set("a", "1");
    store.set("b", "1");
    assert.equal(store.get("a"), "1"); // a becomes newest
    store.set("c", "1"); // must evict oldest = b

    assert.equal(store.get("b"), undefined);
    assert.equal(store.get("a"), "1");
    assert.equal(store.get("c"), "1");
  });

  it("rejects values that alone exceed maxmemory", () => {
    const store = new Store(80);
    assert.throws(() => store.set("k", "x".repeat(100)), /maxmemory/);
  });

  it("lazy-expires keys on access", () => {
    const store = new Store(1024);
    store.set("late", "x", Date.now() - 1);
    assert.equal(store.ttlCount, 1);
    assert.equal(store.get("late"), undefined);
    assert.equal(store.ttlCount, 0);
    assert.equal(store.size, 0);
  });

  it("active-expires keys from the TTL index without scanning all keys", () => {
    const store = new Store(64 * 1024 * 1024);
    for (let i = 0; i < 200; i += 1) store.set(`keep${i}`, "v");
    for (let i = 0; i < 40; i += 1) store.set(`die${i}`, "v", Date.now() - 1);
    assert.equal(store.ttlCount, 40);

    let removed = 0;
    for (let round = 0; round < 50 && store.ttlCount > 0; round += 1) {
      removed += store.activeExpire(20, 5);
    }

    assert.ok(removed > 0);
    assert.equal(store.ttlCount, 0);
    assert.equal(store.size, 200);
    assert.equal(store.get("keep0"), "v");
  });

  it("INCR handles missing, integer, and non-integer values", () => {
    const store = new Store(1024);

    const missing = execute(["INCR", "n"], store);
    assert.equal(missing.response.toString("utf8"), ":1\r\n");

    const again = execute(["INCR", "n"], store);
    assert.equal(again.response.toString("utf8"), ":2\r\n");

    store.set("word", "hello");
    const bad = execute(["INCR", "word"], store);
    assert.match(bad.response.toString("utf8"), /not an integer/);
  });

  it("TTL and EXPIRE return Redis-like status codes", () => {
    const store = new Store(1024);

    assert.equal(store.ttl("missing"), -2);
    store.set("k", "v");
    assert.equal(store.ttl("k"), -1);

    assert.equal(store.expire("missing", Date.now() + 5000), false);
    assert.equal(store.expire("k", Date.now() + 5000), true);
    const ttl = store.ttl("k");
    assert.ok(ttl >= 4 && ttl <= 5);

    const expireCmd = execute(["EXPIRE", "k", "10"], store);
    assert.equal(expireCmd.response.toString("utf8"), ":1\r\n");

    const missingExpire = execute(["EXPIRE", "nope", "10"], store);
    assert.equal(missingExpire.response.toString("utf8"), ":0\r\n");
  });
});
