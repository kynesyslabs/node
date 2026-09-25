#!/usr/bin/env bash
# Atomic Work end-to-end run: one command, its own network, torn down on exit.
#
#   SDK_BUILD=../sdks/build ./testing/atomic-work/e2e.sh
#
# SDK_BUILD     built SDK with atomicWork support (required)
# BASE_IMAGE    devnet node image to layer this tree onto (default demos-devnet-node:latest)
# PG_PORT       host port for the devnet Postgres (default 55432)
# DEVNET_DATA   directory holding identities/ and genesis.devnet.json, as set up
#               by testing/devnet/scripts/setup.sh (default testing/devnet)
# LOG           where the run's output is kept (default /tmp/atomic-work-e2e-<time>.log)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVNET="$ROOT/testing/devnet"
DEVNET_DATA="$(cd "${DEVNET_DATA:-$DEVNET}" && pwd)"
: "${SDK_BUILD:?SDK_BUILD must point at an SDK build with atomicWork support}"
SDK_BUILD="$(cd "$SDK_BUILD" && pwd)"
BASE_IMAGE="${BASE_IMAGE:-demos-devnet-node:latest}"
IMAGE="demos-devnet-node:atomic-e2e"
export POSTGRES_HOST_PORT="${PG_PORT:-55432}"
LOG="${LOG:-/tmp/atomic-work-e2e-$(date +%Y%m%dT%H%M%S).log}"
WORK="$(mktemp -d)"

step() { printf '\n[e2e] %s\n' "$*" | tee -a "$LOG"; }
compose() {
    # Relative mounts (identities, peer list, empty snapshot) and .env are
    # resolved against the devnet data directory.
    docker compose --project-directory "$DEVNET_DATA" \
        -f "$DEVNET/docker-compose.yml" -f "$DEVNET/docker-compose.fixture.yml" \
        -f "$WORK/compose.atomic.yml" "$@"
}
cleanup() {
    step "tearing down"
    compose down -v >>"$LOG" 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

step "identities"
if [ ! -f "$DEVNET_DATA/identities/node1.identity" ]; then
    echo "no devnet identities in $DEVNET_DATA: run testing/devnet/scripts/setup.sh first" | tee -a "$LOG"
    exit 2
fi
NODE1="$(cat "$DEVNET_DATA/identities/node1.pubkey")"

step "genesis: node-1 as the only validator, atomicWork active from height 0"
jq --arg a "$NODE1" '.validators = [.validators[] | select(.address == $a)] | .forks.atomicWork = {activationHeight: 0}' \
    "$DEVNET_DATA/genesis.devnet.json" >"$WORK/genesis.json"
{
    echo "services:"
    for s in node-1 node-2 node-3 node-4; do
        # One validator needs a committee floor of one.
        printf '  %s:\n    image: %s\n    environment:\n      - SHARD_SIZE=1\n    volumes:\n      - %s/genesis.json:/app/data/genesis.json:ro\n' \
            "$s" "$IMAGE" "$WORK"
    done
} >"$WORK/compose.atomic.yml"

step "image: this tree and the SDK build on top of $BASE_IMAGE"
mkdir -p "$WORK/ctx"
rsync -a --exclude '*.test.ts' "$ROOT/src" "$WORK/ctx/"
cp "$ROOT/tsconfig.json" "$WORK/ctx/"
cp -r "$SDK_BUILD" "$WORK/ctx/sdk-build"
cat >"$WORK/ctx/Dockerfile" <<DOCKERFILE
FROM $BASE_IMAGE
RUN rm -rf /app/src /app/node_modules/@kynesyslabs/demosdk/build
COPY src /app/src
COPY tsconfig.json /app/tsconfig.json
COPY sdk-build /app/node_modules/@kynesyslabs/demosdk/build
DOCKERFILE
docker build -q -t "$IMAGE" "$WORK/ctx" >>"$LOG"

height() {
    curl -s -m 5 -X POST localhost:53551 -H 'content-type: application/json' \
        -d '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{},"muid":"e2e"}]}' |
        grep -o '"response":[0-9]*' | cut -d: -f2
}
wait_for_blocks() {
    for _ in $(seq 1 "$1"); do
        [ "$(height || echo 0)" -ge 2 ] 2>/dev/null && return 0
        sleep 4
    done
    return 1
}

step "network up"
compose down -v >>"$LOG" 2>&1 || true
compose up -d --no-build postgres node-1 node-2 node-3 node-4 >>"$LOG" 2>&1
# node-1 can stall pairing with a peer that is still starting; one restart clears it.
wait_for_blocks 45 || { docker restart demos-devnet-node-1 >>"$LOG"; wait_for_blocks 40; }

step "scenario"
NODE_ROOT="$ROOT" SDK_BUILD="$SDK_BUILD" IDENTITIES="$DEVNET_DATA/identities" \
    bun "$ROOT/testing/atomic-work/e2e.ts" 2>&1 | grep -vE '^\[config\]|^bigint:' | tee -a "$LOG"
status=${PIPESTATUS[0]}
step "log kept at $LOG"
exit "$status"
