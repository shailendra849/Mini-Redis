import {
  encodeBulkString,
  encodeError,
  encodeInteger,
  encodeNullBulk,
  encodeSimpleString,
} from "./resp.js";
import type { Store } from "./store.js";

export type ExecutionResult = {
  response: Buffer;
  /** AOF records in order. Empty/omitted when replaying or for read-only commands. */
  persistedRecords?: string[][];
};

type CommandHandler = (params: string[], store: Store) => ExecutionResult;

/** Primary mutation first, then one DEL per maxmemory eviction (Redis-style). */
function recordsWithEvictions(primary: string[], evicted: string[]): string[][] {
  const records: string[][] = [primary];
  for (const key of evicted) records.push(["DEL", key]);
  return records;
}

const ping: CommandHandler = (params) => {
  if (params.length > 1) return { response: encodeError("wrong number of arguments for 'ping'") };
  return {
    response: params.length ? encodeBulkString(params[0]) : encodeSimpleString("PONG"),
  };
};

const set: CommandHandler = (params, store) => {
  if (params.length !== 2 && params.length !== 4) {
    return { response: encodeError("usage: SET key value [EX seconds|PX milliseconds]") };
  }
  const [key, value, option, rawTtl] = params;
  let expiresAt: number | undefined;
  if (option !== undefined) {
    const ttl = Number(rawTtl);
    if (!Number.isFinite(ttl) || ttl <= 0) return { response: encodeError("invalid expire time") };
    if (option.toUpperCase() === "EX") expiresAt = Date.now() + ttl * 1000;
    else if (option.toUpperCase() === "PX") expiresAt = Date.now() + ttl;
    else if (option.toUpperCase() === "PXAT") expiresAt = ttl;
    else return { response: encodeError("SET expiry option must be EX or PX") };
  }
  const evicted = store.set(key, value, expiresAt);
  const primary = expiresAt === undefined
    ? ["SET", key, value]
    : ["SET", key, value, "PXAT", String(expiresAt)];
  return {
    response: encodeSimpleString("OK"),
    persistedRecords: recordsWithEvictions(primary, evicted),
  };
};

const get: CommandHandler = (params, store) => {
  if (params.length !== 1) return { response: encodeError("usage: GET key") };
  const value = store.get(params[0]);
  return { response: value === undefined ? encodeNullBulk() : encodeBulkString(value) };
};

const del: CommandHandler = (params, store) => {
  if (params.length < 1) return { response: encodeError("usage: DEL key [key ...]") };
  let deleted = 0;
  for (const key of params) if (store.delete(key)) deleted += 1;
  // No AOF record when nothing changed — avoids noise on DEL of missing keys.
  return {
    response: encodeInteger(deleted),
    persistedRecords: deleted > 0 ? [["DEL", ...params]] : undefined,
  };
};

const exists: CommandHandler = (params, store) => {
  if (params.length < 1) return { response: encodeError("usage: EXISTS key [key ...]") };
  let found = 0;
  for (const key of params) if (store.has(key)) found += 1;
  return { response: encodeInteger(found) };
};

const incr: CommandHandler = (params, store) => {
  if (params.length !== 1) return { response: encodeError("usage: INCR key") };
  const current = store.get(params[0]) ?? "0";
  if (!/^-?\d+$/.test(current)) {
    return { response: encodeError("value is not an integer or out of range") };
  }
  const next = Number(current) + 1;
  if (!Number.isSafeInteger(next)) return { response: encodeError("increment would overflow") };
  const evicted = store.set(params[0], String(next), store.getExpiresAt(params[0]));
  return {
    response: encodeInteger(next),
    persistedRecords: recordsWithEvictions(["INCR", params[0]], evicted),
  };
};

const expire: CommandHandler = (params, store) => {
  if (params.length !== 2) return { response: encodeError("usage: EXPIRE key seconds") };
  const seconds = Number(params[1]);
  if (!Number.isFinite(seconds)) return { response: encodeError("invalid expire time") };
  const expiresAt = Date.now() + seconds * 1000;
  const changed = seconds <= 0 ? store.delete(params[0]) : store.expire(params[0], expiresAt);
  let persistedRecords: string[][] | undefined;
  if (changed && seconds > 0) persistedRecords = [["PEXPIREAT", params[0], String(expiresAt)]];
  else if (changed) persistedRecords = [["DEL", params[0]]];
  return { response: encodeInteger(changed ? 1 : 0), persistedRecords };
};

const ttl: CommandHandler = (params, store) => {
  if (params.length !== 1) return { response: encodeError("usage: TTL key") };
  return { response: encodeInteger(store.ttl(params[0])) };
};

// Internal AOF form stores an absolute deadline so downtime counts.
const pexpireat: CommandHandler = (params, store) => {
  if (params.length !== 2) return { response: encodeError("invalid AOF expiry record") };
  const deadline = Number(params[1]);
  const changed = Number.isFinite(deadline) && deadline > Date.now()
    ? store.expire(params[0], deadline)
    : store.delete(params[0]);
  return { response: encodeInteger(changed ? 1 : 0) };
};

const COMMANDS: Record<string, CommandHandler> = {
  PING: ping,
  SET: set,
  GET: get,
  DEL: del,
  EXISTS: exists,
  INCR: incr,
  EXPIRE: expire,
  TTL: ttl,
  PEXPIREAT: pexpireat,
};

export function execute(args: string[], store: Store, replay = false): ExecutionResult {
  if (args.length === 0) return { response: encodeError("empty command") };
  const [rawName, ...params] = args;
  const handler = COMMANDS[rawName.toUpperCase()];
  if (!handler) return { response: encodeError(`unknown command '${rawName}'`) };

  try {
    const result = handler(params, store);
    // Replay must mutate the store without appending to the AOF again.
    return {
      response: result.response,
      persistedRecords: replay ? undefined : result.persistedRecords,
    };
  } catch (cause) {
    return { response: encodeError(cause instanceof Error ? cause.message : "command failed") };
  }
}
