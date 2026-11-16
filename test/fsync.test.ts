import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AofWriter } from "../src/aof.js";
import { startServer } from "../src/server.js";
import { encodeArray } from "../src/resp.js";
import { sendCommand } from "./helpers.js";

describe("APPENDFSYNC", () => {
  it("always: append() resolves only after the record is on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-fsync-"));
    const file = path.join(dir, "appendonly.aof");
    const writer = new AofWriter(file, 50, "always");
    await writer.open();

    const record = encodeArray(["SET", "durable", "1"]);
    await writer.append(record);

    const onDisk = await readFile(file);
    assert.ok(onDisk.equals(record), "always must fsync/write before append resolves");
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("everysec/no: append can sit in the batch before the file grows", async () => {
    for (const policy of ["everysec", "no"] as const) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-fsync-"));
      const file = path.join(dir, "appendonly.aof");
      // Long batch delay so we can observe the queued-but-not-flushed window.
      const writer = new AofWriter(file, 60_000, policy);
      await writer.open();

      const pending = writer.append(encodeArray(["SET", "queued", "1"]));
      const beforeFlush = await readFile(file);
      assert.equal(beforeFlush.length, 0, `${policy}: record should still be buffered`);

      await writer.close(); // flushes
      await pending;
      const after = await readFile(file);
      assert.ok(after.length > 0, `${policy}: close must flush the batch`);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("server always: client OK means the AOF already contains the SET", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-fsync-"));
    const aofPath = path.join(dir, "appendonly.aof");
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      aofPath,
      appendFsync: "always",
      quiet: true,
      maxMemoryBytes: 16 * 1024 * 1024,
    });

    try {
      assert.equal(await sendCommand(server.port, ["SET", "k", "v"]), "+OK\r\n");
      const disk = await readFile(aofPath);
      assert.match(disk.toString("utf8"), /SET/);
      assert.match(disk.toString("utf8"), /\$1\r\nk\r\n/);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("server no: client can get OK before the AOF batch hits disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-fsync-"));
    const aofPath = path.join(dir, "appendonly.aof");
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      aofPath,
      appendFsync: "no",
      aofBatchMs: 60_000,
      quiet: true,
      maxMemoryBytes: 16 * 1024 * 1024,
    });

    try {
      assert.equal(await sendCommand(server.port, ["SET", "k", "v"]), "+OK\r\n");
      const disk = await readFile(aofPath);
      assert.equal(disk.length, 0, "reply is sent when queued, before the delayed batch flush");
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
