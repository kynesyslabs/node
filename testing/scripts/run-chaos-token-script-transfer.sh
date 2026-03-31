#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  run-chaos-token-script-transfer.sh [--reset] [--build] [--node <service>] [--delay-sec <n>] [--duration-sec <n>] [--quiet|--verbose] [--env KEY=VALUE ...]

What it does:
  (optional) --reset: tears down devnet volumes/containers (fresh state)
  1) Runs SCENARIO=token_script_transfer for a fixed duration (POST_RUN checks disabled)
  2) Restarts one follower node mid-run (default: node-3)
  3) Runs SCENARIO=token_settle_check against the token produced in step 1 (balances + holder pointers + script counters)

Examples:
  run-chaos-token-script-transfer.sh --reset --build
  run-chaos-token-script-transfer.sh --node node-2 --delay-sec 8 --duration-sec 45 --env SCRIPT_SET_STORAGE=true
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BUILD=0
RESET=0
QUIET=true
NODE_SERVICE="node-3"
DELAY_SEC=10
DURATION_SEC=60
RUN_ID=""
EXTRA_ENV=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      RESET=1
      shift
      ;;
    --build)
      BUILD=1
      shift
      ;;
    --quiet)
      QUIET=true
      shift
      ;;
    --verbose)
      QUIET=false
      shift
      ;;
    --node)
      NODE_SERVICE="${2:-}"
      shift 2
      ;;
    --delay-sec)
      DELAY_SEC="${2:-}"
      shift 2
      ;;
    --duration-sec)
      DURATION_SEC="${2:-}"
      shift 2
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --env)
      EXTRA_ENV+=("${2:-}")
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="token-script-transfer-chaos-$(date -u +%Y%m%d-%H%M%S)"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

default_targets="http://node-1:53551,http://node-2:53553,http://node-3:53555,http://node-4:53557"
full_targets="${TARGETS:-$default_targets}"
node_url=""
case "$NODE_SERVICE" in
  node-1) node_url="http://node-1:53551" ;;
  node-2) node_url="http://node-2:53553" ;;
  node-3) node_url="http://node-3:53555" ;;
  node-4) node_url="http://node-4:53557" ;;
  *) node_url="" ;;
esac

# For the load phase, avoid sending requests to the node we're about to restart,
# otherwise any worker pinned to that target can fail hard during the restart.
load_targets="$full_targets"
if [[ -n "$node_url" ]]; then
  load_targets="$(echo "$full_targets" | awk -v RS=',' -v ORS=',' -v drop="$node_url" '
    {
      gsub(/[[:space:]]+/, "", $0);
      if ($0 == drop || $0 == drop"/") next;
      if (length($0)) print $0
    }
  ' | sed 's/,$//')"
fi
if [[ -z "$load_targets" ]]; then
  echo "Computed empty TARGETS for load phase (full_targets=$full_targets node_url=$node_url)" >&2
  exit 2
fi

pushd "$ROOT_DIR/testing/devnet" >/dev/null

if [[ "$RESET" -eq 1 ]]; then
  echo "[chaos] resetting devnet (docker compose down -v)"
  docker compose down -v
  if [[ "$BUILD" -eq 1 ]]; then
    docker compose build node-1
  fi
  docker compose up -d
fi

if [[ "$RESET" -eq 0 && "$BUILD" -eq 1 ]]; then
  docker compose build node-1
  # Ensure running nodes pick up the rebuilt image.
  docker compose up -d --force-recreate node-1 node-2 node-3 node-4
fi

loadgen_cmd=(
  docker compose
  -f docker-compose.yml
  -f ../docker-compose.perf.yml
  run --rm --no-deps
  -e RUN_ID="$RUN_ID"
  -e SCENARIO="token_script_transfer"
  -e QUIET="$QUIET"
  -e TARGETS="$load_targets"
  -e DURATION_SEC="$DURATION_SEC"
  -e POST_RUN_SETTLE_CHECK="false"
  -e POST_RUN_HOLDER_POINTER_CHECK="false"
)

for kv in "${EXTRA_ENV[@]}"; do
  if [[ -z "$kv" || "$kv" != *"="* ]]; then
    echo "Invalid --env value (expected KEY=VALUE): $kv" >&2
    exit 2
  fi
  loadgen_cmd+=(-e "$kv")
done

loadgen_cmd+=(loadgen)

set +e
"${loadgen_cmd[@]}" &
LOADGEN_PID=$!
set -e

sleep "$DELAY_SEC"
echo "[chaos] restarting $NODE_SERVICE"
docker compose restart "$NODE_SERVICE"

wait "$LOADGEN_PID"

popd >/dev/null

summary_path="$ROOT_DIR/testing/runs/$RUN_ID/token_script_transfer.summary.json"
if [[ ! -f "$summary_path" ]]; then
  echo "Missing summary: $summary_path" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  token_address="$(jq -r '.tokenAddress // empty' "$summary_path")"
else
  token_address="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(\"tokenAddress\",\"\"))' "$summary_path")"
fi

if [[ -z "$token_address" || "$token_address" == "null" ]]; then
  echo "Could not read tokenAddress from $summary_path" >&2
  exit 1
fi

echo "[chaos] post-check token: $token_address"

pushd "$ROOT_DIR/testing/devnet" >/dev/null

check_cmd=(
  docker compose
  -f docker-compose.yml
  -f ../docker-compose.perf.yml
  run --rm --no-deps
  -e RUN_ID="$RUN_ID"
  -e SCENARIO="token_settle_check"
  -e QUIET="$QUIET"
  -e TARGETS="$full_targets"
  -e TOKEN_ADDRESS="$token_address"
  -e EXPECT_SCRIPT="true"
  -e WAIT_FOR_RPC_SEC="240"
  # This scenario intentionally runs while the network may be busy applying committed state.
  # Mempool drain can take a long time under load + follower restart; rely on committed-read retries instead.
  -e MEMPOOL_DRAIN_ENABLE="0"
  -e CROSS_NODE_TIMEOUT_SEC="900"
  -e HOLDER_POINTER_TIMEOUT_SEC="900"
  -e SCRIPT_SETTLE_TIMEOUT_SEC="900"
  -e NODECALL_IN_FLUX_TIMEOUT_MS="15000"
)

for kv in "${EXTRA_ENV[@]}"; do
  check_cmd+=(-e "$kv")
done

check_cmd+=(loadgen)

"${check_cmd[@]}"

popd >/dev/null

echo "Run dir: testing/runs/$RUN_ID"
