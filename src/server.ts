import net from "node:net";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AofWriter } from "./aof.js";
import { execute } from "./commands.js";
import { config, type AppendFsync } from "./config.js";
import { encodeArray, encodeError, parseCommand } from "./resp.js";
import { replayAofFile } from "./replay.js";
import { Store } from "./store.js";

const AOF_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const AOF_LOW_WATER_BYTES = 1024 * 1024;

export type ServerOptions = {
  host?: string;
  port?: number;
  maxMemoryBytes?: number;
  aofPath?: string;
  aofBatchMs?: number;
  appendFsync?: AppendFsync;
  /** Skip connection/listen logs (tests). */
  quiet?: boolean;
};

export type RunningServer = {
  host: string;
  port: number;
  close(): Promise<void>;
};

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? config.host;
  const listenPort = options.port ?? config.port;
  const maxMemoryBytes = options.maxMemoryBytes ?? config.maxMemoryBytes;
  const aofPath = path.resolve(options.aofPath ?? config.aofPath);
  const aofBatchMs = options.aofBatchMs ?? config.aofBatchMs;
  const appendFsync = options.appendFsync ?? config.appendFsync;
  const quiet = options.quiet ?? false;

  const store = new Store(maxMemoryBytes);
  const aofWriter = new AofWriter(aofPath, aofBatchMs, appendFsync);
  let aofFailed = false;
  let commandQueue: Promise<void> = Promise.resolve();
  let expireTimer: NodeJS.Timeout | undefined;

  await mkdir(path.dirname(aofPath), { recursive: true });
  const replay = await replayAofFile(aofPath, store);
  if (replay.stoppedOnIncompleteTail && !quiet) {
    console.warn("AOF ends with an incomplete or invalid record; replay stopped.");
  }
  await aofWriter.open();
  expireTimer = setInterval(() => store.activeExpire(), 1000);
  expireTimer.unref();

  const server = net.createServer((socket) => {
    if (!quiet) console.log(`Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
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
        commandQueue = commandQueue.then(async () => {
          if (socket.destroyed) return;
          if (aofFailed) {
            socket.write(encodeError("AOF writer failed"));
            return;
          }
          const result = execute(parsed.args, store);
          if (result.persistedArgs) {
            const write = aofWriter.append(encodeArray(result.persistedArgs));
            if (aofWriter.queuedBytes >= AOF_HIGH_WATER_BYTES) socket.pause();
            const settled = write.then(() => {
              if (!socket.destroyed && aofWriter.queuedBytes < AOF_LOW_WATER_BYTES) socket.resume();
            }).catch((cause: unknown) => {
              aofFailed = true;
              console.error("AOF write failed:", cause);
              server.close();
              throw cause;
            });
            // always: wait until write + fsync finish. everysec/no: reply as soon as queued.
            if (appendFsync === "always") await settled;
            else void settled;
          }
          socket.write(result.response);
        }).catch((cause: unknown) => {
          console.error("Command processing error:", cause);
          if (!socket.destroyed) socket.write(encodeError("internal server error"));
        });
      }
    });

    socket.on("close", () => {
      if (!quiet) console.log("Client disconnected");
    });
    socket.on("error", (cause) => console.error("Client socket error:", cause.message));
  });

  server.on("error", (cause) => console.error("Server error:", cause.message));

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(listenPort, host, () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("failed to bind TCP port"));
        return;
      }
      if (!quiet) {
        console.log(`Mini Redis listening on ${host}:${address.port}`);
        console.log(`AOF: ${aofPath} | appendfsync: ${appendFsync} | maxmemory: ${Math.round(maxMemoryBytes / (1024 * 1024))} MB`);
      }
      resolve(address.port);
    });
    server.once("error", reject);
  });

  return {
    host,
    port,
    async close() {
      if (expireTimer) clearInterval(expireTimer);
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      });
      await commandQueue.catch(() => undefined);
      await aofWriter.close();
    },
  };
}

/** CLI entry: bind configured host/port and exit cleanly on Ctrl+C. */
export async function start(): Promise<void> {
  const running = await startServer();
  process.on("SIGINT", () => {
    void running.close().finally(() => process.exit(0));
  });
}
