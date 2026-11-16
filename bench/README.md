# Mini Redis benchmarks (methodology v2)

`load.ts` is a raw-TCP RESP load generator. It:

1. Optionally **keyspace-warms** (SET all keys) for `get` / `mixed`
2. Always runs a **JIT warmup** (default **5,000 untimed** requests) for **every** mix
3. Then runs the **timed** load (default **200,000** requests)
4. Appends one CSV row with ops/sec and p50/p95/p99

Do **not** invent numbers. Run on WSL2/Linux, then plot / fill README.

## Prerequisites (WSL2)

```sh
# Node + Redis (once)
sudo apt-get update
sudo apt-get install -y nodejs npm redis-server redis-tools
node -v && redis-server --version && redis-benchmark -h

cd "/mnt/d/Downloads/Mini Redis"   # or your clone path
npm install
npm test                           # must pass before benchmarking
```

## Exact commands — WSL2

Use **two terminals**. Prefer Mini Redis on **6380** and Redis on **6379**.

### Shared flags (keep identical when comparing)

```sh
cd "/mnt/d/Downloads/Mini Redis"
export PATH="/usr/bin:$PATH"

# Our load client
BENCH='npx tsx bench/load.ts --host 127.0.0.1 --requests 200000 --mix set --value-bytes 32 --keyspace 1000 --jit-warmup 5000'
```

### A) Full automated suite (5 runs × scenarios + redis-benchmark cross-check)

```sh
chmod +x bench/run-suite.sh
bash bench/run-suite.sh
# prints median/min/max via bench/summarize.py
# writes bench/results.csv
# writes bench/run-data/redis-benchmark-crosscheck.txt
```

Scenarios in the suite:

| Scenario | connections | pipeline | requests | runs |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 10 | 1 | 200000 | 5 |
| Pipeline | 10 | 16 | 200000 | 5 |
| Connections | 50 | 1 | 200000 | 5 |

Configs: Mini Redis `everysec` / `always` / `no`; Redis `everysec` / AOF off (baseline). Pipeline-16 and c50 only for Mini/Redis `everysec`.

### B) Manual — one Mini Redis config

**Terminal 1 — server**

```sh
cd "/mnt/d/Downloads/Mini Redis"
AOF_FILE=bench/run-data/manual-everysec.aof APPENDFSYNC=everysec PORT=6380 HOST=127.0.0.1 npx tsx src/index.ts
```

**Terminal 2 — load (baseline)**

```sh
cd "/mnt/d/Downloads/Mini Redis"
$BENCH --port 6380 --connections 10 --pipeline 1 \
  --label mini-redis-everysec --notes "APPENDFSYNC=everysec Node=$(node -v) $(uname -srm)"
```

**Pipeline 16**

```sh
$BENCH --port 6380 --connections 10 --pipeline 16 \
  --label mini-redis-everysec-p16 --notes "APPENDFSYNC=everysec P=16"
```

**Connections 50**

```sh
$BENCH --port 6380 --connections 50 --pipeline 1 \
  --label mini-redis-everysec-c50 --notes "APPENDFSYNC=everysec c=50"
```

Repeat the same three shapes with `APPENDFSYNC=always` and `APPENDFSYNC=no` (new AOF file each time). For each config, run **5 times** and take **median** (also record min/max).

### C) Manual — real Redis

```sh
# everysec
mkdir -p /tmp/redis-bench-everysec
redis-server --port 6379 --bind 127.0.0.1 --protected-mode no \
  --dir /tmp/redis-bench-everysec --dbfilename dump.rdb \
  --appendonly yes --appendfsync everysec --save ""

$BENCH --port 6379 --connections 10 --pipeline 1 \
  --label redis-everysec --notes "Redis $(redis-server --version)"
```

```sh
# AOF off
mkdir -p /tmp/redis-bench-aofoff
redis-server --port 6379 --bind 127.0.0.1 --protected-mode no \
  --dir /tmp/redis-bench-aofoff --dbfilename dump.rdb \
  --appendonly no --save ""

$BENCH --port 6379 --connections 10 --pipeline 1 \
  --label redis-aof-off --notes "Redis appendonly=no"
```

### D) Official `redis-benchmark` cross-check (same -c/-n/-P/-d/-r)

Against Mini Redis (server already on 6380):

```sh
redis-benchmark -h 127.0.0.1 -p 6380 -c 10 -n 200000 -P 1  -d 32 -r 1000 -t set --csv
redis-benchmark -h 127.0.0.1 -p 6380 -c 10 -n 200000 -P 16 -d 32 -r 1000 -t set --csv
redis-benchmark -h 127.0.0.1 -p 6380 -c 50 -n 200000 -P 1  -d 32 -r 1000 -t set --csv
```

Against real Redis (server on 6379):

```sh
redis-benchmark -h 127.0.0.1 -p 6379 -c 10 -n 200000 -P 1  -d 32 -r 1000 -t set --csv
redis-benchmark -h 127.0.0.1 -p 6379 -c 10 -n 200000 -P 16 -d 32 -r 1000 -t set --csv
redis-benchmark -h 127.0.0.1 -p 6379 -c 50 -n 200000 -P 1  -d 32 -r 1000 -t set --csv
```

Compare directionally with `bench/load.ts` (different clients → absolute numbers may differ; relative ranking should be sane).

### Summarize + plot

```sh
python3 bench/summarize.py bench/results.csv
pip install matplotlib   # once
python3 bench/plot.py
```

## Confirm the client is not the bottleneck

While a timed run is in progress, open a **third** WSL terminal:

```sh
# Watch Node load client + server CPU
top -d 1
# or narrower:
top -d 1 -p $(pgrep -d',' -f 'tsx bench/load|tsx src/index|redis-server|redis-benchmark')
```

How to read it:

| What you see | Meaning |
| --- | --- |
| `tsx bench/load` (or `redis-benchmark`) stuck near **100% of one core**, server lower | Client may be the limit — try more connections / pipeline, or accept client-bound results |
| Server (`tsx src/index` or `redis-server`) high CPU, client lower | Server-bound — good for comparing servers |
| Both moderate, low overall | I/O / fsync bound (especially `APPENDFSYNC=always`) — also informative |

Also useful:

```sh
# One-shot sample
ps -eo pid,pcpu,pmem,cmd --sort=-pcpu | head -20
```

If the load client is pegged at ~100% of a single core while the server has free CPU, numbers understate the server. Prefer server-bound conditions when claiming Mini Redis vs Redis throughput.

## Flags reference

| Flag | Meaning |
| --- | --- |
| `--connections` | Parallel TCP clients (default 10; scenario: 50) |
| `--requests` | Timed commands (default **200000**) |
| `--pipeline` | Write N before reading N replies (default 1; scenario: 16) |
| `--jit-warmup` | Untimed requests before timing (default **5000**, all mixes) |
| `--no-jit-warmup` | Skip JIT warmup |
| `--no-warmup` | Skip keyspace SETs for get/mixed |
| `--mix` | `set`, `get`, `mixed` / `50/50` |

## CSV

`timestamp,label,host,port,connections,requests,pipeline,mix,keyspace,value_bytes,ops_per_sec,p50_ms,p95_ms,p99_ms,notes`
