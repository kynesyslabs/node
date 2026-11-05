#!/usr/bin/env bash
# Quorum failure drills on a local N-validator devnet, one command per drill.
#
#   run.sh [--image IMAGE] [--src TREE] [--binding on|off] <scenario> [label]
#
# Scenarios (see README.md for what each one asserts):
#   floor           4 validators, shardSize 10: the chain never forges block 1
#   drop-n7s7       7 validators, shardSize 7: stop 1, 2, 3 in turn
#   drop-n7s10      7 validators, shardSize 10: stop 1
#   drop-n10s10     10 validators, shardSize 10: stop 1, 2, 3, 4 in turn
#   halt-n10s10     10 validators, shardSize 10: stop 4 at once (6 live < q), hold, restart
#   halt-n13s10     13 validators, shardSize 10: stop 7 at once (6 live < q), hold, restart
#   ride-n13s10     13 validators, shardSize 10: stop 3 at once, the chain must keep forging
#   listed-stall    10 staked, 7 running: stop 1 listed, start the 3 others
#   fallback        10 validators: the last block lists 6 (< 7) of them
#   partition       6 validators, shardSize 4: split 3 + 3, then heal
#
# Everything lives in a per-run dir under runs/ (gitignored: it holds the
# devnet keys) and is torn down on exit, failure or Ctrl-C.
# Exit codes: 0 pass, 1 fail, 2 the run could not be carried out (ERROR: a node
# stopped answering mid-window, or postgres hit its connection limit: no verdict).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"

IMAGE="${IMAGE:-demos-node:candidate-5979a716}"
SRC_TREE="${SRC_TREE:-}"
BINDING="${BINDING:-on}"
NETSHOOT_IMAGE="${NETSHOOT_IMAGE:-nicolaka/netshoot:latest}"
CONSENSUS_TIME="${CONSENSUS_TIME:-10}"
NODE_MEM="${NODE_MEM:-1800m}"
# What one node actually holds once running (about 1.1 GB on the candidate
# image, page cache included), used to size the preflight RAM check
NODE_EST_MB="${NODE_EST_MB:-1100}"
HEADROOM_MB="${HEADROOM_MB:-3072}"
RUNS_DIR="${RUNS_DIR:-${HERE}/runs}"
MIN_DISK_GB="${MIN_DISK_GB:-10}"
LOCKSTEP_TIMEOUT="${LOCKSTEP_TIMEOUT:-420}"
PROGRESS_BLOCKS="${PROGRESS_BLOCKS:-3}"
PROGRESS_TIMEOUT="${PROGRESS_TIMEOUT:-180}"
STALL_WINDOW="${STALL_WINDOW:-120}"
PARTITION_TIME="${PARTITION_TIME:-120}"
SETTLE_TIMEOUT="${SETTLE_TIMEOUT:-300}"
# Curl timeout (s) of the retry after an empty or timed-out read of a node's head or hash
READ_TIMEOUT="${READ_TIMEOUT:-8}"
# Seconds a read of a node's database may take (scenario 12's DB_READ_TIMEOUT_MS)
DB_READ_TIMEOUT="${DB_READ_TIMEOUT:-30}"
# halt-* and ride-* drills; the defaults are scenario 12's
BASELINE_HEIGHT="${BASELINE_HEIGHT:-6}"
SETTLE_ROUNDS="${SETTLE_ROUNDS:-2}"
HALT_ROUNDS="${HALT_ROUNDS:-12}"
RECOVERY_BLOCKS="${RECOVERY_BLOCKS:-3}"
RECOVERY_TIMEOUT="${RECOVERY_TIMEOUT:-300}"
RIDE_BLOCKS="${RIDE_BLOCKS:-5}"
RIDE_TIMEOUT="${RIDE_TIMEOUT:-300}"

usage() {
    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
    echo "Environment: IMAGE SRC_TREE BINDING CONSENSUS_TIME NODE_MEM NODE_EST_MB HEADROOM_MB"
    echo "             RUNS_DIR MIN_DISK_GB STALL_WINDOW PROGRESS_TIMEOUT PARTITION_TIME READ_TIMEOUT DB_READ_TIMEOUT (README.md)"
    echo "             BASELINE_HEIGHT SETTLE_ROUNDS HALT_ROUNDS RECOVERY_BLOCKS RECOVERY_TIMEOUT"
    echo "             RIDE_BLOCKS RIDE_TIMEOUT (halt-* and ride-* drills)"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        --src) SRC_TREE="$2"; shift 2 ;;
        --binding) BINDING="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --*) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
        *) break ;;
    esac
done

SCENARIO="${1:-}"
LABEL="${2:-run}"
# N validators, shardSize, validators started at bring-up, sequential stops
case "${SCENARIO}" in
    floor) N=4; SHARD=10; START=4 ;;
    drop-n7s7) N=7; SHARD=7; START=7; STOPS=3 ;;
    drop-n7s10) N=7; SHARD=10; START=7; STOPS=1 ;;
    drop-n10s10) N=10; SHARD=10; START=10; STOPS=4 ;;
    halt-n10s10) N=10; SHARD=10; START=10; STOPS=4 ;;
    halt-n13s10) N=13; SHARD=10; START=13; STOPS=7 ;;
    ride-n13s10) N=13; SHARD=10; START=13; STOPS=3 ;;
    listed-stall) N=10; SHARD=10; START=7 ;;
    fallback) N=10; SHARD=10; START=10 ;;
    partition) N=6; SHARD=4; START=6 ;;
    *) usage >&2; exit 2 ;;
esac
# The halt and ride drills always run with gossip on, whatever the environment
# says. With it off a restarted node never learns that the network is ahead:
# a height claim above its own chain is refused unless it comes as a gossip
# claim (Sync.ts:133-143, networkAheadVeto.ts:59-72), so the recovery result
# would measure that and not the halt. The other scenarios keep the harness
# default (off; GOSSIP_ENABLED=true in the environment turns it on).
case "${SCENARIO}" in halt-n10s10|halt-n13s10|ride-n13s10) export GOSSIP_ENABLED=true ;; esac
# The mainnet-shape drills run the fork set docs/mainnet/genesis.template.json
# launches with (every fork it sets to 0, the rest off), read at run time. The
# other scenarios keep the forks of genesis.devnet.json.
FORK_SET=devnet
case "${SCENARIO}" in halt-n10s10|halt-n13s10|ride-n13s10) FORK_SET=launch ;; esac
case "${BINDING}" in on|off) ;; *) echo "--binding must be on or off" >&2; exit 2 ;; esac
[[ "${DB_READ_TIMEOUT}" =~ ^[1-9][0-9]*$ ]] || { echo "DB_READ_TIMEOUT must be a positive number of seconds" >&2; exit 2; }
if [ "${FORK_SET}" = launch ] && [ "${BINDING}" != on ]; then
    echo "${SCENARIO} runs the launch fork set, which activates committeeBinding: --binding off does not apply" >&2; exit 2
fi
if [[ ! "${LABEL}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "label must match [A-Za-z0-9_-]+" >&2; exit 2
fi
if [ -n "${SRC_TREE}" ]; then
    SRC_TREE="$(cd "${SRC_TREE}" 2>/dev/null && pwd)" || { echo "--src: no such dir" >&2; exit 2; }
    [ -f "${SRC_TREE}/src/index.ts" ] || { echo "--src: ${SRC_TREE}/src/index.ts not found" >&2; exit 2; }
fi
Q=$(( SHARD * 2 / 3 + 1 ))
GENESIS_DELAY="${GENESIS_DELAY:-$((60 + START * 25))}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SCENARIO}-${BINDING}-${LABEL}"
RUN_DIR="${RUNS_DIR}/${RUN_ID}"
LOG_DIR="${RUN_DIR}/logs"
# Compose project names allow [a-z0-9_-] only
PROJECT="qdrill-$(echo "${RUN_ID}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')"
mkdir -p "${LOG_DIR}" "${RUN_DIR}/inputs/empty-snapshot"
chmod 700 "${RUN_DIR}"
EVENTS="${LOG_DIR}/events.log"
PHASES="${RUN_DIR}/phases.tsv"
printf 'phase\tdown\tlive\tfrom\tto\tblocks\tmean_s\tmax_s\toutcome\n' > "${PHASES}"

STEP_LOG="${LOG_DIR}/run.log"
say() { echo "[qdrill $(date -u +%H:%M:%S)] $*" | tee -a "${LOG_DIR}/run.log"; [ "${STEP_LOG}" != "${LOG_DIR}/run.log" ] && echo "[qdrill $(date -u +%H:%M:%S)] $*" >> "${STEP_LOG}"; return 0; }
step() { STEP_LOG="${LOG_DIR}/$1.log"; say "── $1"; }
event() { echo "$(date -u +%H:%M:%S) $*" >> "${EVENTS}"; }

dc() { docker compose -f "${RUN_DIR}/compose.yml" -p "${PROJECT}" "$@"; }

STARTED_STACK=0
SIDECARS=()
teardown() {
    local rc=$?
    trap - EXIT INT TERM
    if [ "${STARTED_STACK}" = 1 ]; then
        say "collecting container logs"
        local i cid
        for i in $(seq 1 "${N}"); do
            cid=$(dc ps -aq "node-${i}" 2>/dev/null)
            [ -n "${cid}" ] && docker logs "${cid}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${LOG_DIR}/node-${i}.log"
        done
        # Backstop for the exits that skip pg_limit_gate (an early exit 0 or 1):
        # a connection-limit hit in the collected logs is never a result
        if [ "${rc}" -le 1 ] && grep -aq "too many clients" "${LOG_DIR}"/node-*.log "${LOG_DIR}/psql-errors.log" 2>/dev/null; then
            say "ABORT: could not run: postgres connection limit hit (exit ${rc} replaced by 2; see ${LOG_DIR}/node-*.log)"
            rc=2
        fi
        say "tearing down ${PROJECT}"
        for s in "${SIDECARS[@]}"; do docker rm -f "${s}" >/dev/null 2>&1 || true; done
        dc down -v --remove-orphans >"${LOG_DIR}/teardown.log" 2>&1 || true
    fi
    say "run dir: ${RUN_DIR}"
    exit "${rc}"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# ── 1. preflight ────────────────────────────────────────────────────────
step 01-preflight
{
    df -h /
    free -m
    echo "nproc $(nproc)"
    uptime
    vmstat 1 5
    docker ps --format '{{.Names}}' | grep -E '^(crace|qdrill)-' | sed 's/^/harness container running: /'
} >> "${STEP_LOG}" 2>&1
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
avail_mb=$(free -m | awk '/^Mem:/{print $7}')
load1=$(cut -d' ' -f1 /proc/loadavg)
cores=$(nproc)
need_mb=$(( START * NODE_EST_MB + 256 + HEADROOM_MB ))
# Swapping in every one of the last three 1 s samples (si or so); the first
# vmstat line averages since boot
swapping=$(vmstat 1 4 | tail -3 | awk '$7 + $8 > 0 {n++} END {print (n == 3) ? 1 : 0}')
say "preflight: disk ${disk_gb}G free, ${avail_mb}M RAM available (need ${need_mb}M), load ${load1}/${cores}, swapping=${swapping}"
abort_pre() {
    say "ABORT: $*"
    ps -eo pid,comm,rss,%cpu --sort=-rss | head -10 >> "${STEP_LOG}"
    exit 2
}
[ "${disk_gb:-0}" -lt "${MIN_DISK_GB}" ] && abort_pre "free disk ${disk_gb}G < ${MIN_DISK_GB}G"
[ "${avail_mb:-0}" -lt "${need_mb}" ] && abort_pre "available RAM ${avail_mb}M < ${need_mb}M for ${START} nodes"
awk -v l="${load1}" -v m="${cores}" 'BEGIN { exit !(l > m) }' && abort_pre "load ${load1} > ${cores} cores"
[ "${swapping}" = 1 ] && abort_pre "the host is actively swapping"
# One devnet at a time on this host: the race harness or another drill
docker ps --format '{{.Names}}' | grep -qE '^(crace|qdrill)-' && abort_pre "another harness stack is running"
for img in "${IMAGE}" "${NETSHOOT_IMAGE}" postgres:16-alpine; do
    docker image inspect "${img}" >/dev/null 2>&1 || abort_pre "image ${img} is not present locally"
done
IMAGE_ID=$(docker image inspect "${IMAGE}" --format '{{.Id}}')
# The image's user (uid 1000 in the release image, root in the devnet image),
# read from the image: the node tmpfs is mounted owned by it
IMAGE_UID=$(docker run --rm --network none --memory 64m --entrypoint id "${IMAGE}" -u 2>/dev/null)
IMAGE_GID=$(docker run --rm --network none --memory 64m --entrypoint id "${IMAGE}" -g 2>/dev/null)
[[ "${IMAGE_UID}" =~ ^[0-9]+$ && "${IMAGE_GID}" =~ ^[0-9]+$ ]] ||
    abort_pre "could not read the user of ${IMAGE} (id -u '${IMAGE_UID}', id -g '${IMAGE_GID}')"

# How a node starts, decided by looking in the image. A devnet-style image
# (testing/devnet/Dockerfile) carries testing/devnet/run-devnet and the nodes
# exec it. A release image (root Dockerfile) copies only src/ scripts/ data/
# sdk/ libs/ sidecar/ (Dockerfile:47-53), so it has no run-devnet and the nodes
# run its own ENTRYPOINT and CMD, as mainnet does.
docker run --rm --network none --memory 64m --entrypoint sh "${IMAGE}" -c '[ -e ./testing/devnet/run-devnet ]' >/dev/null 2>&1
case $? in
    0) START_PATH=run-devnet ;;
    1) START_PATH=image ;;
    *) abort_pre "could not look for ./testing/devnet/run-devnet in ${IMAGE}: docker run failed (no sh in the image?)" ;;
esac
IMAGE_ENTRYPOINT=$(docker image inspect "${IMAGE}" --format '{{json .Config.Entrypoint}}')
IMAGE_CMD=$(docker image inspect "${IMAGE}" --format '{{json .Config.Cmd}}')
# What the node service execs, each of which must exist and be executable for
# the image's user (the one `docker run` uses by default, as the node does).
# run-devnet path: bash -lc ... exec run-devnet, which starts bun. Image path:
# /bin/sh -c 'cp ... && exec "$@"' with the image's entrypoint then its CMD.
if [ "${START_PATH}" = image ]; then
    EXEC_NEEDED=(sh cp)
    while IFS= read -r p; do [ -n "${p}" ] && EXEC_NEEDED+=("${p}"); done < <(
        { jq -r '.[0] // empty' <<< "${IMAGE_ENTRYPOINT}"; jq -r '.[0] // empty' <<< "${IMAGE_CMD}"; } 2>/dev/null)
else
    EXEC_NEEDED=(bash cp ./testing/devnet/run-devnet bun)
fi
exec_fail=$(docker run --rm --network none --memory 64m --entrypoint sh "${IMAGE}" -c '
    for p in "$@"; do
        case "${p}" in
            */*) [ -f "${p}" ] && [ -x "${p}" ] || { echo "${p} is missing or not executable for uid $(id -u) in $(pwd)"; exit 1; } ;;
            *) command -v "${p}" >/dev/null 2>&1 || { echo "${p} is not on PATH (${PATH})"; exit 1; } ;;
        esac
    done' sh "${EXEC_NEEDED[@]}" 2>&1) ||
    abort_pre "the ${START_PATH} start path of ${IMAGE} cannot run: ${exec_fail:-docker run failed} (needs: ${EXEC_NEEDED[*]})"
# Gossip starts the sidecar with `node sidecar/dist/gossip-sidecar.mjs` from
# the node's working directory (GossipManager.ts:129-136, 187). The node
# process starts it itself, so the start path does not matter; what does is a
# real Node.js in the image (a devnet-style image has Bun's wrapper) and the
# bundle (Dockerfile:57, 203-218).
if [ "${GOSSIP_ENABLED:-false}" = true ]; then
    gossip_fail=$(docker run --rm --network none --memory 64m --entrypoint sh "${IMAGE}" -c '
        [ -f sidecar/dist/gossip-sidecar.mjs ] || { echo "sidecar/dist/gossip-sidecar.mjs is not in the image"; exit 1; }
        node -e "process.exit(process.versions.bun || parseInt(process.versions.node) < 20 ? 1 : 0)" ||
            { echo "node on PATH is not a real Node.js >= 20 ($(node --version 2>&1))"; exit 1; }' 2>&1) ||
        abort_pre "gossip is on for ${SCENARIO} but the sidecar cannot start in ${IMAGE}: ${gossip_fail:-docker run failed}"
fi
CODE="image"
[ -n "${SRC_TREE}" ] && CODE="src:$(basename "${SRC_TREE}")@$(git -C "${SRC_TREE}" rev-parse --short HEAD 2>/dev/null || echo '?')$(git -C "${SRC_TREE}" diff --quiet HEAD -- src 2>/dev/null || echo '+dirty')"
say "scenario=${SCENARIO} N=${N} shardSize=${SHARD} q=${Q} binding=${BINDING} image=${IMAGE} (${IMAGE_ID:7:12}) code=${CODE} start=${START_PATH} gossip=${GOSSIP_ENABLED:-false}"

# ── 2. inputs ───────────────────────────────────────────────────────────
step 02-inputs
GENESIS_TS=$(( $(date -u +%s) + GENESIS_DELAY ))
{
    for i in $(seq 1 "${N}"); do
        out=$(cd "${REPO_ROOT}" && bun testing/devnet/scripts/generate-identity-helper.ts) || exit 1
        echo "${out}" | grep '^MNEMONIC:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/node${i}.identity"
        echo "${out}" | grep '^PUBKEY:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/pub${i}"
    done
    python3 "${HERE}/gen-inputs.py" --run-dir "${RUN_DIR}" --repo "${REPO_ROOT}" \
        --nodes "${N}" --shard-size "${SHARD}" --binding "${BINDING}" --fork-set "${FORK_SET}" --genesis-ts "${GENESIS_TS}" \
        --image "${IMAGE}" --uid "${IMAGE_UID}" --gid "${IMAGE_GID}" --src "${SRC_TREE}" --node-mem "${NODE_MEM}" --consensus-time "${CONSENSUS_TIME}" \
        --start "${START_PATH}" --image-entrypoint "${IMAGE_ENTRYPOINT}" --image-cmd "${IMAGE_CMD}"
    # Once, after everything is written, so the modes do not depend on the umask.
    # 644 files in a 755 inputs/ under the 0700 ${RUN_DIR}: the node runs as the
    # image's user (uid 1000), not the host user, and these are throwaway devnet
    # keys; other host users still cannot traverse to them.
    python3 -I "${HERE}/drill_inputs.py" readable --dir "${RUN_DIR}/inputs"
} >> "${STEP_LOG}" 2>&1 || { say "ABORT: generating inputs failed (see 02-inputs.log)"; exit 2; }

# The image's own user must be able to read what the nodes mount and write
# what they write: a throwaway container, no network, inputs/ read-only, the
# image's default user, and every node tmpfs mounted with exactly the options
# the compose file gives it (the same strings, from drill_inputs.py). The
# identity is copied into each tmpfs as the entrypoint does, then its mode is
# restricted and it is read back; the image directories the node writes
# outside the tmpfs must be writable.
mapfile -t NODE_TMPFS < <(python3 -I "${HERE}/drill_inputs.py" tmpfs --uid "${IMAGE_UID}" --gid "${IMAGE_GID}")
[ "${#NODE_TMPFS[@]}" -gt 0 ] || abort_pre "no node tmpfs options from drill_inputs.py"
tmpfs_args=(); tmpfs_paths=()
for spec in "${NODE_TMPFS[@]}"; do tmpfs_args+=(--tmpfs "${spec}"); tmpfs_paths+=("${spec%%:*}"); done
probe_fail=$(docker run --rm --network none --memory 64m --entrypoint sh \
    -v "${RUN_DIR}/inputs:/inputs:ro" "${tmpfs_args[@]}" "${IMAGE}" -c '
    for f in node1.identity genesis.json; do
        cat "/inputs/${f}" > /dev/null 2>&1 || { echo "cannot read /inputs/${f}"; exit 1; }
    done
    for d in /app /app/data /app/logs; do
        [ -w "${d}" ] || { echo "image dir ${d} is not writable"; exit 1; }
    done
    for d in "$@"; do
        err=$(cp /inputs/node1.identity "${d}/probe" 2>&1 && chmod 600 "${d}/probe" 2>&1 && cat "${d}/probe" 2>&1 > /dev/null) ||
            { echo "cannot write and read ${d}/probe: ${err} (dir is $(stat -c "%u:%g mode %a" "${d}" 2>&1))"; exit 1; }
    done' sh "${tmpfs_paths[@]}" 2>&1) ||
    abort_pre "image user (uid ${IMAGE_UID} gid ${IMAGE_GID}) of ${IMAGE}: ${probe_fail:-docker run failed}; node tmpfs options: ${NODE_TMPFS[*]}; inputs in ${RUN_DIR}/inputs, host uid $(id -u), mode $(stat -c %a "${RUN_DIR}/inputs/node1.identity")"
# Image path: run node-1's generated entrypoint (the copies, then the image's
# own entrypoint script) once with the node's mounts and tmpfs, with a check
# in place of the CMD. It fails here, in seconds, if the image's entrypoint
# would abort before the node starts (its bridging of /app/demos_peerlist.json
# and the identity record runs under `set -e`) or leaves the node without its
# identity or peerlist.
if [ "${START_PATH}" = image ]; then
    mapfile -t NODE1_ENTRYPOINT < <(jq -r '.services["node-1"].entrypoint[]' "${RUN_DIR}/compose.yml")
    dry_fail=$(docker run --rm --network none --memory 256m --entrypoint "${NODE1_ENTRYPOINT[0]}" \
        -e IDENTITY_FILE=/app/state/node.identity \
        -v "${RUN_DIR}/inputs/node1.identity:/app/keys/node.identity:ro" \
        -v "${RUN_DIR}/inputs/peerlist.json:/app/keys/demos_peerlist.json:ro" \
        "${tmpfs_args[@]}" "${IMAGE}" "${NODE1_ENTRYPOINT[@]:1}" sh -c '
        [ -s /app/state/node.identity ] || { echo "no identity in /app/state"; exit 1; }
        [ -s /app/demos_peerlist.json ] || { echo "/app/demos_peerlist.json does not reach the copied peerlist"; exit 1; }
        echo "entrypoint ok as uid $(id -u) in $(pwd)"' 2>&1) ||
        abort_pre "the image's entrypoint does not reach the node with the drill's mounts: ${dry_fail:-docker run failed} (entrypoint: ${NODE1_ENTRYPOINT[*]})"
    say "start path: ${dry_fail}"
fi
declare -a PUB UP
for i in $(seq 1 "${N}"); do PUB[i]=$(tr 'A-Z' 'a-z' < "${RUN_DIR}/inputs/pub${i}"); UP[i]=0; done
say "forks (${FORK_SET}): $(jq -r '[.forks | to_entries[] | "\(.key)@\(.value.activationHeight)"] | join(", ")' "${RUN_DIR}/inputs/genesis.json")"
say "inputs ready (genesis in ${GENESIS_DELAY}s)"

# ── helpers ─────────────────────────────────────────────────────────────
port_of() { echo $((53549 + 2 * $1)); }
cid_of() { dc ps -q "node-$1" 2>/dev/null; }
rpc() { # $1 node, $2 JSON body, $3 curl timeout in s (default 4)
    local cid; cid=$(cid_of "$1"); [ -z "${cid}" ] && return 1
    docker exec "${cid}" curl -sS -m"${3:-4}" -X POST -H 'Content-Type: application/json' \
        -d "$2" "http://localhost:$(port_of "$1")/" 2>/dev/null
}
head_of() { # $1 node, $2 curl timeout in s (default 4)
    rpc "$1" '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{},"muid":null}]}' "${2:-4}" |
        jq -r 'select(.result == 200) | .response' 2>/dev/null
}
block_req() { echo "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getBlockByNumber\",\"data\":{\"blockNumber\":$1},\"muid\":null}]}"; }
block_at() { # $1 node, $2 height -> the block's JSON
    rpc "$1" "$(block_req "$2")" |
        jq -c 'select(.result == 200) | .response' 2>/dev/null
}
# Hash of block $2 on node $1, for comparing nodes. Prints the hash, or TIMEOUT
# (curl timed out) / EMPTY (no usable answer) after one retry with READ_TIMEOUT.
# Only a missing answer is retried: a hash is returned as read, never re-read.
hash_read() {
    local t out rc h
    for t in 4 "${READ_TIMEOUT}"; do
        out=$(rpc "$1" "$(block_req "$2")" "${t}"); rc=$?
        h=$(printf '%s' "${out}" | jq -r 'select(.result == 200) | .response.hash // empty' 2>/dev/null)
        [ -n "${h}" ] && { echo "${h}"; return 0; }
        [ "${t}" = 4 ] && sleep 1
    done
    if [ "${rc}" = 28 ]; then echo TIMEOUT; else echo EMPTY; fi
    return 1
}
# The hash, or nothing when it could not be read (after hash_read's retry)
hash_at() { local h; h=$(hash_read "$1" "$2") && echo "${h}"; }
serving() { local cid; cid=$(cid_of "$1"); [ -n "${cid}" ] && docker exec "${cid}" curl -sS -m3 "http://localhost:$(port_of "$1")/" 2>/dev/null | grep -q Hello; }
wait_serve() {
    local deadline=$((SECONDS + $2))
    while [ ${SECONDS} -lt ${deadline} ]; do serving "$1" && return 0; sleep 3; done
    return 1
}
running() { local i; for i in $(seq 1 "${N}"); do [ "${UP[i]}" = 1 ] && printf '%s ' "${i}"; done; }
live_count() { running | wc -w; }
# "i=h" for every running node; a node that does not answer shows "?"
heads_line() { local i h; for i in $(running); do h=$(head_of "${i}"); printf 'n%s=%s ' "${i}" "${h:-?}"; done; }
# Head of node $1, retried so one slow answer is not a failed read
read_head() {
    local k h
    for k in 1 2 3; do
        h=$(head_of "$1"); [[ "${h}" =~ ^[0-9]+$ ]] && { echo "${h}"; return 0; }
        sleep 1
    done
    return 1
}
# Highest head across running nodes. Fails, printing "?", when a running node
# cannot be read: a crashed node must not pass for one that stopped forging
max_head() {
    local i h m=-1
    for i in $(running); do
        h=$(read_head "${i}") || { echo "?"; return 1; }
        [ "${h}" -gt "${m}" ] && m="${h}"
    done
    [ "${m}" -ge 0 ] || { echo "?"; return 1; }
    echo "${m}"
}
start_node() {
    dc up -d "node-$1" >> "${STEP_LOG}" 2>&1 || dc start "node-$1" >> "${STEP_LOG}" 2>&1
    UP[$1]=1
    wait_serve "$1" 180 || return 1
    event "node-$1 started"
}
stop_node() {
    dc stop -t 0 "node-$1" >> "${STEP_LOG}" 2>&1
    UP[$1]=0
    event "node-$1 stopped"
}

# Window (s) for a fresh lockstep, 120 up to N=6, 160 at 10, 190 at 13. The reads
# of one attempt run in parallel, so an attempt takes about two reads however
# large N is; the window is the slack for slow nodes and for waiting out a block.
lockstep_window() { local w=$((60 + 10 * N)); [ "${w}" -lt 120 ] && w=120; echo "${w}"; }

# Parallel reads: one background job per running node, each writing its answer
# to ${LOCKSTEP_DIR}/<kind>.<node>, then a wait on exactly those jobs. A node is
# read at the same moment as the others, so a block that lands during the reads
# shows on a few nodes at most, not on every node read after it.
LOCKSTEP_DIR=""
par_begin() { LOCKSTEP_DIR="${LOG_DIR}/lockstep"; mkdir -p "${LOCKSTEP_DIR}"; rm -f "${LOCKSTEP_DIR}/$1".*; PAR_PIDS=(); }
par_end() { [ "${#PAR_PIDS[@]}" -gt 0 ] && wait "${PAR_PIDS[@]}"; return 0; }
# Head of every running node: a number, or empty after the retry with READ_TIMEOUT
par_heads() {
    local i
    par_begin head
    for i in $(running); do
        ( h=$(head_of "${i}")
          [[ "${h}" =~ ^[0-9]+$ ]] || h=$(head_of "${i}" "${READ_TIMEOUT}")
          [[ "${h}" =~ ^[0-9]+$ ]] || h=""
          printf '%s\n' "${h}" > "${LOCKSTEP_DIR}/head.${i}" ) &
        PAR_PIDS+=($!)
    done
    par_end
}
# Hash of block $1 on every running node: the hash, or EMPTY / TIMEOUT (hash_read)
par_hashes() {
    local i
    par_begin hash
    for i in $(running); do
        hash_read "${i}" "$1" > "${LOCKSTEP_DIR}/hash.${i}" &
        PAR_PIDS+=($!)
    done
    par_end
}
par_value() { local v=""; read -r v < "${LOCKSTEP_DIR}/$1.$2" 2>/dev/null; printf '%s' "${v}"; }

# The running nodes level on a common height h, within $2 seconds, h >= $1:
#   - every running node answers with its head,
#   - max(head) - min(head) <= 1 (3rd argument "exact": == 0), and
#   - with h = min(head), every running node returns the same non-empty hash at h.
# Heads are read in parallel, then the hashes at h are, so a block landing while
# the nodes are read does not look like a gap: the nodes ahead hold h too, and
# their hash at h is what is compared. "exact" is for a scenario that needs every
# node on one head (see scenario_fallback, scenario_partition).
# Returns 0 on lockstep (LOCK_HEIGHT = h; LOCK_MIN, LOCK_MAX the heads read);
# 3 when two nodes hold different hashes at h (at once with
# LOCKSTEP_FAIL_ON_DIVERGENCE=1, else when the window ends on such an attempt);
# 1 when a node could not be read, was behind $1 or the heads were too far apart.
# LOCKSTEP_WHY holds the reason. An empty or timed-out read is retried inside
# the attempt (head_of, hash_read); two different hashes are never retried.
# The step log gets, per attempt, the heads, h and each node's hash (nodes
# sharing one are grouped) or EMPTY / TIMEOUT; the console gets the heads and a
# final summary.
LOCKSTEP_FAIL_ON_DIVERGENCE=0
wait_lockstep() {
    local deadline=$((SECONDS + $2)) t0=${SECONDS} tries=0 i h v k g hl ok spread lo hi maxspread=1
    local ul bl el gl why ecs
    local -A grp ec
    [ "${3:-}" = exact ] && maxspread=0
    ok=0; spread=0; lo=""; hi=""; ul=""; bl=""; el=""; gl=""; grp=(); ec=()
    LOCKSTEP_WHY=""
    while [ ${SECONDS} -lt ${deadline} ]; do
        tries=$((tries + 1)); ok=1; spread=0; lo=""; hi=""; hl=""; ul=""; bl=""; el=""; gl=""; grp=()
        par_heads
        for i in $(running); do
            h=$(par_value head "${i}")
            if ! [[ "${h}" =~ ^[0-9]+$ ]]; then ok=0; ul+=" n${i}"; hl+="n${i}=? "; continue; fi
            hl+="n${i}=${h} "
            [ "${h}" -lt "$1" ] && { ok=0; bl+=" n${i}"; }
            { [ -z "${lo}" ] || [ "${h}" -lt "${lo}" ]; } && lo="${h}"
            { [ -z "${hi}" ] || [ "${h}" -gt "${hi}" ]; } && hi="${h}"
        done
        [ -n "${lo}" ] && spread=$((hi - lo))
        [ "${spread}" -gt "${maxspread}" ] && ok=0
        if [ "${ok}" = 1 ]; then
            par_hashes "${lo}"
            for i in $(running); do
                v=$(par_value hash "${i}")
                case "${v}" in
                    EMPTY|TIMEOUT|"") v="${v:-EMPTY}"; el+=" n${i}:${v}"; ec[${i}]=$(( ${ec[${i}]:-0} + 1 )) ;;
                    *) grp[${v}]+=" n${i}" ;;
                esac
            done
            for k in "${!grp[@]}"; do g="${grp[${k}]# }"; gl+=" ${k}=${g// /,}"; done
            echo "[qdrill $(date -u +%H:%M:%S)] lockstep try ${tries} at h=${lo} (heads ${lo}..${hi}: ${hl}):${gl:- no hash}${el:+ EMPTY/TIMEOUT:${el}}" >> "${STEP_LOG}"
            if [ "${#grp[@]}" -gt 1 ]; then
                LOCKSTEP_WHY="different hashes at ${lo}:${gl}"
                say "lockstep: ${LOCKSTEP_WHY}"
                [ "${LOCKSTEP_FAIL_ON_DIVERGENCE}" = 1 ] && return 3
            elif [ -z "${el}" ]; then
                LOCK_HEIGHT="${lo}"; LOCK_MIN="${lo}"; LOCK_MAX="${hi}"; return 0
            fi
        else
            echo "[qdrill $(date -u +%H:%M:%S)] lockstep try ${tries}: hashes not read, heads not level >= $1 (behind:${bl:- none} unreadable:${ul:- none} apart:${spread}, allowed ${maxspread})" >> "${STEP_LOG}"
        fi
        say "heads: ${hl}"
        sleep 5
    done
    # The deadline passed: say what the last attempt saw, empty reads apart from disagreement
    if [ "${ok}" = 1 ]; then
        why="hashes at h=${lo}: empty/timeout:${el:- none}; disagree:$([ "${#grp[@]}" -gt 1 ] && echo "${gl}" || echo " none")"
    else
        why="heads not level (behind:${bl:- none} unreadable:${ul:- none} apart:${spread} of at most ${maxspread}; min ${lo:-?} max ${hi:-?})"
    fi
    ecs=""; for i in "${!ec[@]}"; do ecs+=" n${i}x${ec[${i}]}"; done
    LOCKSTEP_WHY="no lockstep >= $1 after $((SECONDS - t0))s, ${tries} tries; last try: ${why}${ecs:+; empty/timeout reads over all tries:${ecs}}"
    say "lockstep: ${LOCKSTEP_WHY}"
    [ "${#grp[@]}" -gt 1 ] && return 3
    return 1
}

# Mean and longest gap between consecutive block timestamps in [from, to]
round_times() { # $1 node, $2 from, $3 to -> "mean max" in seconds
    local h ts prev="" sum=0 max=0 n=0 d
    for h in $(seq "$2" "$3"); do
        ts=$(block_at "$1" "${h}" | jq -r '.content.timestamp // empty')
        [ -z "${ts}" ] && continue
        # Timestamps are seconds or milliseconds depending on the producer
        [ "${ts}" -gt 100000000000 ] && ts=$((ts / 1000))
        if [ -n "${prev}" ]; then
            d=$((ts - prev)); sum=$((sum + d)); n=$((n + 1)); [ "${d}" -gt "${max}" ] && max="${d}"
        fi
        prev="${ts}"
    done
    if [ "${n}" -gt 0 ]; then awk -v s="${sum}" -v n="${n}" -v m="${max}" 'BEGIN { printf "%.1f %d", s / n, m }'; else echo "- -"; fi
}

# A running node other than those listed, to read the chain from
reader() { local i; for i in $(running); do case " $* " in *" ${i} "*) ;; *) echo "${i}"; return ;; esac; done; }

# Waits for PROGRESS_BLOCKS new blocks past $1; records a phase row
expect_progress() { # $1 phase name, $2 from height
    local deadline=$((SECONDS + PROGRESS_TIMEOUT)) m t0=${SECONDS} r times
    while [ ${SECONDS} -lt ${deadline} ]; do
        m=$(max_head) || read_error "$1"
        [ "${m}" -ge $(($2 + PROGRESS_BLOCKS)) ] && break
        sleep 2
    done
    r=$(reader)
    times=$(round_times "${r}" "$2" "${m}")
    local down=$((N - $(live_count)))
    if [ "${m}" -ge $(($2 + PROGRESS_BLOCKS)) ]; then
        say "$1: progressing, ${2} -> ${m} in $((SECONDS - t0))s (round mean/max ${times// //} s)"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tprogress\n' "$1" "${down}" "$(live_count)" "$2" "${m}" $((m - $2)) ${times} >> "${PHASES}"
        PHASE_END="${m}"; return 0
    fi
    say "$1: NO progress past ${2} within ${PROGRESS_TIMEOUT}s (heads $(heads_line))"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t-\t-\tstall\n' "$1" "${down}" "$(live_count)" "$2" "${m}" $((m - $2)) >> "${PHASES}"
    PHASE_END="${m}"; return 1
}

# Holds for STALL_WINDOW and reports whether the head stayed put. A block
# already in flight when the window opens may still land, hence +1.
expect_stall() { # $1 phase name, $2 height at the fault
    local deadline=$((SECONDS + STALL_WINDOW)) m last_change=${SECONDS} prev
    prev=$(max_head) || read_error "$1"
    while [ ${SECONDS} -lt ${deadline} ]; do
        sleep 5
        m=$(max_head) || read_error "$1"
        [ "${m}" != "${prev}" ] && { last_change=${SECONDS}; prev="${m}"; }
    done
    m=$(max_head) || read_error "$1"
    local down=$((N - $(live_count)))
    if [ "${m}" -le $(($2 + 1)) ]; then
        say "$1: stalled at ${m} for ${STALL_WINDOW}s (fault at ${2}; heads $(heads_line))"
        printf '%s\t%s\t%s\t%s\t%s\t%s\t-\t-\tstall\n' "$1" "${down}" "$(live_count)" "$2" "${m}" $((m - $2)) >> "${PHASES}"
        PHASE_END="${m}"; return 0
    fi
    say "$1: NOT stalled: ${2} -> ${m} (last change $((SECONDS - last_change))s ago)"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t-\t-\tprogress\n' "$1" "${down}" "$(live_count)" "$2" "${m}" $((m - $2)) >> "${PHASES}"
    PHASE_END="${m}"; return 1
}

# Stops node $1 once a round past the current head has started on node $2
stop_mid_round() {
    local victim="$1" watcher="$2" h since line deadline
    h=$(read_head "${watcher}") || read_error "stop node-${victim}"
    since=$(date -u +%s)
    deadline=$((SECONDS + 60))
    while [ ${SECONDS} -lt ${deadline} ]; do
        line=$(docker logs --since "${since}" "$(cid_of "${watcher}")" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' |
            grep -aoE 'We are forging block [0-9]+' | awk -v h="${h}" '$5 > h' | head -1)
        [ -n "${line}" ] && break
        sleep 0.3
    done
    event "round start seen on node-${watcher}: ${line:-none within 60s}"
    stop_node "${victim}"
    STOP_HEIGHT="${h}"
}

# Log lines matching $1 across every node, logged at or after unix time $2
# (default: the whole log; a restarted container keeps its earlier lines)
grep_logs() {
    local i cid
    for i in $(seq 1 "${N}"); do
        cid=$(dc ps -aq "node-${i}" 2>/dev/null); [ -z "${cid}" ] && continue
        docker logs --since "${2:-0}" "${cid}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -aE "$1" | sed "s/^/node-${i}: /"
    done
}

# Verdict, written after the scenario or when a window cannot be judged
write_verdict() {
    step 05-verdict
    column -t -s $'\t' "${PHASES}" | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
    sed 's/^/    /' "${EVENTS}" 2>/dev/null | tee -a "${LOG_DIR}/run.log" >/dev/null
    # halt-* and ride-* drills: the judge's per-phase verdict and timings
    local drill=null
    [ -s "${RUN_DIR}/drill-verdict.json" ] && drill=$(jq -c . "${RUN_DIR}/drill-verdict.json")
    jq -n --arg run "${RUN_ID}" --arg scenario "${SCENARIO}" --arg binding "${BINDING}" \
        --argjson n "${N}" --argjson shardSize "${SHARD}" --argjson q "${Q}" --arg code "${CODE}" \
        --arg image "${IMAGE}" --arg detail "${DETAIL}" --arg result "${RESULT}" --argjson drill "${drill}" \
        '{run: $run, scenario: $scenario, binding: $binding, validators: $n, shardSize: $shardSize,
          q: $q, code: $code, image: $image, detail: $detail, result: $result}
         + (if $drill == null then {} else {drill: $drill} end)' > "${LOG_DIR}/verdict.json"
    local results="${RUNS_DIR}/results.tsv"
    [ -f "${results}" ] || printf 'run\tscenario\tbinding\tN\tshardSize\tq\tcode\tdetail\tresult\n' > "${results}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${RUN_ID}" "${SCENARIO}" "${BINDING}" "${N}" "${SHARD}" "${Q}" \
        "${CODE}" "${DETAIL}" "${RESULT}" >> "${results}"
    free -m | sed -n 2p | sed 's/^/host after run: /' >> "${LOG_DIR}/run.log"
    say "RESULT ${RESULT}: ${SCENARIO} (N=${N}, shardSize ${SHARD}, q ${Q}, binding ${BINDING}) ${DETAIL}"
}

# A running node that cannot be read leaves the window without a verdict:
# the run ends as ERROR, never as PASS
read_error() { # $1 phase name
    say "ERROR: $1: a running node does not answer its head (heads $(heads_line))"
    printf '%s\t%s\t%s\t-\t-\t-\t-\t-\tunreadable\n' "$1" "$((N - $(live_count)))" "$(live_count)" >> "${PHASES}"
    RESULT=ERROR
    DETAIL="${DETAIL:+${DETAIL} }$1: node unreadable ($(heads_line))"
    write_verdict
    exit 2
}

# A read of a node's database, bounded as scenario 12's DB_READ_TIMEOUT_MS bounds
# its own: the server cancels a query after DB_READ_TIMEOUT s (statement_timeout)
# and an outer timeout stops what the server cannot cancel (a stalled connect or
# exec). Either way the read fails; callers treat that as "could not run".
psql_node() { # $1 node, $2 SQL
    local rc errf="${LOG_DIR}/psql-err.$$.tmp"
    # stderr goes to the caller as before and, when there is any, to
    # psql-errors.log, which pg_limit_gate reads
    timeout -k 5 "$((DB_READ_TIMEOUT + 5))" docker exec -e PGCONNECT_TIMEOUT=10 \
        -e "PGOPTIONS=-c statement_timeout=$((DB_READ_TIMEOUT * 1000))" \
        "$(dc ps -q postgres)" psql -U demosuser -d "node$1_db" -tAc "$2" 2> "${errf}"
    rc=$?
    [ -s "${errf}" ] && { cat "${errf}" >&2; sed "s/^/psql node$1_db: /" "${errf}" >> "${LOG_DIR}/psql-errors.log"; }
    rm -f "${errf}"
    [ "${rc}" = 124 ] && echo "psql node$1_db: no answer within $((DB_READ_TIMEOUT + 5))s (DB_READ_TIMEOUT=${DB_READ_TIMEOUT})" >&2
    return "${rc}"
}

# The shared postgres must allow every connection N nodes can open. The compose
# sets max_connections (gen-inputs.py), so this fails only if that setting did
# not reach the server. Waits for the server: `up -d` does not.
pg_limit_preflight() {
    local need have tries=0
    need=$(python3 -I "${HERE}/drill_inputs.py" pgconn --nodes "${N}" | cut -d' ' -f1)
    [[ "${need}" =~ ^[0-9]+$ ]] || { say "ABORT: could not work out the connections ${N} nodes need"; return 1; }
    while :; do
        have=$(docker exec "$(dc ps -q postgres)" psql -U demosuser -d postgres -tAc 'SHOW max_connections' 2>/dev/null)
        [[ "${have}" =~ ^[0-9]+$ ]] && break
        tries=$((tries + 1))
        [ "${tries}" -ge 45 ] && { say "ABORT: could not read max_connections from postgres"; return 1; }
        sleep 2
    done
    if [ "${have}" -lt "${need}" ]; then
        say "ABORT: could not run: postgres max_connections is ${have}, ${N} nodes need ${need} (10 each + 20)"
        return 1
    fi
    say "postgres max_connections ${have} (${N} nodes need ${need})"
}

# "sorry, too many clients already" in a node's log or in one of the harness'
# own psql reads means something ran without a connection it needed: the run
# proves nothing, whatever the verdict says. Called before the verdict is
# written, so a PASS or a FAIL becomes exit 2 and says why.
pg_limit_gate() {
    local hits nodes
    hits=$({ grep_logs "too many clients"; grep -a "too many clients" "${LOG_DIR}/psql-errors.log" 2>/dev/null; } | wc -l)
    [ "${hits}" = 0 ] && return 0
    nodes=$(grep_logs "too many clients" | cut -d: -f1 | sort -u | tr '\n' ' ')
    say "ABORT: could not run: postgres connection limit hit (${hits} 'too many clients' lines; ${nodes:-harness psql reads only})"
    DETAIL="could not run: postgres connection limit hit (${hits} lines${nodes:+ in ${nodes% }}); the result was ${RESULT}"
    RESULT=ERROR
    write_verdict
    exit 2
}

# ── 3. bring-up ─────────────────────────────────────────────────────────
step 03-bringup
STARTED_STACK=1
dc up -d postgres >> "${STEP_LOG}" 2>&1 || { say "ABORT: postgres did not start"; exit 2; }
pg_limit_preflight || exit 2
for i in $(seq 1 "${START}"); do
    start_node "${i}" || { say "ABORT: node-${i} did not serve within 180s"; exit 2; }
    say "node-${i} serving"
    # One node at a time: a simultaneous join races the committee freeze
    [ "${i}" -lt "${START}" ] && sleep 4
done
wait_s=$((GENESIS_TS - $(date -u +%s)))
if [ "${wait_s}" -lt 0 ]; then
    say "WARNING: all ${START} were up only $((-wait_s))s after the genesis time (raise GENESIS_DELAY)"
else
    say "all ${START} up ${wait_s}s before the genesis time"
fi
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' $(dc ps -q) >> "${STEP_LOG}" 2>&1
# Anonymous memory is what the node really holds; the rest is page cache
for c in $(dc ps -q); do
    echo "$(docker inspect -f '{{.Name}}' "${c}") anon $(docker exec "${c}" cat /sys/fs/cgroup/memory.stat 2>/dev/null |
        awk '/^anon /{print int($2 / 1048576)}') MiB"
done >> "${STEP_LOG}" 2>&1

# ── 4. scenario ─────────────────────────────────────────────────────────
step 04-scenario
RESULT=FAIL
DETAIL=""
LOCK_HEIGHT=0
LOCK_MIN=0
LOCK_MAX=0
PHASE_END=0
STOP_HEIGHT=0

# After a failed wait_lockstep ($1 its status, $2 what was awaited): a divergence
# is a failure (exit 1) in the drills that set LOCKSTEP_FAIL_ON_DIVERGENCE.
# Everything else, a node that could not be read included, gives no verdict: exit 2
lockstep_fail() {
    if [ "$1" = 3 ] && [ "${LOCKSTEP_FAIL_ON_DIVERGENCE}" = 1 ]; then
        say "FAIL: ${LOCKSTEP_WHY}"; exit 1
    fi
    say "ABORT: $2 (${LOCKSTEP_WHY})"; exit 2
}

lockstep_or_abort() {
    wait_lockstep "$1" "${LOCKSTEP_TIMEOUT}" || lockstep_fail $? "the running nodes never reached one head >= $1 with one hash"
    say "running nodes in lockstep at ${LOCK_HEIGHT}: one hash there, heads ${LOCK_MIN}..${LOCK_MAX}"
}

scenario_floor() {
    # Wait past the genesis time plus several round intervals
    local until_ts=$((GENESIS_TS + 8 * CONSENSUS_TIME + 30)) m lines since
    # Only refusals of this window count: rounds start at the genesis time
    since=$(( GENESIS_TS < $(date -u +%s) ? $(date -u +%s) : GENESIS_TS ))
    while [ "$(date -u +%s)" -lt "${until_ts}" ]; do sleep 5; done
    m=$(max_head) || read_error floor
    lines=$(grep_logs "below the (floor|quorum) of ${Q}" "${since}" | tee -a "${STEP_LOG}" | wc -l)
    say "head after $((8 * CONSENSUS_TIME + 30))s past genesis: ${m}; floor/quorum refusals logged in the window: ${lines}"
    grep_logs "below the (floor|quorum) of ${Q}" "${since}" | head -3 | cut -c1-260 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
    printf 'floor\t0\t%s\t0\t%s\t%s\t-\t-\t%s\n' "${N}" "${m}" "${m}" "$([ "${m}" = 0 ] && echo stall || echo progress)" >> "${PHASES}"
    DETAIL="head=${m} refusals=${lines}"
    [ "${m}" = 0 ] && [ "${lines}" -gt 0 ] && RESULT=PASS
}

scenario_drop() {
    lockstep_or_abort 3
    local ok=1 k victim live expect stopped=()
    expect_progress "all-up" "${LOCK_HEIGHT}" || ok=0
    for k in $(seq 1 "${STOPS}"); do
        victim=$((N - k + 1))
        stop_mid_round "${victim}" 1
        stopped+=("${victim}")
        live=$(live_count)
        # The bound committee is every validator here (N <= shardSize), so
        # the code forges iff the live members reach q
        if [ "${live}" -ge "${Q}" ]; then expect=progress; else expect=stall; fi
        say "stopped node-${victim} mid-round after ${STOP_HEIGHT}: ${live} live, q=${Q}, expect ${expect}"
        if [ "${expect}" = progress ]; then
            expect_progress "down-${k}" "${STOP_HEIGHT}" || ok=0
        else
            local since; since=$(date -u +%s)
            expect_stall "down-${k}" "${STOP_HEIGHT}" || ok=0
            grep_logs "below the (floor|quorum) of ${Q}" "${since}" | tail -2 | cut -c1-260 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
        fi
        DETAIL="${DETAIL}down${k}=${expect}:$(tail -1 "${PHASES}" | cut -f9) "
    done
    # Manual recovery: bring the stopped validators back
    local h; h=$(max_head) || read_error restart
    for victim in "${stopped[@]}"; do start_node "${victim}" || say "node-${victim} did not come back"; done
    expect_progress "restarted" "${h}" || ok=0
    DETAIL="${DETAIL}restart=$(tail -1 "${PHASES}" | cut -f9)"
    [ "${ok}" = 1 ] && RESULT=PASS
}

scenario_listed_stall() {
    lockstep_or_abort 3
    local ok=1 r pl
    expect_progress "7-of-10-up" "${LOCK_HEIGHT}" || ok=0
    r=$(reader)
    pl=$(block_at "${r}" "$(read_head "${r}")" | jq -r '.content.peerlist | length')
    say "the head block lists ${pl} validators (q=${Q}); 3 staked validators never started"
    stop_mid_round 7 1
    say "stopped listed node-7: $(live_count) live"
    expect_stall "listed-down" "${STOP_HEIGHT}" || ok=0
    local h=${PHASE_END}
    for i in 8 9 10; do start_node "${i}" || say "node-${i} did not serve"; done
    say "started the 3 unlisted staked validators (heads $(heads_line))"
    # Expected to stay stalled: the listed pool still holds q, so the
    # staked-set fallback does not apply and they are outside the committee
    expect_stall "extras-up" "${h}" || ok=0
    grep_logs "bound committee members for block" | tail -1 | cut -c1-300 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
    start_node 7 || say "node-7 did not come back"
    expect_progress "listed-back" "${PHASE_END}" || ok=0
    DETAIL="listed=${pl} $(cut -f1,9 "${PHASES}" | tail -n +2 | tr '\t\n' ': ')"
    [ "${ok}" = 1 ] && RESULT=PASS
}

scenario_fallback() {
    lockstep_or_abort 3
    local i h heads_db listed pl_json fallback_lines ok=1
    # Stop every node at once right after a commit, so they all hold one head.
    # Exact, not within one block: block h is rewritten on every database below,
    # so every node must hold h and nothing above it when it stops
    wait_lockstep "$((LOCK_HEIGHT + 1))" "$(lockstep_window)" exact || lockstep_fail $? "no fresh lockstep"
    for i in $(running); do dc stop -t 0 "node-${i}" >> "${STEP_LOG}" 2>&1 & done
    wait
    for i in $(seq 1 "${N}"); do UP[i]=0; done
    heads_db=$(for i in $(seq 1 "${N}"); do psql_node "${i}" "SELECT max(number) FROM blocks"; done | sort -u)
    if [ "$(echo "${heads_db}" | wc -l)" != 1 ]; then
        say "ABORT: the nodes stopped on different heads: $(echo ${heads_db})"; exit 2
    fi
    h="${heads_db}"
    # Six listed validators (< q = 7) out of ten staked. The stored text is
    # rewritten with key order kept, every node identically; the block hash
    # is not recomputed, nothing re-hashes a stored block.
    listed=$(for i in 1 2 3 4 5 6; do echo "${PUB[i]}"; done | sort)
    pl_json=$(echo "${listed}" | jq -R . | jq -sc .)
    for i in $(seq 1 "${N}"); do
        psql_node "${i}" "SELECT content FROM blocks WHERE number = ${h}" |
            python3 -c '
import json, sys
c = json.loads(sys.stdin.read(), object_pairs_hook=dict)
c["peerlist"] = json.loads(sys.argv[1])
text = json.dumps(c, separators=(",", ":"))
# A dollar-quoted literal needs no escaping; psql does not interpolate
# variables inside -c strings, so the text travels in the script itself
assert "$qdrill$" not in text
print(f"UPDATE blocks SET content = $qdrill${text}$qdrill$::json WHERE number = {int(sys.argv[2])};")
' "${pl_json}" "${h}" > "${RUN_DIR}/inputs/content-${i}.sql" || { say "ABORT: rewriting block ${h} failed"; exit 2; }
        docker exec -i "$(dc ps -q postgres)" psql -U demosuser -d "node${i}_db" -v ON_ERROR_STOP=1 -q -f - \
            < "${RUN_DIR}/inputs/content-${i}.sql" >> "${STEP_LOG}" 2>&1 || { say "ABORT: update failed on node${i}_db"; exit 2; }
        [ "$(psql_node "${i}" "SELECT json_array_length(content->'peerlist') FROM blocks WHERE number = ${h}")" = 6 ] ||
            { say "ABORT: node${i}_db does not list 6 at ${h}"; exit 2; }
    done
    event "block ${h} rewritten to list nodes 1-6 on all ${N} databases"
    say "all ${N} stopped at ${h}; block ${h} now lists 6 of 10 staked validators (q=${Q}); restarting all"
    local since; since=$(date -u +%s)
    for i in $(seq 1 "${N}"); do start_node "${i}" || { say "ABORT: node-${i} did not come back"; exit 2; }; sleep 2; done
    if [ "${BINDING}" = on ]; then
        expect_progress "listed-below-q" "${h}" || ok=0
    else
        # Pre-fork rule: the pool is the 6 listed, below the floor, forever
        expect_stall "listed-below-q" "${h}" || ok=0
    fi
    fallback_lines=$(grep_logs "drawing the committee from all" "${since}" | tee -a "${STEP_LOG}" | wc -l)
    grep_logs "drawing the committee from all|Shard of [0-9]+ is below the floor" "${since}" | head -2 | cut -c1-260 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
    say "fallback log lines: ${fallback_lines}"
    if [ "${BINDING}" = on ] && [ "${fallback_lines}" = 0 ]; then ok=0; fi
    DETAIL="height=${h} outcome=$(tail -1 "${PHASES}" | cut -f9) fallbackLines=${fallback_lines}"
    [ "${ok}" = 1 ] && RESULT=PASS
}

sidecar() { echo "${PROJECT}-fault-$1"; }
scenario_partition() {
    lockstep_or_abort 3
    local i j ip groupA="1 2 3" groupB="4 5 6" h0 a_max b_max
    declare -A IP
    for i in $(seq 1 "${N}"); do
        IP[$i]=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(cid_of "${i}")")
        docker rm -f "$(sidecar "${i}")" >/dev/null 2>&1
        docker run -d --name "$(sidecar "${i}")" --network "container:$(cid_of "${i}")" \
            --cap-add NET_ADMIN --memory 64m "${NETSHOOT_IMAGE}" sleep infinity >/dev/null 2>>"${STEP_LOG}" ||
            { say "ABORT: sidecar for node-${i} did not start"; exit 2; }
        SIDECARS+=("$(sidecar "${i}")")
    done
    in_a() { case " ${groupA} " in *" $1 "*) return 0 ;; esac; return 1; }
    # Exact, not within one block: the verdict counts blocks forged past h0 + 1 on
    # each side, which assumes both sides start on h0 (one block of slack is
    # already in those bounds for a block in flight)
    wait_lockstep "$((LOCK_HEIGHT + 1))" "$(lockstep_window)" exact || lockstep_fail $? "no fresh lockstep"
    h0="${LOCK_HEIGHT}"
    for i in $(seq 1 "${N}"); do
        for j in $(seq 1 "${N}"); do
            if in_a "${i}" && in_a "${j}"; then continue; fi
            if ! in_a "${i}" && ! in_a "${j}"; then continue; fi
            docker exec "$(sidecar "${i}")" iptables -I INPUT -s "${IP[$j]}" -m comment --comment qdrill-part -j DROP 2>>"${STEP_LOG}"
            docker exec "$(sidecar "${i}")" iptables -I OUTPUT -d "${IP[$j]}" -m comment --comment qdrill-part -j DROP 2>>"${STEP_LOG}"
        done
    done
    event "partition {${groupA}} | {${groupB}} at height ${h0}"
    say "partitioned {${groupA}} | {${groupB}} at ${h0} for ${PARTITION_TIME}s"
    local deadline=$((SECONDS + PARTITION_TIME))
    while [ ${SECONDS} -lt ${deadline} ]; do sleep 10; say "heads: $(heads_line)"; done
    a_max=0; b_max=0
    for i in $(running); do
        local hh; hh=$(read_head "${i}") || read_error partitioned
        if in_a "${i}"; then [ "${hh}" -gt "${a_max}" ] && a_max="${hh}"; else [ "${hh}" -gt "${b_max}" ] && b_max="${hh}"; fi
    done
    say "during the partition: group A reached ${a_max}, group B reached ${b_max} (from ${h0})"
    printf 'partitioned\t0\t%s\t%s\tA=%s,B=%s\t-\t-\t-\t%s\n' "${N}" "${h0}" "${a_max}" "${b_max}" \
        "$([ "${a_max}" -gt $((h0 + 1)) ] && [ "${b_max}" -gt $((h0 + 1)) ] && echo both-sides || echo one-side-or-none)" >> "${PHASES}"
    for i in $(seq 1 "${N}"); do
        docker exec "$(sidecar "${i}")" sh -c \
            'iptables -S | grep -- "--comment qdrill-part" | sed "s/^-A /-D /; s/\"//g" | while read -r r; do iptables $r; done' 2>>"${STEP_LOG}"
    done
    event "partition healed"
    say "healed; waiting for one chain"
    local top=$(( a_max > b_max ? a_max : b_max ))
    wait_lockstep "$((top + 2))" "${SETTLE_TIMEOUT}" || say "no common head within ${SETTLE_TIMEOUT}s after the heal"
    # Every height from the split on: one hash across all nodes that hold it
    local hmin=999999 hh conflicts="" seen
    for i in $(running); do hh=$(read_head "${i}") || read_error healed; [ "${hh}" -lt "${hmin}" ] && hmin="${hh}"; done
    local hmax_all=$(( top > hmin ? top : hmin ))
    for hh in $(seq "${h0}" "${hmax_all}"); do
        seen=$(for i in $(running); do hash_at "${i}" "${hh}"; done | grep . | sort -u | wc -l)
        [ "${seen}" -gt 1 ] && conflicts="${conflicts} ${hh}"
    done
    local fork=no; [ -n "${conflicts}" ] && fork=yes
    say "heights ${h0}..${hmax_all}: fork=${fork}${conflicts:+ at${conflicts}}; final heads $(heads_line)"
    grep_logs '\[FORK\]' | head -3 | cut -c1-260 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
    # One chain: every node past the split's top, holding one hash at the lowest head
    local converged=no
    if [ "${hmin}" -ge "$((top + 2))" ] &&
        [ "$(for i in $(running); do hash_at "${i}" "${hmin}"; done | grep -c .)" = "$(live_count)" ] &&
        [ "$(for i in $(running); do hash_at "${i}" "${hmin}"; done | grep . | sort -u | wc -l)" = 1 ]; then
        converged=yes
    fi
    DETAIL="split@${h0} A=${a_max} B=${b_max} fork=${fork}${conflicts:+(${conflicts# })} converged=${converged}"
    if [ "${BINDING}" = on ]; then
        # No conflicting blocks, at most one side forged, and one chain after
        if [ "${fork}" = no ] && { [ "${a_max}" -le $((h0 + 1)) ] || [ "${b_max}" -le $((h0 + 1)) ]; } &&
            [ "${converged}" = yes ]; then RESULT=PASS; fi
    else
        # Pre-fork rule: both sides are expected to finalize their own block
        [ "${fork}" = yes ] && RESULT=PASS
    fi
}

# ── halt-* and ride-* drills ────────────────────────────────────────────
# The run records what it observed (heads, block rows, restart counts,
# wall-clock marks) in ${RUN_DIR}/drill-input.json, and the verdict comes from
# testing/forks/rehearsal/lib/judgeHaltDrill.ts, which applies scenario 12's
# pass criteria (lib/haltDrill.ts). Nothing is judged in bash.
now_ms() { date -u +%s%3N; }

# {"<node>": <number>, ...} from "node number" lines on stdin
kv_json() { jq -Rn '[inputs | split(" ") | {key: .[0], value: (.[1] | tonumber)}] | from_entries'; }

# Heads of the given nodes, one try each; -1 for a node that does not answer
heads_once() {
    local i h
    for i in "$@"; do
        h=$(head_of "${i}")
        [[ "${h}" =~ ^[0-9]+$ ]] || h=-1
        printf '%s %s\n' "${i}" "${h}"
    done | kv_json
}

# As heads_once, with read_head's retries: one slow answer is not a dead node
heads_read() {
    local i h
    for i in "$@"; do
        h=$(read_head "${i}") || h=-1
        printf '%s %s\n' "${i}" "${h}"
    done | kv_json
}

# Restart counts of the given containers; fails when one cannot be read
restart_counts() {
    local i c
    for i in "$@"; do
        c=$(docker inspect -f '{{.RestartCount}}' "$(cid_of "${i}")" 2>/dev/null) || return 1
        [[ "${c}" =~ ^[0-9]+$ ]] || return 1
        printf '%s %s\n' "${i}" "${c}"
    done | kv_json
}

# Rows {node, number, hash, signatures} for heights $1..$2 on nodes $3.., read
# from each node's database as scenario 12 does (signatures are the keys of
# validation_data->'signatures'). Fails when a database cannot be read or does
# not answer within DB_READ_TIMEOUT: the caller ends the run as exit 2.
block_rows() {
    local from="$1" to="$2" i out all=""
    shift 2
    for i in "$@"; do
        out=$(psql_node "${i}" "SELECT number, hash, (SELECT count(*) FROM json_object_keys(validation_data->'signatures')) FROM blocks WHERE number BETWEEN ${from} AND ${to} ORDER BY number" |
            jq -Rn --argjson node "${i}" '[inputs | split("|") | {node: $node, number: (.[0] | tonumber), hash: .[1], signatures: (.[2] | tonumber)}]') ||
            { say "block rows ${from}..${to} of node-${i} could not be read from its database (failed or no answer within ${DB_READ_TIMEOUT}s)"; return 1; }
        all+="${out}"$'\n'
    done
    printf '%s' "${all}" | jq -cs 'add // []'
}

phase_row() { # $1 phase, $2 down, $3 live, $4 from, $5 to, $6 outcome
    printf '%s\t%s\t%s\t%s\t%s\t%s\t-\t-\t%s\n' "$1" "$2" "$3" "$4" "$5" $(($5 - $4)) "$6" >> "${PHASES}"
}

# P1 baseline, the pre-stop head, then the stop. The last STOPS validators are
# stopped by one `docker compose stop -t 0`, so node-1 (the peerlist's anchor)
# stays up. Sets VICTIMS, SURVIVORS, VICTIM_SERVICES and the T_* and *_HEIGHT values.
drill_stop() {
    local i v
    # Two hashes at one height before the stop is a fork, not a missing read
    LOCKSTEP_FAIL_ON_DIVERGENCE=1
    VICTIMS=(); SURVIVORS=(); VICTIM_SERVICES=()
    for i in $(seq 1 "${N}"); do
        if [ "${i}" -gt $((N - STOPS)) ]; then VICTIMS+=("${i}"); VICTIM_SERVICES+=("node-${i}"); else SURVIVORS+=("${i}"); fi
    done
    T_BASELINE=""; T_STOP=""; T_HALT=""; T_HOLD_END=""; T_RESTART=""; T_FIRST=""; T_CONV=""
    SETTLE_JSON=null; HOLD_JSON=null; RECOVERY_JSON=null; RIDE_JSON=null
    # Marks the end of bring-up: every validator serves, genesis may still be ahead
    T_UP=$(now_ms)
    say "${SCENARIO}: stopping ${VICTIMS[*]} at once leaves ${#SURVIVORS[@]} live (${SURVIVORS[*]}), q=${Q}"

    # P1 baseline: every node on one head >= BASELINE_HEIGHT with one hash
    lockstep_or_abort "${BASELINE_HEIGHT}"
    BASE_HEIGHT="${LOCK_HEIGHT}"
    BASE_HEADS=$(heads_read $(running))
    BASE_ROWS=$(block_rows "${BASE_HEIGHT}" "${BASE_HEIGHT}" $(running)) || { say "ABORT: could not read the baseline blocks"; exit 2; }
    T_BASELINE=$(now_ms)
    say "P1 baseline: ${N}/${N} at ${BASE_HEIGHT}"
    phase_row baseline 0 "${N}" 0 "${BASE_HEIGHT}" progress

    # A fresh common height with one hash on every node, so the stop lands on a
    # settled chain. PRE_HEIGHT is the lowest head: a node may already hold the
    # next block, which the judge treats as a settle block (quorum signatures,
    # one hash on every survivor) like any block after PRE_HEIGHT
    wait_lockstep "$((BASE_HEIGHT + 1))" "$(lockstep_window)" || lockstep_fail $? "no fresh lockstep before the stop"
    PRE_HEIGHT="${LOCK_HEIGHT}"
    PRE_PEERLIST=$(block_at "${SURVIVORS[0]}" "${PRE_HEIGHT}" | jq -r '.content.peerlist | length')
    [[ "${PRE_PEERLIST}" =~ ^[0-9]+$ ]] || { say "ABORT: cannot read the peerlist of block ${PRE_HEIGHT}"; exit 2; }
    COUNTS_BEFORE=$(restart_counts "${SURVIVORS[@]}") || { say "ABORT: cannot read the survivors' restart counts"; exit 2; }
    # The ride bound holds only for a pool as large as the committee
    if [ "${SCENARIO%%-*}" = ride ] && [ "${PRE_PEERLIST}" -lt $((N < SHARD ? N : SHARD)) ]; then
        say "ABORT: block ${PRE_HEIGHT} lists ${PRE_PEERLIST} validators, fewer than the committee of $((N < SHARD ? N : SHARD)): the ride bound does not apply"
        exit 2
    fi

    dc stop -t 0 "${VICTIM_SERVICES[@]}" >> "${STEP_LOG}" 2>&1 || { say "ABORT: stopping ${VICTIM_SERVICES[*]} failed"; exit 2; }
    for v in "${VICTIMS[@]}"; do UP[v]=0; event "node-${v} stopped"; done
    T_STOP=$(now_ms)
    say "stopped ${VICTIM_SERVICES[*]} at once after block ${PRE_HEIGHT} (it lists ${PRE_PEERLIST} validators)"
}

# P3: survivor heads sampled every round for HALT_ROUNDS rounds. $1 halt height.
drill_hold() {
    local k hs samples="" t0
    t0=$(now_ms)
    for k in $(seq 1 "${HALT_ROUNDS}"); do
        sleep "${CONSENSUS_TIME}"
        hs=$(heads_read "${SURVIVORS[@]}")
        samples+=$(jq -nc --argjson at "$(($(now_ms) - t0))" --argjson h "${hs}" '{atMs: $at, heights: $h}')$'\n'
        [ $((k % 3)) = 0 ] && say "hold ${k}/${HALT_ROUNDS}: $(jq -c . <<< "${hs}")"
    done
    T_HOLD_END=$(now_ms)
    HOLD_JSON=$(printf '%s' "${samples}" | jq -cs '{samples: .}')
    local top; top=$(printf '%s' "${samples}" | jq -s '[.[].heights[]] | max')
    phase_row halt-hold "${STOPS}" "${#SURVIVORS[@]}" "$1" "${top}" "$([ "${top}" -gt "$1" ] && echo progress || echo stall)"
}

# P5: start the victims together and wait for all N to reach halt + RECOVERY_BLOCKS.
# $1 halt height. A node that does not get there is left to the judge.
drill_recover() {
    local target=$(($1 + RECOVERY_BLOCKS)) deadline hs mx v rows converged=0
    dc up -d "${VICTIM_SERVICES[@]}" >> "${STEP_LOG}" 2>&1 || dc start "${VICTIM_SERVICES[@]}" >> "${STEP_LOG}" 2>&1 ||
        { say "ABORT: could not start ${VICTIM_SERVICES[*]}"; exit 2; }
    for v in "${VICTIMS[@]}"; do UP[v]=1; event "node-${v} started"; done
    T_RESTART=$(now_ms)
    say "restarted ${VICTIM_SERVICES[*]}; waiting for all ${N} to reach ${target}"
    deadline=$((SECONDS + RECOVERY_TIMEOUT))
    while [ ${SECONDS} -lt ${deadline} ]; do
        hs=$(heads_once $(running))
        mx=$(jq '[.[]] | max' <<< "${hs}")
        # Any block above the halt height, from any node: the first new block
        if [ -z "${T_FIRST}" ] && [ "${mx}" -gt "$1" ]; then T_FIRST=$(now_ms); fi
        if jq -e --argjson t "${target}" 'all(.[]; . >= $t)' <<< "${hs}" > /dev/null; then
            T_CONV=$(now_ms); converged=1; break
        fi
        say "heads: $(jq -c . <<< "${hs}")"
        sleep 2
    done
    hs=$(heads_once $(running))
    rows=$(block_rows "${PRE_HEIGHT}" "${target}" $(running)) || { say "ABORT: could not read the recovery blocks"; exit 2; }
    RECOVERY_JSON=$(jq -nc --argjson b "${RECOVERY_BLOCKS}" --argjson heads "${hs}" --argjson rows "${rows}" \
        '{blocks: $b, heads: $heads, rows: $rows}')
    phase_row restarted 0 "${N}" "$1" "$(jq '[.[]] | min' <<< "${hs}")" "$([ "${converged}" = 1 ] && echo progress || echo stall)"
}

# Writes drill-input.json, runs the judge on it and sets RESULT and DETAIL
drill_judge() { # $1 mode: halt or ride
    local input="${RUN_DIR}/drill-input.json" rc hold_rounds=0
    [ "$1" = halt ] && hold_rounds="${HALT_ROUNDS}"
    # Every fork of the genesis the nodes ran, null where off
    local forks; forks=$(jq -c '.forks | with_entries(.value |= .activationHeight)' "${RUN_DIR}/inputs/genesis.json")
    local marks; marks=$(jq -nc \
        --argjson up "${T_UP:-null}" --argjson baseline "${T_BASELINE:-null}" --argjson stop "${T_STOP:-null}" \
        --argjson halt "${T_HALT:-null}" --argjson holdEnd "${T_HOLD_END:-null}" --argjson restart "${T_RESTART:-null}" \
        --argjson first "${T_FIRST:-null}" --argjson conv "${T_CONV:-null}" \
        '{t_up: $up, t_baseline: $baseline, t_stop: $stop, t_halt_confirmed: $halt, t_hold_end: $holdEnd,
          t_restart: $restart, t_first_new_block: $first, t_converged: $conv}')
    local counts_after; counts_after=$(restart_counts "${SURVIVORS[@]}") || { say "ABORT: cannot read the survivors' restart counts"; exit 2; }
    jq -n --arg scenario "${SCENARIO}" --arg mode "$1" --argjson validators "${N}" --argjson shardSize "${SHARD}" \
        --argjson stopped "$(printf '%s\n' "${VICTIMS[@]}" | jq -sc .)" --argjson consensusTimeS "${CONSENSUS_TIME}" \
        --argjson forks "${forks}" --argjson baselineMinHeight "${BASELINE_HEIGHT}" --argjson holdRounds "${hold_rounds}" \
        --argjson marks "${marks}" --argjson baseHeight "${BASE_HEIGHT}" --argjson baseHeads "${BASE_HEADS}" \
        --argjson baseRows "${BASE_ROWS}" --argjson pre "${PRE_HEIGHT}" --argjson peerlist "${PRE_PEERLIST}" \
        --argjson before "${COUNTS_BEFORE}" --argjson after "${counts_after}" \
        --argjson settle "${SETTLE_JSON}" --argjson hold "${HOLD_JSON}" --argjson recovery "${RECOVERY_JSON}" --argjson ride "${RIDE_JSON}" \
        '{scenario: $scenario, mode: $mode, validators: $validators, shardSize: $shardSize, stopped: $stopped,
          consensusTimeS: $consensusTimeS, forks: $forks, baselineMinHeight: $baselineMinHeight, holdRounds: $holdRounds,
          marks: $marks, baseline: {height: $baseHeight, heads: $baseHeads, rows: $baseRows},
          preStopHeight: $pre, preStopPeerlist: $peerlist, restartCounts: {before: $before, after: $after},
          settle: $settle, hold: $hold, recovery: $recovery, ride: $ride}' > "${input}"
    ( cd "${REPO_ROOT}" && bun testing/forks/rehearsal/lib/judgeHaltDrill.ts "${input}" --out "${RUN_DIR}/drill-verdict.json" ) \
        > "${LOG_DIR}/judge.out" 2>&1
    rc=$?
    tee -a "${LOG_DIR}/run.log" < "${LOG_DIR}/judge.out"
    case "${rc}" in
        0) RESULT=PASS ;;
        1) RESULT=FAIL ;;
        *) RESULT=ERROR; DETAIL="the judge could not read ${input} (exit ${rc})"; write_verdict; exit 2 ;;
    esac
    DETAIL=$(jq -r .summary "${RUN_DIR}/drill-verdict.json")
}

# Stop STOPS validators at once, hold, restart. Pass criteria P1..P6 of
# scenario 12, judged by judgeHaltDrill.ts.
scenario_halt() {
    drill_stop
    local H settle_heads settle_rows deadline
    # P2 settle: a block already in flight may still land. The judge derives the
    # halt height again from these heads with agreedHeight.
    sleep $((SETTLE_ROUNDS * CONSENSUS_TIME))
    deadline=$((SECONDS + 3 * CONSENSUS_TIME))
    while :; do
        settle_heads=$(heads_read "${SURVIVORS[@]}")
        H=$(jq -r '[.[]] | if all(. >= 0) and (unique | length) == 1 then .[0] else empty end' <<< "${settle_heads}")
        if [ -n "${H}" ] || [ ${SECONDS} -ge ${deadline} ]; then break; fi
        sleep 1
    done
    if [ -z "${H}" ]; then
        say "P2: the survivors do not agree on a head: $(jq -c . <<< "${settle_heads}")"
        SETTLE_JSON=$(jq -nc --argjson heads "${settle_heads}" '{heads: $heads, rows: []}')
    else
        settle_rows=$(block_rows "${PRE_HEIGHT}" "${H}" "${SURVIVORS[@]}") || { say "ABORT: could not read the settle blocks"; exit 2; }
        SETTLE_JSON=$(jq -nc --argjson heads "${settle_heads}" --argjson rows "${settle_rows}" '{heads: $heads, rows: $rows}')
        T_HALT=$(now_ms)
        say "survivors agree at ${H}: $((H - PRE_HEIGHT)) block(s) landed after the stop"
        phase_row settle "${STOPS}" "${#SURVIVORS[@]}" "${PRE_HEIGHT}" "${H}" "$([ "${H}" -gt "${PRE_HEIGHT}" ] && echo progress || echo stall)"
        drill_hold "${H}"
        drill_recover "${H}"
    fi
    drill_judge halt
}

# Stop STOPS validators at once, which the committee code guarantees the chain
# tolerates: the survivors must keep forging.
scenario_ride() {
    drill_stop
    local target=$((PRE_HEIGHT + RIDE_BLOCKS)) deadline hs mx=0 rows times converged=0
    say "ride: waiting for the ${#SURVIVORS[@]} live validators to reach ${target}"
    deadline=$((SECONDS + RIDE_TIMEOUT))
    while [ ${SECONDS} -lt ${deadline} ]; do
        hs=$(heads_once "${SURVIVORS[@]}")
        mx=$(jq '[.[]] | max' <<< "${hs}")
        if [ -z "${T_FIRST}" ] && [ "${mx}" -gt "${PRE_HEIGHT}" ]; then T_FIRST=$(now_ms); fi
        if jq -e --argjson t "${target}" 'all(.[]; . >= $t)' <<< "${hs}" > /dev/null; then
            T_CONV=$(now_ms); converged=1; break
        fi
        say "heads: $(jq -c . <<< "${hs}")"
        sleep 2
    done
    hs=$(heads_once "${SURVIVORS[@]}")
    rows=$(block_rows "${PRE_HEIGHT}" "${target}" "${SURVIVORS[@]}") || { say "ABORT: could not read the ride blocks"; exit 2; }
    RIDE_JSON=$(jq -nc --argjson b "${RIDE_BLOCKS}" --argjson heads "${hs}" --argjson rows "${rows}" \
        '{blocks: $b, heads: $heads, rows: $rows}')
    mx=$(jq '[.[]] | max' <<< "${hs}")
    times=$(round_times "${SURVIVORS[0]}" "${PRE_HEIGHT}" "${mx}")
    printf 'ride\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${STOPS}" "${#SURVIVORS[@]}" "${PRE_HEIGHT}" "${mx}" \
        $((mx - PRE_HEIGHT)) ${times} "$([ "${converged}" = 1 ] && echo progress || echo stall)" >> "${PHASES}"
    drill_judge ride
}

case "${SCENARIO}" in
    floor) scenario_floor ;;
    drop-*) scenario_drop ;;
    halt-*) scenario_halt ;;
    ride-*) scenario_ride ;;
    listed-stall) scenario_listed_stall ;;
    fallback) scenario_fallback ;;
    partition) scenario_partition ;;
esac

pg_limit_gate
write_verdict
[ "${RESULT}" = PASS ] && exit 0
exit 1
