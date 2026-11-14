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

1. Start Redis on the **same machine** with a known AOF setting, e.g. `appendonly yes` and `appendfsync everysec` (or `no` / `always` — match Mini Redis for that run).
2. Point the same load tool at it:

```sh
npm run bench -- --port 6379 --mix set --connections 10 --requests 20000 --pipeline 1 --label redis-everysec --notes "Redis appendfsync everysec"
```

3. Keep **connections, requests, pipeline, mix, keyspace, value-bytes** identical across rows you plan to compare.
4. Prefer several runs; the CSV keeps every run so you can see variance.

`redis-benchmark` is optional. Using **this** tool against both servers removes client differences.

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
