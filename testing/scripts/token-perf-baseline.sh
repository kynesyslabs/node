#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  token-perf-baseline.sh [--build] [--quiet|--verbose] [--with-pointers] [--env KEY=VALUE ...]

Runs:
  - token_transfer_ramp
  - token_mint_ramp
  - token_burn_ramp

Examples:
  token-perf-baseline.sh --build
  token-perf-baseline.sh --env STEP_DURATION_SEC=10 --env RAMP_CONCURRENCY=1,2,4
  token-perf-baseline.sh --with-pointers
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BUILD=0
QUIET=true
WITH_POINTERS=0
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
    --with-pointers)
      WITH_POINTERS=1
      shift
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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

common_args=()
if [[ "$QUIET" == "true" ]]; then common_args+=(--quiet); else common_args+=(--verbose); fi

env_args=()
if [[ "$WITH_POINTERS" -eq 0 ]]; then
  env_args+=(--env POST_RUN_HOLDER_POINTER_CHECK=false)
fi
for kv in "${EXTRA_ENV[@]}"; do
  env_args+=(--env "$kv")
done

build_first_args=()
if [[ "$BUILD" -eq 1 ]]; then build_first_args+=(--build); fi

"$SCRIPT_DIR/run-scenario.sh" token_transfer_ramp "${common_args[@]}" "${build_first_args[@]}" "${env_args[@]}"
"$SCRIPT_DIR/run-scenario.sh" token_mint_ramp "${common_args[@]}" "${env_args[@]}"
"$SCRIPT_DIR/run-scenario.sh" token_burn_ramp "${common_args[@]}" "${env_args[@]}"
