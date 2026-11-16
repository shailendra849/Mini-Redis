# Mini Redis benchmarks

`load.ts` is a small RESP load generator that uses raw TCP sockets (no `redis-benchmark` required). It records per-request latency, prints p50/p95/p99 and ops/sec, and **appends** one row to `bench/results.csv`.

Do not invent numbers. Run the tool yourself, then plot.

## Prerequisites

- Node.js 20+ (same major on every comparison if you can)
- This repo installed (`npm install`)
- For fair Redis comparisons: **prefer WSL2 or Linux on the same machine**. Windows loopback + an unofficial Redis Windows build is fine for learning, but not for portable claims.

## Start Mini Redis

```sh
# from repo root — note the AOF policy you are measuring
APPENDFSYNC=everysec npm start
```

PowerShell:

```powershell
$env:APPENDFSYNC='everysec'
npm start
```

Use a dedicated AOF file for benches if you like (`AOF_FILE=bench.aof`) so you do not mix with dev data.

## Run the load generator

```sh
# SET-only, 10 clients, 20k requests, pipeline 1 (matches common redis-benchmark shape)
npm run bench -- --connections 10 --requests 20000 --pipeline 1 --mix set --value-bytes 32 --keyspace 1000 --label mini-redis-everysec --notes "APPENDFSYNC=everysec"

# GET-only (warms keys with SET first unless --no-warmup)
npm run bench -- --mix get --label mini-redis-get --notes "APPENDFSYNC=everysec"

# 50/50 SET/GET
npm run bench -- --mix mixed --pipeline 8 --label mini-redis-mixed-p8
```

### Useful flags

| Flag | Meaning |
| --- | --- |
| `--connections` | Parallel TCP clients |
| `--requests` | Total timed commands |
| `--pipeline` | Commands written before reading that many replies |
| `--mix` | `set`, `get`, or `mixed` (alternating SET/GET) |
| `--keyspace` | Distinct keys `k:0` … `k:N-1` |
| `--value-bytes` | SET payload size |
| `--label` | CSV label (what you will see on charts) |
| `--notes` | Free text (record `APPENDFSYNC`, OS, Redis version, …) |
| `--host` / `--port` | Target (default `127.0.0.1:6379`) |

## Compare against real Redis

1. Start Redis on the **same machine** with a known AOF setting, e.g. `appendonly yes` and `appendfsync everysec` (or AOF off — see command sheet below).
2. Point the same load tool at it (same flags as Mini Redis rows).
3. Keep **connections, requests, pipeline, mix, keyspace, value-bytes** identical across rows you plan to compare.
4. Prefer several runs; the CSV keeps every run so you can see variance.

`redis-benchmark` is optional. Using **this** tool against both servers removes client differences.

## WSL2 / Linux command sheet (fill numbers yourself)

Shared load flags (keep identical across all rows you compare):

```sh
BENCH='npm run bench -- --host 127.0.0.1 --connections 10 --requests 20000 --pipeline 1 --mix set --value-bytes 32 --keyspace 1000'
```

Use Mini Redis on **6380** and Redis on **6379** so they do not fight for a port. From the repo root in WSL:

### Mini Redis — `APPENDFSYNC=everysec`

```sh
AOF_FILE=bench-everysec.aof APPENDFSYNC=everysec PORT=6380 npm start
# other terminal:
$BENCH --port 6380 --label mini-redis-everysec --notes "APPENDFSYNC=everysec Node=$(node -v) $(uname -s)"
# Ctrl+C the server when done
```

### Mini Redis — `APPENDFSYNC=always`

```sh
AOF_FILE=bench-always.aof APPENDFSYNC=always PORT=6380 npm start
$BENCH --port 6380 --label mini-redis-always --notes "APPENDFSYNC=always Node=$(node -v) $(uname -s)"
```

### Mini Redis — `APPENDFSYNC=no`

```sh
AOF_FILE=bench-no.aof APPENDFSYNC=no PORT=6380 npm start
$BENCH --port 6380 --label mini-redis-no --notes "APPENDFSYNC=no Node=$(node -v) $(uname -s)"
```

### Real Redis — AOF `appendfsync everysec`

```sh
redis-server --port 6379 --appendonly yes --appendfsync everysec --dir /tmp/redis-bench-everysec --dbfilename dump.rdb
# other terminal (same $BENCH definition):
$BENCH --port 6379 --label redis-everysec --notes "Redis appendonly=yes appendfsync=everysec $(redis-server --version)"
```

### Real Redis — AOF off

```sh
redis-server --port 6379 --appendonly no --dir /tmp/redis-bench-aofoff --dbfilename dump.rdb
$BENCH --port 6379 --label redis-aof-off --notes "Redis appendonly=no $(redis-server --version)"
```

Optional mixes (same ports/labels pattern):

```sh
$BENCH --port 6380 --mix get --label mini-redis-everysec-get --notes "APPENDFSYNC=everysec"
$BENCH --port 6380 --mix mixed --pipeline 8 --label mini-redis-everysec-mixed-p8 --notes "APPENDFSYNC=everysec pipeline=8"
# alias: --mix 50/50  is the same as --mix mixed
```

Then plot (after real rows exist in `bench/results.csv`):

```sh
pip install matplotlib
python3 bench/plot.py
```

Copy ops/sec and p99 from the console or CSV into the README `_TBD_` table — never invent numbers.

## Plot charts

```sh
# once: Python 3 + matplotlib
pip install matplotlib

python bench/plot.py
# optional: python bench/plot.py path/to/other.csv
```

Writes (overwrites):

- `docs/bench-latency.png` — p50 / p95 / p99 by label
- `docs/bench-throughput.png` — ops/sec by label

If `bench/results.csv` has only a header (no runs yet), the script exits with a clear message and does not invent points.

## CSV format

`bench/results.csv` columns:

`timestamp,label,host,port,connections,requests,pipeline,mix,keyspace,value_bytes,ops_per_sec,p50_ms,p95_ms,p99_ms,notes`

The file is created automatically on the first successful run.
