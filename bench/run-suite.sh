#!/usr/bin/env bash
# Fair comparison suite (methodology v2):
#   - JIT warmup inside load.ts (default 5000 untimed requests)
#   - Timed run default 200000 requests
#   - 5 runs per config; summarize median + min/max
#   - Scenarios: baseline c10/p1, pipeline 16, connections 50
#   - Optional redis-benchmark cross-check (same -c/-n/-P/-d/-r)
#
# Does not invent numbers. Appends to bench/results.csv then prints a summary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/usr/bin:$PATH"

RUNS=5
REQS=200000
MIX=set
VBYTES=32
KSPACE=1000
JIT=5000
MINI_PORT=6380
REDIS_PORT=6379
CSV="$ROOT/bench/results.csv"
BENCH_DIR="$ROOT/bench/run-data"
mkdir -p "$BENCH_DIR"

kill_port() {
  local port="$1"
  local pids
  pids="$(ss -lptn "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u || true)"
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  sleep 0.5
}

wait_listening() {
  local log="$1" port="$2" tries=80
  for _ in $(seq 1 "$tries"); do
    if grep -Eqi "listening|Ready to accept connections" "$log" 2>/dev/null; then
      return 0
    fi
    if ss -ltn 2>/dev/null | grep -Eq ":${port}\\b"; then
      return 0
    fi
    sleep 0.25
  done
  echo "Server did not become ready (log=$log port=$port)" >&2
  tail -n 50 "$log" >&2 || true
  return 1
}

start_mini() {
  local mode="$1" tag="$2"
  local aof="$BENCH_DIR/mini-${mode}-${tag}.aof"
  local log="$BENCH_DIR/mini-${mode}-${tag}.log"
  rm -f "$aof" "$log"
  kill_port "$MINI_PORT"
  (
    cd "$ROOT"
    APPENDFSYNC="$mode" PORT="$MINI_PORT" AOF_FILE="$aof" HOST=127.0.0.1 \
      npx tsx src/index.ts
  ) >"$log" 2>&1 &
  echo $! >"$BENCH_DIR/mini.pid"
  wait_listening "$log" "$MINI_PORT"
}

stop_mini() {
  local pid
  pid="$(cat "$BENCH_DIR/mini.pid" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  kill_port "$MINI_PORT"
  rm -f "$BENCH_DIR/mini.pid"
  sleep 0.5
}

start_redis() {
  local mode="$1" tag="$2"
  local dir="$BENCH_DIR/redis-${mode}-${tag}"
  rm -rf "$dir"
  mkdir -p "$dir"
  kill_port "$REDIS_PORT"
  sudo service redis-server stop >/dev/null 2>&1 || true
  sleep 0.5

  local conf="$dir/redis.conf"
  if [[ "$mode" == "everysec" ]]; then
    cat >"$conf" <<EOF
port ${REDIS_PORT}
bind 127.0.0.1
protected-mode no
dir ${dir}
dbfilename dump.rdb
appendonly yes
appendfilename appendonly.aof
appendfsync everysec
save ""
EOF
  else
    cat >"$conf" <<EOF
port ${REDIS_PORT}
bind 127.0.0.1
protected-mode no
dir ${dir}
dbfilename dump.rdb
appendonly no
save ""
EOF
  fi

  local log="$dir/server.log"
  redis-server "$conf" >"$log" 2>&1 &
  echo $! >"$BENCH_DIR/redis.pid"
  wait_listening "$log" "$REDIS_PORT"
}

stop_redis() {
  local pid
  pid="$(cat "$BENCH_DIR/redis.pid" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  kill_port "$REDIS_PORT"
  rm -f "$BENCH_DIR/redis.pid"
  sleep 0.5
}

bench_load() {
  local port="$1" label="$2" notes="$3" connections="$4" pipeline="$5"
  npx tsx bench/load.ts --host 127.0.0.1 --port "$port" \
    --connections "$connections" --requests "$REQS" --pipeline "$pipeline" \
    --mix "$MIX" --value-bytes "$VBYTES" --keyspace "$KSPACE" \
    --jit-warmup "$JIT" \
    --csv "$CSV" \
    --label "$label" \
    --notes "$notes"
}

run_mini_scenario() {
  local mode="$1" connections="$2" pipeline="$3" label_suffix="$4"
  local label="mini-redis-${mode}${label_suffix}"
  echo "=== Scenario Mini Redis mode=$mode c=${connections} P=${pipeline} (${RUNS} runs) ==="
  for run in $(seq 1 "$RUNS"); do
    start_mini "$mode" "${connections}p${pipeline}-r${run}"
    bench_load "$MINI_PORT" "$label" \
      "APPENDFSYNC=${mode}; run=${run}/${RUNS}; c=${connections}; P=${pipeline}; n=${REQS}; jit=${JIT}; WSL2" \
      "$connections" "$pipeline"
    stop_mini
  done
}

run_redis_scenario() {
  local mode="$1" connections="$2" pipeline="$3" label_suffix="$4"
  local label="redis-${mode}${label_suffix}"
  echo "=== Scenario Redis mode=$mode c=${connections} P=${pipeline} (${RUNS} runs) ==="
  for run in $(seq 1 "$RUNS"); do
    start_redis "$mode" "${connections}p${pipeline}-r${run}"
    bench_load "$REDIS_PORT" "$label" \
      "Redis $(redis-server --version | head -1); mode=${mode}; run=${run}/${RUNS}; c=${connections}; P=${pipeline}; n=${REQS}; jit=${JIT}; WSL2" \
      "$connections" "$pipeline"
    stop_redis
  done
}

# --- redis-benchmark cross-check (official client) ---
# Same shape: -c connections, -n requests, -P pipeline, -d value bytes, -r keyspace.
crosscheck_redis_benchmark() {
  if ! command -v redis-benchmark >/dev/null 2>&1; then
    echo "redis-benchmark not found; skip cross-check" >&2
    return 0
  fi
  local out="$BENCH_DIR/redis-benchmark-crosscheck.txt"
  : >"$out"
  echo "=== redis-benchmark cross-check (SET only) ===" | tee -a "$out"

  start_mini everysec "rb-cross"
  {
    echo "--- Mini Redis :$MINI_PORT APPENDFSYNC=everysec ---"
    redis-benchmark -h 127.0.0.1 -p "$MINI_PORT" -c 10 -n "$REQS" -P 1 -d "$VBYTES" -r "$KSPACE" -t set --csv
    echo "--- Mini Redis pipeline 16 ---"
    redis-benchmark -h 127.0.0.1 -p "$MINI_PORT" -c 10 -n "$REQS" -P 16 -d "$VBYTES" -r "$KSPACE" -t set --csv
    echo "--- Mini Redis connections 50 ---"
    redis-benchmark -h 127.0.0.1 -p "$MINI_PORT" -c 50 -n "$REQS" -P 1 -d "$VBYTES" -r "$KSPACE" -t set --csv
  } | tee -a "$out"
  stop_mini

  start_redis everysec "rb-cross"
  {
    echo "--- Redis :$REDIS_PORT appendfsync everysec ---"
    redis-benchmark -h 127.0.0.1 -p "$REDIS_PORT" -c 10 -n "$REQS" -P 1 -d "$VBYTES" -r "$KSPACE" -t set --csv
    echo "--- Redis pipeline 16 ---"
    redis-benchmark -h 127.0.0.1 -p "$REDIS_PORT" -c 10 -n "$REQS" -P 16 -d "$VBYTES" -r "$KSPACE" -t set --csv
    echo "--- Redis connections 50 ---"
    redis-benchmark -h 127.0.0.1 -p "$REDIS_PORT" -c 50 -n "$REQS" -P 1 -d "$VBYTES" -r "$KSPACE" -t set --csv
  } | tee -a "$out"
  stop_redis

  echo "redis-benchmark output saved to $out"
}

# Fresh CSV for this suite.
rm -f "$CSV"

echo "Node $(node -v) | npm $(npm -v) | $(redis-server --version) | $(uname -srm)"
echo "Methodology: runs=$RUNS requests=$REQS jit_warmup=$JIT mix=$MIX value=$VBYTES keyspace=$KSPACE"

# Baseline: c=10, P=1
run_mini_scenario everysec 10 1 ""
run_mini_scenario always 10 1 ""
run_mini_scenario no 10 1 ""
run_redis_scenario everysec 10 1 ""
run_redis_scenario aof-off 10 1 ""

# Pipeline 16 (same request count; fairer for batching)
run_mini_scenario everysec 10 16 "-p16"
run_redis_scenario everysec 10 16 "-p16"

# Connections 50
run_mini_scenario everysec 50 1 "-c50"
run_redis_scenario everysec 50 1 "-c50"

crosscheck_redis_benchmark

echo
echo "=== Summary (median / min / max) ==="
python3 "$ROOT/bench/summarize.py" "$CSV" || true
echo
echo "Suite complete. Results: $CSV"
echo "Cross-check: $BENCH_DIR/redis-benchmark-crosscheck.txt"
