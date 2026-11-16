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

Use the project load tool (same client against Mini Redis and real Redis). Details: [bench/README.md](bench/README.md).

```sh
# terminal 1
APPENDFSYNC=everysec npm start

# terminal 2 — fill in labels/notes for the config you actually ran
npm run bench -- --connections 10 --requests 20000 --pipeline 1 --mix set --value-bytes 32 --keyspace 1000 --label mini-redis-everysec --notes "APPENDFSYNC=everysec"

pip install matplotlib
python bench/plot.py
```

Charts are written to `docs/bench-latency.png` and `docs/bench-throughput.png` from `bench/results.csv`.

### Results table (fill from real runs only)

Do **not** invent numbers. After you run `npm run bench`, copy ops/sec and p99 from the console or `bench/results.csv` into the placeholders below. Prefer the same machine, OS (WSL2/Linux recommended), connection/request/pipeline/value settings, and a noted AOF/`APPENDFSYNC` policy for each row.

| Server / configuration | SET throughput | SET p99 | Notes |
| --- | ---: | ---: | --- |
| Mini Redis `APPENDFSYNC=everysec` | _TBD_ | _TBD_ | _date, Node version, OS_ |
| Mini Redis `APPENDFSYNC=always` | _TBD_ | _TBD_ | |
| Mini Redis `APPENDFSYNC=no` | _TBD_ | _TBD_ | |
| Redis `appendfsync everysec` | _TBD_ | _TBD_ | _Redis version_ |
| Redis AOF off | _TBD_ | _TBD_ | |

Suggested comparable flags: `--connections 10 --requests 20000 --pipeline 1 --mix set --value-bytes 32 --keyspace 1000`.

## Design (short)

- **Store:** `Map` + doubly linked list → O(1) LRU get/set/evict; approximate `MAXMEMORY_MB`.
- **TTL:** lazy expiry on access + active expiry sampling a **TTL-only** index (time-budgeted, Redis-style).
- **AOF:** batched RESP log; `APPENDFSYNC` controls reply-vs-disk timing (see table in [docs/architecture.md](docs/architecture.md)).
- **Execution:** one global command queue for mutation/AOF order.

## Current limits

Teaching clone, not production Redis. Notably:

- Single-threaded command execution
- Limited string command set (no lists/hashes, `MULTI`, pub/sub, replication, RDB, …)
- No AOF rewrite/compaction
- Approximate memory accounting (not RSS)
- Truncated/corrupt AOF tail stops replay at that point
- No auth / TLS

See [docs/architecture.md](docs/architecture.md) for the full limitations list.
