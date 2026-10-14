#!/usr/bin/env bash
# Fork activation rehearsal for signatureDomain + web2ProofBinding on a local
# 4-validator devnet. One command, its own network, torn down on exit.
#
#   ./testing/forks/rehearsal.sh
#
# ACTIVATION_HEIGHT  block height both forks are scheduled at (default 30)
# CHAIN_ID           genesis properties.id; the signature preimage binds to it (default 31337)
# CONSENSUS_TIME     seconds per block (default 10)
# PG_PORT            host port for the devnet Postgres (default 55433)
# IMAGE              node image tag; built from testing/devnet/Dockerfile when absent
# REBUILD=1          rebuild the image even if the tag exists (use after changing src/)
# NODE_MODULES_FROM  an installed node_modules to layer onto the bun image instead of
#                    running testing/devnet/Dockerfile (apt + bun install need the network)
# NODE_MEM / PG_MEM  per-container memory caps (default 4g / 1g)
# IMAGE_ONLY=1       build the image and stop
# KEEP=1             leave the network running afterwards, for debugging
# RUN_DIR            where genesis copies, logs and raw responses are kept
#                    (default testing/runs/fork-rehearsal-<time>, git-ignored)
#
# Exit status: 0 when every check passed, 1 when any failed, 2 when the host
# or setup could not run the rehearsal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVNET="$ROOT/testing/devnet"
PROJECT="forkrehearsal"
IMAGE="${IMAGE:-forkrehearsal-node:src}"
ACTIVATION_HEIGHT="${ACTIVATION_HEIGHT:-30}"
CHAIN_ID="${CHAIN_ID:-31337}"
CONSENSUS_TIME="${CONSENSUS_TIME:-10}"
PG_PORT="${PG_PORT:-55433}"
NODE_MEM="${NODE_MEM:-4g}"
PG_MEM="${PG_MEM:-1g}"
RUN_DIR="${RUN_DIR:-$ROOT/testing/runs/fork-rehearsal-$(date +%Y%m%dT%H%M%S)}"
DATA="$RUN_DIR/data"
LOGS="$RUN_DIR/logs"
mkdir -p "$DATA/identities" "$LOGS" "$RUN_DIR/steps"
MAIN_LOG="$LOGS/rehearsal.log"

step() { printf '\n[rehearsal] %s\n' "$*" | tee -a "$MAIN_LOG"; }
die() { printf '[rehearsal] %s\n' "$*" | tee -a "$MAIN_LOG"; exit 2; }

# The host is shared: refuse to start when it has no headroom.
step "host headroom"
avail_mb=$(free -m | awk '/^Mem:/ {print $7}')
load1=$(awk '{print $1}' /proc/loadavg)
cores=$(nproc)
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "available RAM ${avail_mb} MB, load ${load1} on ${cores} cores, free disk ${free_gb} GB" | tee -a "$MAIN_LOG"
[ "$avail_mb" -ge 4096 ] || die "less than 4 GB RAM available; not starting"
[ "$free_gb" -ge 10 ] || die "less than 10 GB disk free; not starting"
awk -v l="$load1" -v c="$cores" 'BEGIN { exit !(l <= c) }' || die "1-minute load ${load1} is above the ${cores} cores; not starting"

# The devnet binds fixed host ports; a collision would fail halfway through.
for port in 53551 53552 53553 53554 53555 53556 53557 53558 3005 3006 3007 3008 "$PG_PORT"; do
    if ss -ltn "sport = :$port" | grep -q LISTEN; then die "host port $port is already in use"; fi
done

# The devnet file interpolates PERSISTENT into a volume spec and rejects it empty;
# the override below replaces that volume list, so no named volume is created.
export POSTGRES_HOST_PORT="$PG_PORT" CONSENSUS_TIME PERSISTENT=1
compose() {
    # Relative mounts (identities, peer list, init SQL) resolve against DATA.
    docker compose -p "$PROJECT" --project-directory "$DATA" \
        -f "$DEVNET/docker-compose.yml" -f "$DATA/compose.rehearsal.yml" "$@"
}
cleanup() {
    step "collecting node logs and tearing down"
    [ -z "${EVENTS_PID:-}" ] || kill "$EVENTS_PID" 2>/dev/null || true
    for n in 1 2 3 4; do
        docker logs "$PROJECT-node-$n" >"$LOGS/node-$n.log" 2>&1 || true
    done
    # -v removes the anonymous volumes; nothing here uses a named one.
    compose down -v --remove-orphans >>"$MAIN_LOG" 2>&1 || true
}
[ "${KEEP:-0}" = 1 ] || trap cleanup EXIT

step "image $IMAGE"
if [ "${REBUILD:-0}" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    if [ -n "${NODE_MODULES_FROM:-}" ]; then
        # Offline path: this tree plus an installed node_modules on top of the
        # bun image. run-devnet needs nothing from the OS beyond bash and bun.
        ctx="$RUN_DIR/image-context"
        mkdir -p "$ctx"
        rsync -a --exclude node_modules --exclude .git --exclude testing/runs --exclude .dockerignore "$ROOT/" "$ctx/"
        rsync -aL "$NODE_MODULES_FROM/" "$ctx/node_modules/"
        cat >"$ctx/Dockerfile" <<'DOCKERFILE'
FROM oven/bun:latest
WORKDIR /app
COPY . .
ENV NODE_ENV=development
RUN chmod +x ./testing/devnet/run-devnet
ENTRYPOINT ["./testing/devnet/run-devnet"]
CMD []
DOCKERFILE
        docker build -q -t "$IMAGE" "$ctx" >>"$LOGS/image-build.log" 2>&1 || die "image build failed, see $LOGS/image-build.log"
        rm -rf "$ctx"
    else
        docker build -q -f "$DEVNET/Dockerfile" -t "$IMAGE" "$ROOT" >>"$LOGS/image-build.log" 2>&1 ||
            die "image build failed, see $LOGS/image-build.log"
    fi
fi

[ "${IMAGE_ONLY:-0}" != 1 ] || { echo "image ready: $IMAGE" | tee -a "$MAIN_LOG"; exit 0; }

step "identities: 4 validators, two senders (alice, carol) and a recipient (bob)"
names=(node1 node2 node3 node4 alice bob carol)
for name in "${names[@]}"; do
    out="$(cd "$ROOT" && bun "$DEVNET/scripts/generate-identity-helper.ts")"
    printf '%s\n' "$(grep '^MNEMONIC:' <<<"$out" | cut -d: -f2-)" >"$DATA/identities/$name.identity"
    printf '%s\n' "$(grep '^PUBKEY:' <<<"$out" | cut -d: -f2-)" >"$DATA/identities/$name.pubkey"
done
pub() { cat "$DATA/identities/$1.pubkey"; }

step "genesis: both forks at height $ACTIVATION_HEIGHT, chain id $CHAIN_ID"
ports=(53551 53553 53555 53557)
validators='[]'
balances='[]'
peerlist='{}'
for i in 1 2 3 4; do
    validators=$(jq --arg a "$(pub node$i)" --arg u "http://node-$i:${ports[$((i - 1))]}" \
        '. + [{address: $a, status: "2", connection_url: $u, staked_amount: "1000000000000000000", first_seen: 0, valid_at: 0}]' <<<"$validators")
    balances=$(jq --arg a "$(pub node$i)" '. + [[$a, "1000000000000000000"]]' <<<"$balances")
    peerlist=$(jq --arg a "$(pub node$i)" --arg u "http://node-$i:${ports[$((i - 1))]}" '. + {($a): $u}' <<<"$peerlist")
done
for who in alice carol; do
    balances=$(jq --arg a "$(pub $who)" '. + [[$a, "1000000000000000000"]]' <<<"$balances")
done
jq --argjson h "$ACTIVATION_HEIGHT" --argjson cid "$CHAIN_ID" --argjson v "$validators" --argjson b "$balances" '
    .properties.id = $cid
    | .validators = $v
    | .balances = $b
    | .forks.signatureDomain = {activationHeight: $h}
    | .forks.web2ProofBinding = {activationHeight: $h}' \
    "$DEVNET/genesis.devnet.json" >"$DATA/genesis.json"
printf '%s\n' "$peerlist" >"$DATA/demos_peerlist.json"
# One genesis file per node, so the mixed-version step can change a single one.
for i in 1 2 3 4; do cp "$DATA/genesis.json" "$DATA/genesis.node$i.json"; done
cp -r "$DEVNET/postgres-init" "$DEVNET/l2ps" "$DATA/"
mkdir -p "$DATA/empty-snapshot"

step "compose override: unique names, memory caps, no notary container"
{
    echo "services:"
    echo "  postgres:"
    echo "    container_name: $PROJECT-postgres"
    echo "    mem_limit: $PG_MEM"
    # Database in memory: nothing to leak, and PERSISTENT's named volume stays unused.
    echo "    volumes: !override"
    echo "      - ./postgres-init:/docker-entrypoint-initdb.d:ro"
    echo "    tmpfs:"
    echo "      - /var/lib/postgresql/data"
    for i in 1 2 3 4; do
        echo "  node-$i:"
        echo "    image: $IMAGE"
        echo "    container_name: $PROJECT-node-$i"
        echo "    mem_limit: $NODE_MEM"
        echo "    depends_on: !override"
        echo "      postgres:"
        echo "        condition: service_healthy"
        [ "$i" = 1 ] || printf '      node-1:\n        condition: service_started\n'
        echo "    environment:"
        echo "      - TLSNOTARY_ENABLED=false"
        echo "    volumes:"
        echo "      - ./identities/node$i.identity:/app/.demos_identity:ro"
        echo "      - ./demos_peerlist.json:/app/demos_peerlist.json:ro"
        echo "      - ./l2ps:/app/data/l2ps:ro"
        # Node 4 may rewrite its genesis from a peer on a hash mismatch (step 5 shows it).
        if [ "$i" = 4 ]; then echo "      - ./genesis.node4.json:/app/data/genesis.json"; else echo "      - ./genesis.node$i.json:/app/data/genesis.json:ro"; fi
        echo "      - ./empty-snapshot:/app/data/snapshot:ro"
    done
} >"$DATA/compose.rehearsal.yml"

rpc_height() {
    curl -s -m 5 -X POST "localhost:$1" -H 'content-type: application/json' \
        -d '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{},"muid":"rehearsal"}]}' |
        grep -o '"response":[0-9]*' | cut -d: -f2
}
wait_for_blocks() {
    for _ in $(seq 1 "$1"); do
        [ "$(rpc_height 53551 || echo 0)" -ge 2 ] 2>/dev/null && return 0
        sleep 4
    done
    return 1
}

step "network up (staggered: node 1 initialises genesis before the others pair with it)"
# Engine-level record of every start, die (with exit code) and oom of these containers.
docker events --filter "container=$PROJECT-node-1" --filter "container=$PROJECT-node-2" \
    --filter "container=$PROJECT-node-3" --filter "container=$PROJECT-node-4" --filter "container=$PROJECT-postgres" \
    --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}} exit={{.Actor.Attributes.exitCode}}' \
    >"$LOGS/docker-events.log" 2>&1 &
EVENTS_PID=$!
compose up -d --no-build postgres node-1 >>"$LOGS/compose-up.log" 2>&1 ||
    die "compose up failed, see $LOGS/compose-up.log"
for _ in $(seq 1 30); do
    [ -n "$(rpc_height 53551 2>/dev/null)" ] && break
    sleep 2
done
compose up -d --no-build node-2 node-3 node-4 >>"$LOGS/compose-up.log" 2>&1 ||
    die "compose up failed, see $LOGS/compose-up.log"
# node-1 can still stall pairing with a peer that is slow to start; one restart clears it.
wait_for_blocks 45 || { docker restart "$PROJECT-node-1" >>"$MAIN_LOG"; wait_for_blocks 40; } ||
    die "no blocks produced, see $LOGS"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep "^$PROJECT" | tee -a "$MAIN_LOG"

step "scenario"
set +e
ROOT="$ROOT" RUN_DIR="$RUN_DIR" PROJECT="$PROJECT" ACTIVATION_HEIGHT="$ACTIVATION_HEIGHT" CHAIN_ID="$CHAIN_ID" \
    CONSENSUS_TIME="$CONSENSUS_TIME" PG_PORT="$PG_PORT" \
    bun "$ROOT/testing/forks/rehearsal.ts" 2>&1 | grep --line-buffered -vE '^\[config\]|^bigint:' | tee "$LOGS/scenario.log"
scenario_status=${PIPESTATUS[0]}
set -e

pass=$(grep -c '^PASS ' "$LOGS/scenario.log" || true)
fail=$(grep -c '^FAIL ' "$LOGS/scenario.log" || true)
step "summary: $pass checks passed, $fail failed (scenario exit $scenario_status)"
echo "run directory: $RUN_DIR" | tee -a "$MAIN_LOG"
[ "$fail" -eq 0 ] && [ "$scenario_status" -eq 0 ] && [ "$pass" -gt 0 ] && exit 0
exit 1
