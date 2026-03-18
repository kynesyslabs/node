#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  run-token-observe-under-load.sh [--reset] [--build] [--plain|--scripted|--both]
    [--observe-sec <n>] [--settle-sec <n>] [--poll-ms <n>]
    [--load-sec <n>] [--concurrency <n>] [--inflight <n>] [--tail <n>]

What it does (per mode):
  1) Bootstrap a token (plain: token_smoke, scripted: token_script_smoke)
  2) Run token_observe (committed reads) while running a heavy transfer load
  3) Keep observing for a settle window
  4) Analyze token_observe.timeseries.jsonl for:
     - no divergence across nodes on non-null hashes
     - tail convergence (last N ticks all nodes non-null + equal)

Examples:
  run-token-observe-under-load.sh --reset --build --both
  run-token-observe-under-load.sh --scripted --load-sec 90 --concurrency 120 --observe-sec 360 --settle-sec 180
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

RESET=0
BUILD=0
MODE="both"
OBSERVE_SEC=360
SETTLE_SEC=180
POLL_MS=1000
LOAD_SEC=90
CONCURRENCY=120
INFLIGHT_PER_WALLET=1
TAIL=5
OBSERVE_CONTAINER=""
LOAD_CONTAINER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET=1; shift ;;
    --build) BUILD=1; shift ;;
    --plain) MODE="plain"; shift ;;
    --scripted) MODE="scripted"; shift ;;
    --both) MODE="both"; shift ;;
    --observe-sec) OBSERVE_SEC="${2:-}"; shift 2 ;;
    --settle-sec) SETTLE_SEC="${2:-}"; shift 2 ;;
    --poll-ms) POLL_MS="${2:-}"; shift 2 ;;
    --load-sec) LOAD_SEC="${2:-}"; shift 2 ;;
    --concurrency) CONCURRENCY="${2:-}"; shift 2 ;;
    --inflight) INFLIGHT_PER_WALLET="${2:-}"; shift 2 ;;
    --tail) TAIL="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

run_one() {
  local mode="$1"
  local now
  now="$(date -u +%Y%m%d-%H%M%S)"
  local RUN_ID="token-observe-under-load-${mode}-${now}"
  OBSERVE_CONTAINER="${RUN_ID}-observe"
  LOAD_CONTAINER="${RUN_ID}-load"

  pushd "$ROOT_DIR/devnet" >/dev/null

  cleanup() {
    # Best-effort cleanup for background observer container on failure/interrupt.
    docker rm -f "${OBSERVE_CONTAINER:-}" >/dev/null 2>&1 || true
    docker rm -f "${LOAD_CONTAINER:-}" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  if [[ "$RESET" -eq 1 ]]; then
    echo "[observe-load] resetting devnet (docker compose down -v)"
    docker compose down -v
  fi

  if [[ "$BUILD" -eq 1 ]]; then
    docker compose build node-1
  fi

  docker compose up -d

  if [[ "$BUILD" -eq 1 && "$RESET" -eq 0 ]]; then
    docker compose up -d --force-recreate node-1 node-2 node-3 node-4
  fi

  popd >/dev/null

  local bootstrap_scenario="token_smoke"
  local load_scenario="token_transfer"
  local bootstrap_summary_name="token_smoke"
  if [[ "$mode" == "scripted" ]]; then
    # Use the perf-hook script used by loadgen (ping + getHookCounts), not the simple token_script_smoke script.
    bootstrap_scenario="token_script_transfer"
    bootstrap_summary_name="token_script_transfer"
    load_scenario="token_script_transfer"
  fi

  echo "[observe-load] bootstrap: $bootstrap_scenario (RUN_ID=$RUN_ID)"
  if [[ "$mode" == "scripted" ]]; then
    "$ROOT_DIR/better_testing/scripts/run-scenario.sh" "$bootstrap_scenario" --run-id "$RUN_ID" --quiet \
      --env DURATION_SEC=3 \
      --env CONCURRENCY=1 \
      --env TOKEN_SCRIPT_UPGRADE=true
  else
    "$ROOT_DIR/better_testing/scripts/run-scenario.sh" "$bootstrap_scenario" --run-id "$RUN_ID" --quiet
  fi

  local bootstrap_summary="$ROOT_DIR/better_testing/runs/$RUN_ID/${bootstrap_summary_name}.summary.json"
  if [[ ! -f "$bootstrap_summary" ]]; then
    echo "Missing bootstrap summary: $bootstrap_summary" >&2
    exit 1
  fi

  local token_address
  token_address="$(jq -r '.tokenAddress // empty' "$bootstrap_summary")"
  if [[ -z "$token_address" || "$token_address" == "null" ]]; then
    echo "Could not read tokenAddress from $bootstrap_summary" >&2
    exit 1
  fi

  echo "[observe-load] tokenAddress=$token_address"

  local observe_total_sec=$(( OBSERVE_SEC + SETTLE_SEC ))

  pushd "$ROOT_DIR/devnet" >/dev/null

  echo "[observe-load] starting observer (token_observe, ${observe_total_sec}s)"
  docker compose \
    -f docker-compose.yml \
    -f ../better_testing/docker-compose.perf.yml \
    run --name "$OBSERVE_CONTAINER" --rm --no-deps \
    -e RUN_ID="$RUN_ID" \
    -e SCENARIO="token_observe" \
    -e QUIET="true" \
    -e TOKEN_ADDRESS="$token_address" \
    -e OBSERVE_SEC="$observe_total_sec" \
    -e OBSERVE_POLL_MS="$POLL_MS" \
    -e INCLUDE_MEMPOOL="true" \
    -e INCLUDE_TOKEN_GET="true" \
    -e INCLUDE_SCRIPT_STATE="true" \
    -e WAIT_FOR_RPC_SEC="240" \
    -e WAIT_FOR_TX_SEC="240" \
    -e NODECALL_IN_FLUX_TIMEOUT_MS="${NODECALL_IN_FLUX_TIMEOUT_MS:-2000}" \
    loadgen >/dev/null &
  local OBSERVE_PID=$!

  # Give observer a moment to initialize.
  sleep 2

  echo "[observe-load] starting load ($load_scenario, ${LOAD_SEC}s, concurrency=$CONCURRENCY inflight=$INFLIGHT_PER_WALLET)"
  docker compose \
    -f docker-compose.yml \
    -f ../better_testing/docker-compose.perf.yml \
    run --name "$LOAD_CONTAINER" --rm --no-deps \
    -e RUN_ID="$RUN_ID" \
    -e SCENARIO="$load_scenario" \
    -e QUIET="true" \
    -e TOKEN_ADDRESS="$token_address" \
    -e TOKEN_BOOTSTRAP="false" \
    -e TOKEN_DISTRIBUTE="false" \
    -e TOKEN_SCRIPT_UPGRADE="false" \
    -e DURATION_SEC="$LOAD_SEC" \
    -e CONCURRENCY="$CONCURRENCY" \
    -e INFLIGHT_PER_WALLET="$INFLIGHT_PER_WALLET" \
    -e WAIT_FOR_RPC_SEC="240" \
    -e WAIT_FOR_TX_SEC="240" \
    loadgen >/dev/null

  echo "[observe-load] waiting observer to finish..."
  wait "$OBSERVE_PID"

  popd >/dev/null

  local ts_path="$ROOT_DIR/better_testing/runs/$RUN_ID/token_observe.timeseries.jsonl"
  if [[ ! -f "$ts_path" ]]; then
    echo "Missing observer timeseries: $ts_path" >&2
    exit 1
  fi

  echo "[observe-load] analyzing: $ts_path"
  bun "$ROOT_DIR/better_testing/scripts/analyze-token-observe.ts" "$ts_path" --tail "$TAIL"

  echo "Run dir: better_testing/runs/$RUN_ID"

  trap - EXIT
  cleanup
}

case "$MODE" in
  plain) run_one "plain" ;;
  scripted) run_one "scripted" ;;
  both)
    run_one "plain"
    run_one "scripted"
    ;;
  *) echo "Invalid MODE: $MODE" >&2; exit 2 ;;
esac
