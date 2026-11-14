import path from "node:path";

export type AppendFsync = "always" | "everysec" | "no";

function readAppendFsync(raw: string | undefined): AppendFsync {
  const value = (raw ?? "everysec").toLowerCase();
  if (value === "always" || value === "everysec" || value === "no") return value;
  return "everysec";
}

/** Central place for env-based settings. APPENDFSYNC is read now; Step 3 wires it into AOF. */
export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 6379),
  maxMemoryMb: Math.max(1, Number(process.env.MAXMEMORY_MB ?? 64)),
  get maxMemoryBytes(): number {
    return this.maxMemoryMb * 1024 * 1024;
  },
  aofPath: path.resolve(process.env.AOF_FILE ?? "appendonly.aof"),
  aofBatchMs: Math.max(1, Number(process.env.AOF_BATCH_MS ?? 2)),
  appendFsync: readAppendFsync(process.env.APPENDFSYNC),
} as const;
