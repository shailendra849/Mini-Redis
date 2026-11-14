import { createWriteStream, fsync as fsyncCallback, type WriteStream } from "node:fs";
import { once } from "node:events";
import { promisify } from "node:util";
import type { AppendFsync } from "./config.js";

const fsync = promisify(fsyncCallback);

type PendingWrite = {
  record: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Keeps the AOF file open and groups nearby records into one append.
 *
 * APPENDFSYNC (mirrors Redis names):
 * - always:   each append flushes + fsyncs; append()'s promise resolves after durability
 * - everysec: batch writes; background fsync ~1/s; append() resolves after the write()
 * - no:       batch writes; never fsync; OS decides when buffers hit disk
 */
export class AofWriter {
  private stream?: WriteStream;
  private fd?: number;
  private pending: PendingWrite[] = [];
  private pendingBytes = 0;
  private queuedByteCount = 0;
  private timer?: NodeJS.Timeout;
  private everysecTimer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly batchDelayMs = 2,
    private readonly appendFsync: AppendFsync = "everysec",
    private readonly batchBytes = 64 * 1024,
  ) {}

  get queuedBytes(): number {
    return this.queuedByteCount;
  }

  get fsyncPolicy(): AppendFsync {
    return this.appendFsync;
  }

  async open(): Promise<void> {
    const stream = createWriteStream(this.filePath, { flags: "a" });
    this.stream = stream;
    const [fd] = await once(stream, "open") as [number];
    this.fd = fd;
    if (this.appendFsync === "everysec") {
      // Flush any in-memory batch, then fsync — about one second of data can be lost.
      this.everysecTimer = setInterval(() => {
        void this.flush()
          .then(() => this.syncToDisk())
          .catch((cause: unknown) => console.error("AOF everysec fsync failed:", cause));
      }, 1000);
      this.everysecTimer.unref();
    }
  }

  append(record: Buffer): Promise<void> {
    if (!this.stream) return Promise.reject(new Error("AOF writer is not open"));

    const promise = new Promise<void>((resolve, reject) => {
      this.pending.push({
        record,
        resolve,
        reject: (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))),
      });
      this.pendingBytes += record.length;
      this.queuedByteCount += record.length;
    });

    if (this.appendFsync === "always") {
      // Durability before the caller continues — no batching delay.
      void this.flush();
    } else if (this.pendingBytes >= this.batchBytes) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.batchDelayMs);
    }

    return promise;
  }

  async close(): Promise<void> {
    if (this.everysecTimer) clearInterval(this.everysecTimer);
    this.everysecTimer = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    await this.writing;
    if (this.appendFsync !== "no") {
      await this.syncToDisk().catch(() => undefined);
    }
    const stream = this.stream;
    this.stream = undefined;
    this.fd = undefined;
    if (stream) {
      const finished = once(stream, "finish");
      stream.end();
      await finished;
    }
  }

  private flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return this.writing;

    const batch = this.pending;
    const batchBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const data = Buffer.concat(batch.map(({ record }) => record), batchBytes);
    const syncAfterWrite = this.appendFsync === "always";

    this.writing = this.writing
      .then(async () => {
        if (!this.stream) throw new Error("AOF writer is closed");
        await new Promise<void>((resolve, reject) => {
          this.stream!.write(data, (cause?: Error | null) => {
            if (cause) reject(cause);
            else resolve();
          });
        });
        if (syncAfterWrite) {
          if (typeof this.fd !== "number") throw new Error("AOF file descriptor is unavailable");
          await fsync(this.fd);
        }
      })
      .then(
        () => {
          this.queuedByteCount -= batchBytes;
          for (const item of batch) item.resolve();
        },
        (cause: unknown) => {
          const failure = cause instanceof Error ? cause : new Error(String(cause));
          this.queuedByteCount -= batchBytes;
          for (const item of batch) item.reject(failure);
          throw failure;
        },
      );

    // Preserve the error for callers waiting on this batch, while allowing a
    // later flush attempt to report its own result independently.
    const currentWrite = this.writing;
    void currentWrite.catch(() => undefined);
    return currentWrite;
  }

  private syncToDisk(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (typeof this.fd !== "number") return;
      await fsync(this.fd);
    });
    const current = this.writing;
    void current.catch(() => undefined);
    return current;
  }
}
