#!/usr/bin/env bash
# Same-height commit race on a local 4-validator devnet, in one command.
#
#   run.sh [--image IMAGE] [--src TREE] <control|race|race-strict> [label]
#
# Boots postgres + 4 validators (shardSize 4, quorum 3) from a prebuilt
# image, injects the fault described in README.md at a target height, and
# decides pass/fail from the block hash every node holds at that height.
# Everything lives in a per-run dir under runs/ (gitignored: it holds the
# devnet keys) and is torn down on exit, failure or Ctrl-C.
#
# Exit codes: 0 pass, 1 fail (fork, or undetected fork for race-strict),
# 2 the run could not be carried out (preflight, boot, timing).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"

IMAGE="${IMAGE:-demos-node:candidate-5979a716}"
SRC_TREE="${SRC_TREE:-}"
NETSHOOT_IMAGE="${NETSHOOT_IMAGE:-nicolaka/netshoot:latest}"
CONSENSUS_TIME="${CONSENSUS_TIME:-10}"
NODE_MEM="${NODE_MEM:-2g}"
RUNS_DIR="${RUNS_DIR:-${HERE}/runs}"
MIN_DISK_GB="${MIN_DISK_GB:-10}"
MIN_RAM_MB="${MIN_RAM_MB:-4096}"
MAX_LOAD="${MAX_LOAD:-32}"
# Block 1 cannot be forged before genesis time + CONSENSUS_TIME, so a genesis
# this far in the future holds the chain until all four nodes are up: a node
# that joins after the first blocks may never learn the others' height on
# older code (it drops sync data above its head and gossip is off)
GENESIS_DELAY="${GENESIS_DELAY:-120}"

usage() {
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    echo "Environment: IMAGE SRC_TREE NETSHOOT_IMAGE CONSENSUS_TIME NODE_MEM RUNS_DIR"
    echo "             MIN_DISK_GB MIN_RAM_MB MAX_LOAD (see README.md)"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        --src) SRC_TREE="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --*) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
        *) break ;;
    esac
done

MODE="${1:-}"
LABEL="${2:-run}"
case "${MODE}" in
    control|race|race-strict) ;;
    *) usage >&2; exit 2 ;;
esac
if [[ ! "${LABEL}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "label must match [A-Za-z0-9_-]+" >&2; exit 2
fi
if [ -n "${SRC_TREE}" ]; then
    SRC_TREE="$(cd "${SRC_TREE}" 2>/dev/null && pwd)" || { echo "--src: no such dir" >&2; exit 2; }
    [ -f "${SRC_TREE}/src/index.ts" ] || { echo "--src: ${SRC_TREE}/src/index.ts not found" >&2; exit 2; }
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${MODE}-${LABEL}"
RUN_DIR="${RUNS_DIR}/${RUN_ID}"
LOG_DIR="${RUN_DIR}/logs"
# Compose project names allow [a-z0-9_-] only
PROJECT="crace-$(echo "${RUN_ID}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')"
mkdir -p "${LOG_DIR}" "${RUN_DIR}/inputs/empty-snapshot"

say() { echo "[race $(date -u +%H:%M:%S)] $*" | tee -a "${LOG_DIR}/run.log"; }

# Read natively by docker compose, so orchestrate.sh shares the same stack
export COMPOSE_PATH_SEPARATOR=":"
export COMPOSE_FILE="${HERE}/docker-compose.race.yml"
[ -n "${SRC_TREE}" ] && COMPOSE_FILE="${COMPOSE_FILE}:${HERE}/docker-compose.src.yml"
ENVFILE="${RUN_DIR}/compose.env"
dc() { docker compose --env-file "${ENVFILE}" -p "${PROJECT}" "$@"; }

STARTED_STACK=0
teardown() {
    local rc=$?
    trap - EXIT INT TERM
    if [ "${STARTED_STACK}" = 1 ]; then
        say "collecting container logs"
        for i in 1 2 3 4; do
            local cid
            cid=$(dc ps -q "node-${i}" 2>/dev/null)
            [ -n "${cid}" ] && docker logs "${cid}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${LOG_DIR}/node-${i}.log"
        done
        say "tearing down ${PROJECT}"
        for i in 1 2 3 4; do docker rm -f "${PROJECT}-fault-${i}" >/dev/null 2>&1 || true; done
        dc down -v --remove-orphans >"${LOG_DIR}/teardown.log" 2>&1 || true
    fi
    say "run dir: ${RUN_DIR}"
    exit "${rc}"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# ── 1. preflight ────────────────────────────────────────────────────────
step=01-preflight
{
    df -h /
    free -m
    echo "nproc $(nproc)"
    uptime
    vmstat 1 4
} > "${LOG_DIR}/${step}.log" 2>&1
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
avail_mb=$(free -m | awk '/^Mem:/{print $7}')
load1=$(cut -d' ' -f1 /proc/loadavg)
# Swapping in every one of the last three 1 s samples (si or so); the first
# vmstat line averages since boot
swapping=$(vmstat 1 4 | tail -3 | awk '$7 + $8 > 0 {n++} END {print (n == 3) ? 1 : 0}')
say "preflight: disk ${disk_gb}G free, ${avail_mb}M RAM available, load ${load1}, swapping=${swapping}"
abort_pre() {
    say "ABORT: $*"
    ps -eo pid,comm,rss,%cpu --sort=-rss | head -8 >> "${LOG_DIR}/${step}.log"
    exit 2
}
[ "${disk_gb:-0}" -lt "${MIN_DISK_GB}" ] && abort_pre "free disk ${disk_gb}G < ${MIN_DISK_GB}G"
[ "${avail_mb:-0}" -lt "${MIN_RAM_MB}" ] && abort_pre "available RAM ${avail_mb}M < ${MIN_RAM_MB}M"
awk -v l="${load1}" -v m="${MAX_LOAD}" 'BEGIN { exit !(l > m) }' && abort_pre "load ${load1} > ${MAX_LOAD}"
[ "${swapping}" = 1 ] && abort_pre "the host is actively swapping"
for img in "${IMAGE}" "${NETSHOOT_IMAGE}" postgres:16-alpine; do
    docker image inspect "${img}" >/dev/null 2>&1 || abort_pre "image ${img} is not present locally"
done
IMAGE_ID=$(docker image inspect "${IMAGE}" --format '{{.Id}}')
CODE="image"
[ -n "${SRC_TREE}" ] && CODE="src:${SRC_TREE}@$(git -C "${SRC_TREE}" rev-parse --short HEAD 2>/dev/null || echo '?')$(git -C "${SRC_TREE}" diff --quiet HEAD -- src 2>/dev/null || echo '+dirty')"
say "mode=${MODE} label=${LABEL} image=${IMAGE} (${IMAGE_ID:7:12}) code=${CODE}"

# ── 2. run inputs: identities, shardSize-4 genesis, anchor peerlist ─────
step=02-inputs
GENESIS_TS=$(( $(date -u +%s) + GENESIS_DELAY ))
{
    for i in 1 2 3 4; do
        out=$(cd "${REPO_ROOT}" && bun testing/devnet/scripts/generate-identity-helper.ts) || exit 1
        echo "${out}" | grep '^MNEMONIC:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/node${i}.identity"
        echo "${out}" | grep '^PUBKEY:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/pub${i}"
    done
    chmod 600 "${RUN_DIR}"/inputs/node*.identity
    chmod 700 "${RUN_DIR}"
    python3 - "${RUN_DIR}/inputs" "${REPO_ROOT}" "${GENESIS_TS}" <<'PY'
import json, sys
inputs, repo, genesis_ts = sys.argv[1], sys.argv[2], sys.argv[3]
g = json.load(open(f"{repo}/testing/devnet/genesis.devnet.json"))
g["timestamp"] = genesis_ts
pubs = [open(f"{inputs}/pub{i}").read().strip() for i in (1, 2, 3, 4)]
ports = ["53551", "53553", "53555", "53557"]
# Stock devnet uses 10, whose committee floor 4 nodes can never reach
g["properties"]["shardSize"] = 4
stake = "1000000000000000000"
g["validators"] = [
    {"address": pk, "status": "2", "connection_url": f"http://node-{i + 1}:{ports[i]}",
     "staked_amount": stake, "first_seen": 0, "valid_at": 0}
    for i, pk in enumerate(pubs)
]
others = [b for b in g.get("balances", []) if b[0] not in set(pubs)]
g["balances"] = [[pk, stake] for pk in pubs] + others
json.dump(g, open(f"{inputs}/genesis.json", "w"), indent=2)
# Every node seeds only node-1 and learns the rest from it: a full seed list
# makes a node fail hard on a peer that is not up yet at a cold start
json.dump({pubs[0]: "http://node-1:53551"}, open(f"{inputs}/peerlist.json", "w"), indent=2)
print("genesis shardSize", g["properties"]["shardSize"], "validators", len(pubs))
PY
} > "${LOG_DIR}/${step}.log" 2>&1 || { say "ABORT: generating inputs failed (see ${step}.log)"; exit 2; }
say "inputs ready"

cat > "${ENVFILE}" <<EOF
RACE_IMAGE=${IMAGE}
RUN_DIR=${RUN_DIR}
SRC_TREE=${SRC_TREE:-/nonexistent}
CONSENSUS_TIME=${CONSENSUS_TIME}
NODE_MEM=${NODE_MEM}
EOF

# ── 3. staggered bring-up ───────────────────────────────────────────────
step=03-bringup
STARTED_STACK=1
cid_of() { dc ps -q "node-$1" 2>/dev/null; }
port_of() { echo $((53549 + 2 * $1)); }
serving() { docker exec "$(cid_of "$1")" curl -sS -m3 "http://localhost:$(port_of "$1")/" 2>/dev/null | grep -q Hello; }
wait_serve() {
    local deadline=$((SECONDS + $2))
    while [ ${SECONDS} -lt ${deadline} ]; do
        serving "$1" && return 0
        sleep 3
    done
    return 1
}
dc up -d postgres >> "${LOG_DIR}/${step}.log" 2>&1
for n in 1 2 3 4; do
    dc up -d "node-${n}" >> "${LOG_DIR}/${step}.log" 2>&1
    wait_serve "${n}" 180 || { say "ABORT: node-${n} did not serve within 180s"; exit 2; }
    say "node-${n} serving"
    # One node at a time: a simultaneous join races the committee freeze and
    # can leave a node partitioned, which it cannot sync back from without
    # gossip
    [ "${n}" -lt 4 ] && sleep 8
done
wait_s=$((GENESIS_TS - $(date -u +%s)))
if [ "${wait_s}" -lt 0 ]; then
    say "WARNING: all four were up only $((-wait_s))s after the genesis time; a late joiner may stay at genesis (raise GENESIS_DELAY)"
else
    say "all four up ${wait_s}s before the genesis time"
fi
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' \
    $(dc ps -q) >> "${LOG_DIR}/${step}.log" 2>&1

# ── 4. fault injection and verdict ──────────────────────────────────────
export MODE PROJECT RUN_DIR LOG_DIR ENVFILE NETSHOOT_IMAGE CONSENSUS_TIME CODE IMAGE
"${HERE}/orchestrate.sh"
rc=$?
free -m | sed -n 2p | sed 's/^/host after run: /' >> "${LOG_DIR}/run.log"
exit "${rc}"
