#!/usr/bin/env bash
# Fair comparison suite: Mini Redis (everysec/always/no) + Redis (everysec / AOF off).
# 3 runs each; same load flags. Appends to bench/results.csv.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/usr/bin:$PATH"

CONN=10
REQS=20000
PIPE=1
MIX=set
VBYTES=32
KSPACE=1000
MINI_PORT=6380
REDIS_PORT=6379
CSV="$ROOT/bench/results.csv"
BENCH_DIR="$ROOT/bench/run-data"
mkdir -p "$BENCH_DIR"

COMMON=(--connections "$CONN" --requests "$REQS" --pipeline "$PIPE" --mix "$MIX" --value-bytes "$VBYTES" --keyspace "$KSPACE" --csv "$CSV")

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
    # Process may still be starting; keep waiting unless it already exited with empty log.
    sleep 0.25
  done
  echo "Server did not become ready (log=$log port=$port)" >&2
  tail -n 50 "$log" >&2 || true
  return 1
}

run_mini() {
  local mode="$1" run="$2"
  local aof="$BENCH_DIR/mini-${mode}-${run}.aof"
  local log="$BENCH_DIR/mini-${mode}-${run}.log"
  rm -f "$aof" "$log"
  kill_port "$MINI_PORT"
  echo "=== Mini Redis APPENDFSYNC=$mode run $run ==="
  (
    cd "$ROOT"
    APPENDFSYNC="$mode" PORT="$MINI_PORT" AOF_FILE="$aof" HOST=127.0.0.1 \
      npx tsx src/index.ts
  ) >"$log" 2>&1 &
  local spid=$!
  wait_listening "$log" "$MINI_PORT"
  npx tsx bench/load.ts --host 127.0.0.1 --port "$MINI_PORT" \
    "${COMMON[@]}" \
    --label "mini-redis-${mode}" \
    --notes "APPENDFSYNC=${mode}; run=${run}; WSL2 Ubuntu"
  kill "$spid" 2>/dev/null || true
  wait "$spid" 2>/dev/null || true
  kill_port "$MINI_PORT"
  sleep 0.5
}

run_redis() {
  local mode="$1" run="$2"
  local dir="$BENCH_DIR/redis-${mode}"
  rm -rf "$dir"
  mkdir -p "$dir"
  kill_port "$REDIS_PORT"
  # Stop distro service if it grabbed 6379.
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

  local log="$dir/server-${run}.log"
  echo "=== Redis mode=$mode run $run ==="
  redis-server "$conf" >"$log" 2>&1 &
  local spid=$!
  wait_listening "$log" "$REDIS_PORT"
  npx tsx bench/load.ts --host 127.0.0.1 --port "$REDIS_PORT" \
    "${COMMON[@]}" \
    --label "redis-${mode}" \
    --notes "Redis $(redis-server --version | head -1); mode=${mode}; run=${run}; WSL2 Ubuntu"
  kill "$spid" 2>/dev/null || true
  wait "$spid" 2>/dev/null || true
  kill_port "$REDIS_PORT"
  sleep 0.5
}

# Fresh CSV for this suite (avoid mixing with old Windows smoke rows).
rm -f "$CSV"

echo "Node $(node -v) | npm $(npm -v) | $(redis-server --version) | $(uname -srm)"
echo "Flags: connections=$CONN requests=$REQS pipeline=$PIPE mix=$MIX value=$VBYTES keyspace=$KSPACE"

for run in 1 2 3; do
  run_mini everysec "$run"
done
for run in 1 2 3; do
  run_mini always "$run"
done
for run in 1 2 3; do
  run_mini no "$run"
done
for run in 1 2 3; do
  run_redis everysec "$run"
done
for run in 1 2 3; do
  run_redis aof-off "$run"
done

echo "Suite complete. Results: $CSV"
