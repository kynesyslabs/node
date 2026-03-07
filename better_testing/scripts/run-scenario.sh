#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  run-scenario.sh <scenario> [--build] [--run-id <id>] [--quiet|--verbose] [--env KEY=VALUE ...]

Examples:
  run-scenario.sh token_edge_cases
  run-scenario.sh token_acl_matrix --build
  run-scenario.sh token_transfer_ramp --env RAMP_CONCURRENCY=1,2,4,8 --env STEP_DURATION_SEC=15
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

SCENARIO="${1:-}"
if [[ -z "$SCENARIO" ]]; then
  usage
  exit 2
fi
shift || true

BUILD=0
QUIET=true
RUN_ID=""
EXTRA_ENV=()

while [[ $# -gt 0 ]]; do
  case "$1" in
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
  RUN_ID="${SCENARIO}-$(date -u +%Y%m%d-%H%M%S)"
fi

pushd devnet >/dev/null

if [[ "$BUILD" -eq 1 ]]; then
  docker compose build node-1
fi

cmd=(
  docker compose
  -f docker-compose.yml
  -f ../better_testing/docker-compose.perf.yml
  run --rm --no-deps
  -e RUN_ID="$RUN_ID"
  -e SCENARIO="$SCENARIO"
  -e QUIET="$QUIET"
)

for kv in "${EXTRA_ENV[@]}"; do
  if [[ -z "$kv" || "$kv" != *"="* ]]; then
    echo "Invalid --env value (expected KEY=VALUE): $kv" >&2
    exit 2
  fi
  cmd+=(-e "$kv")
done

cmd+=(loadgen)

"${cmd[@]}"
popd >/dev/null

echo "Run dir: better_testing/runs/$RUN_ID"

