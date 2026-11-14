import net from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AofWriter } from "./aof.js";
import { execute } from "./commands.js";
import { config } from "./config.js";
import { encodeArray, encodeError, parseCommand } from "./resp.js";
import { Store } from "./store.js";

const AOF_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const AOF_LOW_WATER_BYTES = 1024 * 1024;

const store = new Store(config.maxMemoryBytes);
const aofWriter = new AofWriter(config.aofPath, config.aofBatchMs);
let aofFailed = false;

// Redis executes commands one at a time; this also preserves AOF ordering.
let commandQueue: Promise<void> = Promise.resolve();

async function replayAof(): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(config.aofPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }

  let offset = 0;
  while (offset < data.length) {
    const parsed = parseCommand(data.subarray(offset));
    if (parsed.status !== "complete") {
      console.warn("AOF ends with an incomplete or invalid record; replay stopped.");
      break;
    }
    offset += parsed.consumed;
    const result = execute(parsed.args, store, true).response;
    if (result[0] === 0x2d) console.warn(`Skipped invalid AOF command: ${result.toString("utf8").trim()}`);
  }
}

const server = net.createServer((socket) => {
  console.log(`Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
  let pending = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length > 0) {
      const parsed = parseCommand(pending);
      if (parsed.status === "incomplete") break;
      pending = pending.subarray(parsed.consumed);
      if (parsed.status === "invalid") {
        socket.write(encodeError(parsed.message));
        continue;
      }
      commandQueue = commandQueue.then(() => {
        if (socket.destroyed) return;
        if (aofFailed) {
          socket.write(encodeError("AOF writer failed"));
          return;
        }
        const result = execute(parsed.args, store);
        if (result.persistedArgs) {
          const write = aofWriter.append(encodeArray(result.persistedArgs));
          if (aofWriter.queuedBytes >= AOF_HIGH_WATER_BYTES) socket.pause();
          void write.then(() => {
            if (!socket.destroyed && aofWriter.queuedBytes < AOF_LOW_WATER_BYTES) socket.resume();
          }).catch((cause: unknown) => {
            aofFailed = true;
            console.error("AOF write failed:", cause);
            server.close();
          });
        }
        // Replies are sent once the AOF writer has accepted the record into
        // its bounded-in-practice batch queue, not after the disk write ends.
        socket.write(result.response);
      }).catch((cause: unknown) => {
        console.error("Command processing error:", cause);
        if (!socket.destroyed) socket.write(encodeError("internal server error"));
      });
    }
  });

  socket.on("close", () => console.log("Client disconnected"));
  socket.on("error", (cause) => console.error("Client socket error:", cause.message));
});

server.on("error", (cause) => console.error("Server error:", cause.message));

process.on("SIGINT", () => {
  server.close();
  void commandQueue.then(() => aofWriter.close()).finally(() => process.exit(0));
});

export async function start(): Promise<void> {
  await mkdir(path.dirname(config.aofPath), { recursive: true });
  await replayAof();
  await aofWriter.open();
  setInterval(() => store.activeExpire(), 1000).unref();
  server.listen(config.port, config.host, () => {
    console.log(`Mini Redis listening on ${config.host}:${config.port}`);
    console.log(`AOF: ${config.aofPath} | maxmemory: ${config.maxMemoryMb} MB`);
  });
}
