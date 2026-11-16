# Mini Redis

A learning project: a small Redis-inspired TCP server in TypeScript (Node `net` + RESP), with O(1) LRU, lazy/active TTL expiry, and AOF persistence.

Deeper design notes: [docs/architecture.md](docs/architecture.md).

## Project structure

```text
src/
  index.ts      Entry point
  config.ts     Env configuration
  server.ts     TCP server, command queue
  resp.ts       RESP parse / encode
  commands.ts   Command table + handlers
  store.ts      Map + LRU + TTL
  aof.ts        AOF writer + APPENDFSYNC
  replay.ts     AOF startup replay
test/           node:test suite
bench/          Load generator + plot script
docs/           Architecture and benchmark charts
```

## Run

```sh
npm install
npm start
```

Listens on `127.0.0.1:6379` by default. Connect with `redis-cli -h 127.0.0.1 -p 6379`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `6379` | TCP port |
| `MAXMEMORY_MB` | `64` | Approximate in-memory storage limit |
| `AOF_FILE` | `appendonly.aof` | Append-only persistence file |
| `AOF_BATCH_MS` | `2` | Max wait before flushing a small AOF batch (`everysec` / `no`) |
| `APPENDFSYNC` | `everysec` | `always` \| `everysec` \| `no` |

```sh
npm run build    # tsc → dist/
npm run dev      # tsx watch
```

## Commands

`PING [message]`, `SET key value [EX seconds|PX milliseconds]`, `GET key`, `DEL key [key ...]`, `EXISTS key [key ...]`, `INCR key`, `EXPIRE key seconds`, `TTL key`.

Internal AOF forms: `SET … PXAT`, `PEXPIREAT` (absolute deadlines so downtime counts against TTL).

RESP arrays of bulk strings are the normal path; partial TCP chunks and pipelined commands in one chunk are supported. Simple inline commands (e.g. `PING\r\n`) are also accepted.

## Try it

```text
redis-cli -h 127.0.0.1 -p 6379 PING
redis-cli -h 127.0.0.1 -p 6379 SET name "Mini Redis"
redis-cli -h 127.0.0.1 -p 6379 GET name
redis-cli -h 127.0.0.1 -p 6379 SET short-lived yes EX 5
redis-cli -h 127.0.0.1 -p 6379 TTL short-lived
```

Restart the server and `GET name` again to confirm AOF replay.

## Test

```sh
npm test
```

Uses Node’s built-in test runner via `tsx` (`test/*.test.ts`): RESP parser, store/LRU/TTL, AOF replay, and TCP integration on an ephemeral port.

## Benchmark

Same load client against Mini Redis and real Redis. Full WSL2 command sheet (including `redis-benchmark` cross-check and `top` bottleneck check): [bench/README.md](bench/README.md).

**Methodology v2** (current tooling):

- JIT warmup: **5,000 untimed** requests (all mixes) before timing
- Timed run default: **200,000** requests
- Scenarios: `--connections 10 --pipeline 1`, also `--pipeline 16`, `--connections 50`
- **5 runs** per config → report **median** and **min/max** (`python3 bench/summarize.py`)
- Cross-check with official `redis-benchmark` (`-c` / `-n` / `-P` / `-d` / `-r`)

```sh
# WSL2 — automated suite
bash bench/run-suite.sh

# or one-shot
npm run bench -- --connections 10 --requests 200000 --pipeline 1 --mix set \
  --jit-warmup 5000 --label mini-redis-everysec --notes "APPENDFSYNC=everysec"
```

### Results table (methodology v2 — fill after you re-run)

Do **not** invent numbers. After `bash bench/run-suite.sh`, copy median ops/sec and p99 from `bench/summarize.py` / `bench/results.csv`.

| Server / configuration | SET throughput (median) | SET p99 (median) | min–max ops/s | Notes |
| --- | ---: | ---: | --- | --- |
| Mini Redis `APPENDFSYNC=everysec` (c10/P1) | _TBD_ | _TBD_ | _TBD_ | date, Node, OS |
| Mini Redis `APPENDFSYNC=always` (c10/P1) | _TBD_ | _TBD_ | _TBD_ | |
| Mini Redis `APPENDFSYNC=no` (c10/P1) | _TBD_ | _TBD_ | _TBD_ | |
| Redis `appendfsync everysec` (c10/P1) | _TBD_ | _TBD_ | _TBD_ | Redis version |
| Redis AOF off (c10/P1) | _TBD_ | _TBD_ | _TBD_ | |
| Mini Redis everysec (P16) | _TBD_ | _TBD_ | _TBD_ | |
| Redis everysec (P16) | _TBD_ | _TBD_ | _TBD_ | |
| Mini Redis everysec (c50) | _TBD_ | _TBD_ | _TBD_ | |
| Redis everysec (c50) | _TBD_ | _TBD_ | _TBD_ | |

### Archive — methodology v1 (do not use for new claims)

Measured 2026-11-16 on WSL2 · Node v22.22.1 · Redis 8.0.5 · **no JIT warmup** · **20,000** requests · **3** runs · c10/P1 only. Kept only as history:

| Server / configuration | SET throughput (median) | SET p99 (median) |
| --- | ---: | ---: |
| Mini Redis `APPENDFSYNC=everysec` | 10,707 ops/s | 8.184 ms |
| Mini Redis `APPENDFSYNC=always` | 184 ops/s | 89.591 ms |
| Mini Redis `APPENDFSYNC=no` | 19,416 ops/s | 3.705 ms |
| Redis `appendfsync everysec` | 12,031 ops/s | 3.502 ms |
| Redis AOF off | 12,948 ops/s | 3.507 ms |

## Design (short)

- **Store:** `Map` + doubly linked list → O(1) LRU get/set/evict; approximate `MAXMEMORY_MB`.
- **TTL:** lazy expiry on access + active expiry sampling a **TTL-only** index (time-budgeted, Redis-style).
- **AOF:** batched RESP log; `APPENDFSYNC` controls reply-vs-disk timing (see table in [docs/architecture.md](docs/architecture.md)). `DEL` is written to the AOF only when at least one key was actually removed.
- **Execution:** one global command queue for mutation/AOF order.
- **LRU touch on EXISTS/TTL (documented difference):** In this server, `EXISTS` and `TTL` go through `liveNode` + `touch`, so they refresh LRU recency like a read. Redis eviction “idle time” is updated on reads for some policies, but treating `EXISTS`/`TTL` as a full recency refresh is a Mini Redis simplification — they can keep a key from being the eviction victim even though the client only inspected metadata. Behavior is intentional and unchanged; just be aware when comparing to Redis.

## Current limits

Teaching clone, not production Redis. Notably:

- Single-threaded command execution
- Limited string command set (no lists/hashes, `MULTI`, pub/sub, replication, RDB, …)
- No AOF rewrite/compaction
- Approximate memory accounting (not RSS)
- Truncated/corrupt AOF tail stops replay at that point
- No auth / TLS

See [docs/architecture.md](docs/architecture.md) for the full limitations list.
