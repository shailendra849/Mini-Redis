# Mini Redis

A learning project: a small Redis-inspired TCP server written in TypeScript with Node's built-in `net` module.

## Run it

```sh
npm install
npm start
```

The server listens on `127.0.0.1:6379` by default. Connect with `redis-cli -h 127.0.0.1 -p 6379`.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `6379` | TCP port |
| `MAXMEMORY_MB` | `64` | Approximate in-memory storage limit |
| `AOF_FILE` | `appendonly.aof` | Append-only persistence file |
| `AOF_BATCH_MS` | `2` | Maximum wait before flushing a small AOF batch |

## Commands

`PING [message]`, `SET key value [EX seconds|PX milliseconds]`, `GET key`, `DEL key [key ...]`, `EXISTS key [key ...]`, `INCR key`, `EXPIRE key seconds`, and `TTL key`.

Commands and replies use RESP framing. The parser buffers partial TCP requests and can process multiple requests received together. Simple inline commands are also accepted for the original `PING` demo.

## Design

- **TCP:** Node's `net` sockets expose a byte stream; server code cannot assume one `data` event equals one command.
- **RESP:** `src/resp.ts` incrementally recognizes arrays of bulk strings and encodes bulk-string replies.
- **Storage:** `src/store.ts` combines a `Map` with a doubly linked recency list. Reads update recency, making LRU lookup/update O(1).
- **Memory cap:** `MAXMEMORY_MB` uses an approximate accounting formula (UTF-8 key bytes + value bytes + 64 bytes of per-entry overhead). The least-recently-used entries are evicted when necessary.
- **TTL:** Reads check expiration lazily. A background timer also samples keys and removes expired entries that are never read.
- **AOF:** Mutating commands are queued as RESP records. A persistent file stream batches nearby records (up to 64 KiB or `AOF_BATCH_MS`) and startup replays the file. Expiring writes are stored with absolute deadlines, so time spent offline counts against TTL.
- **Durability trade-off:** Replies are sent after an AOF record enters the writer queue, before its disk write completes. A crash can lose recently acknowledged writes still waiting in the queue or OS buffers. The writer drains queued records on a normal Ctrl+C shutdown; it does not call `fsync` for every command.
- **Execution:** Commands are serialized through one queue, preserving mutation and AOF order, similar to Redis's single-command-at-a-time execution model.

## Try it

```text
redis-cli -h 127.0.0.1 -p 6379 PING
redis-cli -h 127.0.0.1 -p 6379 SET name "Mini Redis"
redis-cli -h 127.0.0.1 -p 6379 GET name
redis-cli -h 127.0.0.1 -p 6379 SET short-lived yes EX 5
redis-cli -h 127.0.0.1 -p 6379 TTL short-lived
```

Restart the server and read `name` again to see AOF replay.

## Benchmark

Measured locally on a Windows host with Node.js 24.14.1 for Mini Redis and Redis 8.10.3 compiled from official Redis source by the [redis-windows project](https://github.com/redis-windows/redis-windows/releases/tag/8.10.3). The same Redis 8.10.3 `redis-benchmark` client ran over loopback using `-n 20000 -c 10 -d 32 -r 1000`. Results below are SET-only tests; before and Redis each had three runs, and the optimized build had five. Each cell shows the median throughput and median p99 latency.

| Server/configuration | SET throughput | SET p99 |
| --- | ---: | ---: |
| Mini Redis before batching (AOF append awaited) | 2,577 ops/s | 7.935 ms |
| Mini Redis after batching (AOF record queued before reply) | 13,184 ops/s | 1.687 ms |
| Redis AOF off | 30,166 ops/s | 0.943 ms |
| Redis AOF `everysec` | 25,094 ops/s | 1.031 ms |

Batching improved Mini Redis SET throughput about 5.1× and reduced p99 latency about 79% compared with its earlier version on this machine. The policies still differ: Mini Redis replies as soon as the record is queued, while Redis AOF `everysec` uses its own background write/fsync behavior. A hard crash can lose recent Mini Redis writes that have not reached disk. The Redis Windows binary is an unofficial Windows build of Redis source, not the official Linux distribution, so treat these as a local learning comparison, not portable performance claims. `redis-benchmark` warned that Mini Redis does not implement `CONFIG`; the measured SET requests completed.

The main bottleneck was waiting for an individual AOF append before replying. The writer now holds a file stream open and groups nearby RESP records into batches. This improved the measured SET result, with the explicit durability trade-off described above.

## Current limits

This is a teaching clone, not a production Redis replacement. It supports a focused command set, has approximate rather than RSS-based memory accounting, and does not implement authentication, transactions, replication, RDB snapshots, full Redis protocol edge cases, or automatic AOF compaction. A corrupted/incomplete tail record stops replay at that point.
