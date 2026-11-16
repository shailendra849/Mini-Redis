/**
 * Raw-socket load generator for Mini Redis (and any RESP server including Redis).
 *
 * Example:
 *   npm run bench -- --connections 10 --requests 20000 --pipeline 1 --mix set
 */
import { access, appendFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeArray } from "../src/resp.js";

type Mix = "set" | "get" | "mixed";

type Options = {
  host: string;
  port: number;
  connections: number;
  requests: number;
  pipeline: number;
  mix: Mix;
  keyspace: number;
  valueBytes: number;
  label: string;
  notes: string;
  warmup: boolean;
  csvPath: string;
};

function usage(): never {
  console.log(`Usage: npm run bench -- [options]

Options:
  --host <addr>          default 127.0.0.1
  --port <n>             default 6379
  --connections <n>      parallel TCP clients (default 10)
  --requests <n>         total commands in the timed run (default 20000)
  --pipeline <n>         commands written before reading replies (default 1)
  --mix set|get|mixed    command mix (default set; mixed = 50/50; alias: 50/50)
  --keyspace <n>         distinct keys (default 1000)
  --value-bytes <n>      SET value size (default 32)
  --label <name>         row label in CSV (default mini-redis)
  --notes <text>         free-form CSV note (e.g. APPENDFSYNC=everysec)
  --no-warmup            skip pre-SETting keys for get/mixed
  --csv <path>           results file (default bench/results.csv)
`);
  process.exit(1);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function opt(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for --${name}`);
    usage();
  }
  return value;
}

function optInt(name: string, fallback: number): number {
  const raw = opt(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Invalid number for --${name}: ${raw}`);
    process.exit(1);
  }
  return value;
}

function parseOptions(): Options {
  if (flag("help") || flag("h")) usage();
  const mixRaw = opt("mix", "set").toLowerCase();
  const mix: Mix = mixRaw === "50/50" || mixRaw === "50-50"
    ? "mixed"
    : mixRaw === "set" || mixRaw === "get" || mixRaw === "mixed"
      ? mixRaw
      : (() => {
        console.error("--mix must be set, get, mixed, or 50/50");
        process.exit(1);
      })();
  const benchDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    host: opt("host", "127.0.0.1"),
    port: optInt("port", 6379),
    connections: Math.max(1, optInt("connections", 10)),
    requests: Math.max(1, optInt("requests", 20_000)),
    pipeline: Math.max(1, optInt("pipeline", 1)),
    mix,
    keyspace: Math.max(1, optInt("keyspace", 1000)),
    valueBytes: Math.max(1, optInt("value-bytes", 32)),
    label: opt("label", "mini-redis"),
    notes: opt("notes", ""),
    warmup: !flag("no-warmup"),
    csvPath: path.resolve(opt("csv", path.join(benchDir, "results.csv"))),
  };
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const rank = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return sortedMs[rank]!;
}

/** Incremental RESP reply reader for + / - / : / $ payloads. */
class ReplyReader {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private failed: Error | null = null;

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.wake();
  }

  fail(cause: Error): void {
    this.failed = cause;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private tryRead(): Buffer | null {
    const buf = this.buffer;
    if (buf.length < 3) return null;
    const type = buf[0];

    if (type === 0x2b || type === 0x2d || type === 0x3a) {
      const end = buf.indexOf("\r\n");
      if (end === -1) return null;
      const frame = buf.subarray(0, end + 2);
      this.buffer = buf.subarray(end + 2);
      return frame;
    }

    if (type === 0x24) {
      const headerEnd = buf.indexOf("\r\n");
      if (headerEnd === -1) return null;
      const length = Number(buf.toString("ascii", 1, headerEnd));
      if (!Number.isFinite(length)) throw new Error("invalid bulk length in reply");
      if (length < 0) {
        const frame = buf.subarray(0, headerEnd + 2);
        this.buffer = buf.subarray(headerEnd + 2);
        return frame;
      }
      const total = headerEnd + 2 + length + 2;
      if (buf.length < total) return null;
      const frame = buf.subarray(0, total);
      this.buffer = buf.subarray(total);
      return frame;
    }

    throw new Error(`unsupported reply type byte ${type}`);
  }

  async readOne(): Promise<Buffer> {
    while (true) {
      if (this.failed) throw this.failed;
      const frame = this.tryRead();
      if (frame) {
        if (frame[0] === 0x2d) {
          throw new Error(`server error: ${frame.toString("utf8").trim()}`);
        }
        return frame;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function openSession(host: string, port: number): Promise<{
  socket: net.Socket;
  reader: ReplyReader;
  close(): Promise<void>;
}> {
  const socket = await connect(host, port);
  const reader = new ReplyReader();
  let intentionalClose = false;
  socket.on("data", (chunk) => reader.push(chunk));
  socket.on("error", (cause) => reader.fail(cause));
  socket.on("close", () => {
    if (!intentionalClose) reader.fail(new Error("connection closed before replies finished"));
  });
  return {
    socket,
    reader,
    close: async () => {
      intentionalClose = true;
      if (!socket.destroyed) {
        socket.end();
        await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      }
    },
  };
}

function buildCommand(mix: Mix, keyspace: number, value: string, index: number): Buffer {
  const key = `k:${index % keyspace}`;
  if (mix === "set") return encodeArray(["SET", key, value]);
  if (mix === "get") return encodeArray(["GET", key]);
  return index % 2 === 0
    ? encodeArray(["SET", key, value])
    : encodeArray(["GET", key]);
}

async function warmup(options: Options, value: string): Promise<void> {
  if (!options.warmup || options.mix === "set") return;
  const session = await openSession(options.host, options.port);
  const pipeline = Math.max(options.pipeline, 16);
  for (let offset = 0; offset < options.keyspace; ) {
    const batch = Math.min(pipeline, options.keyspace - offset);
    for (let i = 0; i < batch; i += 1) {
      session.socket.write(encodeArray(["SET", `k:${offset + i}`, value]));
    }
    for (let i = 0; i < batch; i += 1) await session.reader.readOne();
    offset += batch;
  }
  await session.close();
}

async function runWorker(
  options: Options,
  value: string,
  claim: () => number,
  latenciesMs: number[],
): Promise<number> {
  const session = await openSession(options.host, options.port);
  let completed = 0;
  let seq = 0;

  while (true) {
    const batch = claim();
    if (batch === 0) break;

    const sentAt: number[] = [];
    for (let i = 0; i < batch; i += 1) {
      sentAt.push(performance.now());
      session.socket.write(buildCommand(options.mix, options.keyspace, value, seq));
      seq += 1;
    }

    for (let i = 0; i < batch; i += 1) {
      await session.reader.readOne();
      latenciesMs.push(performance.now() - sentAt[i]!);
      completed += 1;
    }
  }

  await session.close();
  return completed;
}

async function ensureCsvHeader(csvPath: string): Promise<void> {
  try {
    await access(csvPath);
  } catch {
    const header = [
      "timestamp",
      "label",
      "host",
      "port",
      "connections",
      "requests",
      "pipeline",
      "mix",
      "keyspace",
      "value_bytes",
      "ops_per_sec",
      "p50_ms",
      "p95_ms",
      "p99_ms",
      "notes",
    ].join(",") + "\n";
    await writeFile(csvPath, header, "utf8");
  }
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

async function appendResult(options: Options, stats: {
  opsPerSec: number;
  p50: number;
  p95: number;
  p99: number;
}): Promise<void> {
  await ensureCsvHeader(options.csvPath);
  const row = [
    new Date().toISOString(),
    csvEscape(options.label),
    options.host,
    options.port,
    options.connections,
    options.requests,
    options.pipeline,
    options.mix,
    options.keyspace,
    options.valueBytes,
    stats.opsPerSec.toFixed(2),
    stats.p50.toFixed(3),
    stats.p95.toFixed(3),
    stats.p99.toFixed(3),
    csvEscape(options.notes),
  ].join(",") + "\n";
  await appendFile(options.csvPath, row, "utf8");
}

async function main(): Promise<void> {
  const options = parseOptions();
  const value = "x".repeat(options.valueBytes);

  console.log(
    `Benchmark target ${options.host}:${options.port} | connections=${options.connections} ` +
      `requests=${options.requests} pipeline=${options.pipeline} mix=${options.mix}`,
  );

  await warmup(options, value);

  let remaining = options.requests;
  const claim = (): number => {
    if (remaining <= 0) return 0;
    const take = Math.min(options.pipeline, remaining);
    remaining -= take;
    return take;
  };

  const latenciesMs: number[] = [];
  const started = performance.now();
  const workers = Array.from({ length: options.connections }, () =>
    runWorker(options, value, claim, latenciesMs),
  );
  const counts = await Promise.all(workers);
  const elapsedMs = performance.now() - started;
  const completed = counts.reduce((sum, n) => sum + n, 0);

  if (completed !== options.requests) {
    throw new Error(`expected ${options.requests} completions, got ${completed}`);
  }

  latenciesMs.sort((a, b) => a - b);
  const opsPerSec = completed / (elapsedMs / 1000);
  const p50 = percentile(latenciesMs, 50);
  const p95 = percentile(latenciesMs, 95);
  const p99 = percentile(latenciesMs, 99);

  console.log(`Completed ${completed} requests in ${(elapsedMs / 1000).toFixed(3)}s`);
  console.log(`Throughput: ${opsPerSec.toFixed(2)} ops/sec`);
  console.log(`Latency ms: p50=${p50.toFixed(3)} p95=${p95.toFixed(3)} p99=${p99.toFixed(3)}`);

  await appendResult(options, { opsPerSec, p50, p95, p99 });
  console.log(`Appended results to ${options.csvPath}`);
}

void main().catch((cause: unknown) => {
  console.error("Benchmark failed:", cause);
  process.exitCode = 1;
});
