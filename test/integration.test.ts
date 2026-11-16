import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/server.js";
import { sendCommand, sendRaw } from "./helpers.js";

describe("integration (TCP + RESP)", () => {
  let server: RunningServer;
  let aofDir: string;

  before(async () => {
    aofDir = await mkdtemp(path.join(os.tmpdir(), "mini-redis-int-"));
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      aofPath: path.join(aofDir, "appendonly.aof"),
      appendFsync: "no",
      aofBatchMs: 1,
      maxMemoryBytes: 16 * 1024 * 1024,
      quiet: true,
    });
  });

  after(async () => {
    await server.close();
    await rm(aofDir, { recursive: true, force: true });
  });

  it("answers PING, SET/GET, DEL, EXISTS, INCR, EXPIRE/TTL", async () => {
    assert.equal(await sendCommand(server.port, ["PING"]), "+PONG\r\n");
    assert.equal(await sendCommand(server.port, ["PING", "hi"]), "$2\r\nhi\r\n");

    assert.equal(await sendCommand(server.port, ["SET", "name", "Mini Redis"]), "+OK\r\n");
    assert.equal(await sendCommand(server.port, ["GET", "name"]), "$10\r\nMini Redis\r\n");

    assert.equal(await sendCommand(server.port, ["EXISTS", "name", "missing"]), ":1\r\n");
    assert.equal(await sendCommand(server.port, ["INCR", "counter"]), ":1\r\n");
    assert.equal(await sendCommand(server.port, ["INCR", "counter"]), ":2\r\n");

    assert.equal(await sendCommand(server.port, ["EXPIRE", "name", "60"]), ":1\r\n");
    const ttl = await sendCommand(server.port, ["TTL", "name"]);
    assert.match(ttl, /^:([1-9]|[1-5][0-9]|60)\r\n$/);

    assert.equal(await sendCommand(server.port, ["DEL", "name", "counter"]), ":2\r\n");
    assert.equal(await sendCommand(server.port, ["GET", "name"]), "$-1\r\n");
  });

  it("rejects unknown commands and wrong arity over a raw socket", async () => {
    const unknown = await sendCommand(server.port, ["NOTACMD"]);
    assert.match(unknown, /unknown command/);

    const badGet = await sendCommand(server.port, ["GET"]);
    assert.match(badGet, /usage: GET/);

    const badSet = await sendCommand(server.port, ["SET", "only-one-arg"]);
    assert.match(badSet, /usage: SET/);

    const badPing = await sendCommand(server.port, ["PING", "a", "b"]);
    assert.match(badPing, /wrong number of arguments/);
  });

  it("returns an error for malformed RESP on the wire", async () => {
    const reply = await sendRaw(server.port, Buffer.from("*1\r\n:99\r\n"));
    assert.match(reply, /^-ERR /);
  });

  it("DEL of a missing key returns 0", async () => {
    assert.equal(await sendCommand(server.port, ["DEL", "does-not-exist"]), ":0\r\n");
  });

  it("SET/GET round-trip a large value", async () => {
    const value = "L".repeat(20_000);
    assert.equal(await sendCommand(server.port, ["SET", "big", value]), "+OK\r\n");
    const got = await sendCommand(server.port, ["GET", "big"]);
    assert.equal(got, `$${value.length}\r\n${value}\r\n`);
  });
});
