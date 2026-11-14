import { createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";

type PendingWrite = {
  record: Buffer;
  resolve: () => void;
  reject: (error: Error) => void;
};

/** Keeps the AOF file open and groups nearby records into one append. */
export class AofWriter {
  private stream?: WriteStream;
  private pending: PendingWrite[] = [];
  private pendingBytes = 0;
  private queuedByteCount = 0;
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly batchDelayMs = 2,
    private readonly batchBytes = 64 * 1024,
  ) {}

  get queuedBytes(): number {
    return this.queuedByteCount;
  }

  async open(): Promise<void> {
    const stream = createWriteStream(this.filePath, { flags: "a" });
    this.stream = stream;
    await once(stream, "open");
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

    if (this.pendingBytes >= this.batchBytes) {
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    await this.writing;
    const stream = this.stream;
    this.stream = undefined;
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

    this.writing = this.writing
      .then(async () => {
        if (!this.stream) throw new Error("AOF writer is closed");
        await new Promise<void>((resolve, reject) => {
          this.stream!.write(data, (cause?: Error | null) => {
            if (cause) reject(cause);
            else resolve();
          });
        });
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
}
