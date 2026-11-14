import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeArray, encodeBulkString, parseCommand } from "../src/resp.js";

describe("RESP parser", () => {
  it("assembles a command delivered one byte at a time", () => {
    const full = encodeArray(["SET", "k", "v"]);
    let pending = Buffer.alloc(0);
    let complete = null as ReturnType<typeof parseCommand> | null;

    for (const byte of full) {
      pending = Buffer.concat([pending, Buffer.from([byte])]);
      const parsed = parseCommand(pending);
      if (parsed.status === "incomplete") continue;
      complete = parsed;
      break;
    }

    assert.equal(complete?.status, "complete");
    if (complete?.status === "complete") {
      assert.deepEqual(complete.args, ["SET", "k", "v"]);
      assert.equal(complete.consumed, full.length);
    }
  });

  it("parses two commands from one chunk", () => {
    const first = encodeArray(["PING"]);
    const second = encodeArray(["GET", "name"]);
    const chunk = Buffer.concat([first, second]);

    const a = parseCommand(chunk);
    assert.equal(a.status, "complete");
    if (a.status !== "complete") return;
    assert.deepEqual(a.args, ["PING"]);

    const b = parseCommand(chunk.subarray(a.consumed));
    assert.equal(b.status, "complete");
    if (b.status !== "complete") return;
    assert.deepEqual(b.args, ["GET", "name"]);
    assert.equal(a.consumed + b.consumed, chunk.length);
  });

  it("keeps embedded CRLF inside bulk string payloads", () => {
    const value = "hello\r\nworld";
    const parsed = parseCommand(encodeArray(["SET", "k", value]));
    assert.equal(parsed.status, "complete");
    if (parsed.status !== "complete") return;
    assert.equal(parsed.args[2], value);
  });

  it("parses an empty bulk string", () => {
    const parsed = parseCommand(encodeArray(["SET", "k", ""]));
    assert.equal(parsed.status, "complete");
    if (parsed.status !== "complete") return;
    assert.equal(parsed.args[2], "");
    assert.equal(encodeBulkString("").toString("utf8"), "$0\r\n\r\n");
  });

  it("reports incomplete input without consuming a partial command", () => {
    const partial = Buffer.from("*2\r\n$3\r\nGET\r\n");
    const parsed = parseCommand(partial);
    assert.equal(parsed.status, "incomplete");
  });

  it("rejects malformed array and bulk framing", () => {
    const badLen = parseCommand(Buffer.from("*x\r\n"));
    assert.equal(badLen.status, "invalid");

    const badBulk = parseCommand(Buffer.from("*1\r\n:1\r\n"));
    assert.equal(badBulk.status, "invalid");

    // Enough bytes for the declared bulk length, but the trailing CRLF is wrong.
    const missingCrlf = parseCommand(Buffer.from("*1\r\n$3\r\nFOOxx"));
    assert.equal(missingCrlf.status, "invalid");

    // Body is long enough, yet the two bytes after the payload are not CRLF.
    const brokenTail = parseCommand(Buffer.from("*1\r\n$2\r\nABXX"));
    assert.equal(brokenTail.status, "invalid");
  });

  it("parses a large bulk payload", () => {
    const value = "x".repeat(100_000);
    const encoded = encodeArray(["SET", "big", value]);
    const parsed = parseCommand(encoded);
    assert.equal(parsed.status, "complete");
    if (parsed.status !== "complete") return;
    assert.equal(parsed.args[2]?.length, 100_000);
    assert.equal(parsed.consumed, encoded.length);
  });
});
