import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AofWriter } from "../src/aof.js";
import { execute } from "../src/commands.js";
import { encodeArray } from "../src/resp.js";
import { replayAofBuffer, replayAofFile } from "../src/replay.js";
import { Store } from "../src/store.js";

describe("AOF", () => {
  it("logs DELs for maxmemory evictions so replay does not resurrect them", async () => {
    // Each 1-byte key + 1-byte value costs 66 bytes with the +64 overhead.
    const live = new Store(66 * 2);
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-aof-"));
    const file = path.join(dir, "appendonly.aof");
    const writer = new AofWriter(file, 1, "always");
    await writer.open();

    const apply = async (args: string[]) => {
      const result = execute(args, live, false);
      assert.equal(result.response[0], 0x2b /* + */, result.response.toString());
      // Persist every AOF record the command emits (SET/INCR plus any eviction DELs).
      for (const record of result.persistedRecords ?? []) {
        await writer.append(encodeArray(record));
      }
      return result;
    };

    await apply(["SET", "a", "1"]);
    await apply(["SET", "b", "1"]);
    // Touch a so b is LRU; the next SET must evict b.
    assert.equal(live.get("a"), "1");
    await apply(["SET", "c", "1"]);

    assert.equal(live.get("b"), undefined, "b should be evicted from the live store");
    assert.equal(live.get("a"), "1");
    assert.equal(live.get("c"), "1");
    assert.equal(live.ttlCount, 0);

    await writer.close();

    // Replay into a large store so missing DELs would resurrect b.
    const restored = new Store(1024 * 1024);
    const replay = await replayAofFile(file, restored);
    assert.equal(replay.stoppedOnIncompleteTail, false);
    assert.equal(restored.get("b"), undefined, "evicted key must not reappear after AOF replay");
    assert.equal(restored.get("a"), "1");
    assert.equal(restored.get("c"), "1");
    assert.equal(restored.ttlCount, 0);
  });

  it("write then replay restores the same logical state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-aof-"));
    const file = path.join(dir, "appendonly.aof");

    const writer = new AofWriter(file, 1, "always");
    await writer.open();
    await writer.append(encodeArray(["SET", "name", "Mini Redis"]));
    await writer.append(encodeArray(["SET", "n", "0"]));
    await writer.append(encodeArray(["INCR", "n"]));
    await writer.append(encodeArray(["SET", "temp", "1", "PXAT", String(Date.now() + 60_000)]));
    await writer.close();

    const store = new Store(1024 * 1024);
    const result = await replayAofFile(file, store);
    assert.equal(result.stoppedOnIncompleteTail, false);
    assert.equal(store.get("name"), "Mini Redis");
    assert.equal(store.get("n"), "1");
    assert.equal(store.get("temp"), "1");
    assert.ok((store.ttl("temp") ?? -1) > 0);
  });

  it("does not resurrect keys whose PXAT deadline is already past", async () => {
    const past = Date.now() - 1000;
    const data = Buffer.concat([
      encodeArray(["SET", "alive", "yes"]),
      encodeArray(["SET", "ghost", "no", "PXAT", String(past)]),
    ]);

    const store = new Store(1024 * 1024);
    replayAofBuffer(data, store);

    assert.equal(store.get("alive"), "yes");
    assert.equal(store.get("ghost"), undefined);
    assert.equal(store.size, 1);
  });

  it("stops safely on a truncated or corrupted tail", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-aof-"));
    const file = path.join(dir, "appendonly.aof");

    const valid = encodeArray(["SET", "ok", "1"]);
    const truncated = Buffer.from("*3\r\n$3\r\nSET\r\n$1\r\nx\r\n"); // missing value bulk
    await writeFile(file, Buffer.concat([valid, truncated]));

    const store = new Store(1024 * 1024);
    const result = await replayAofFile(file, store);

    assert.equal(result.stoppedOnIncompleteTail, true);
    assert.equal(result.commandsApplied, 1);
    assert.equal(store.get("ok"), "1");
    assert.equal(store.get("x"), undefined);

    // Corrupted framing after a valid prefix also stops without throwing.
    const corrupt = Buffer.concat([valid, Buffer.from("*1\r\n$3\r\nAB\r\n")]); // length says 3, body is 2
    const store2 = new Store(1024 * 1024);
    const corruptResult = replayAofBuffer(corrupt, store2);
    assert.equal(corruptResult.stoppedOnIncompleteTail, true);
    assert.equal(store2.get("ok"), "1");

    // File is still readable for debugging.
    assert.ok((await readFile(file)).length > valid.length);
  });
});
