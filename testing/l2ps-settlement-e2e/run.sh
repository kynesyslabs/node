#!/usr/bin/env bash
# L2PS settlement end to end, in one command.
#
#   run.sh [--no-build | --overlay] [label]
#
# Builds the devnet image (keys layer cached), or with --overlay copies this
# tree onto the existing image (same dependencies, no install), boots postgres + 4 validators
# (shardSize 4) with node-1 and node-2 as members of a fresh subnet, drives
# e2e.ts against them with the local SDK worktree, and writes report.md,
# report.json, evidence/ and logs/ into the run dir. Everything is torn down
# (`down -v`) on exit, failure or Ctrl-C; the run's secrets (devnet keys,
# wallet mnemonics, subnet key) are deleted unless KEEP_INPUTS=1.
#
# Exit codes: 0 every check passed, 1 a check failed, 2 the run could not be
# carried out (preflight, build, boot).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
SDK_TREE="${SDK_TREE:-${REPO_ROOT}/../sdks-l2ps-settle-wt}"
IMAGE="${IMAGE:-demos-devnet-node:l2ps-settle-e2e}"
CONSENSUS_TIME="${CONSENSUS_TIME:-10}"
MEMBER_MEM="${MEMBER_MEM:-6g}"
NODE_MEM="${NODE_MEM:-2g}"
SETTLEMENT_PROVERS="${SETTLEMENT_PROVERS:-1}"
RUNS_DIR="${RUNS_DIR:-${HERE}/runs}"
MIN_DISK_GB="${MIN_DISK_GB:-20}"
# Two members proving at once plus four nodes and postgres
MIN_RAM_MB="${MIN_RAM_MB:-8192}"
MAX_LOAD="${MAX_LOAD:-$(nproc)}"
RPC_BASE="${RPC_BASE:-63551}"
GENESIS_DELAY="${GENESIS_DELAY:-120}"
BUILD=1

while [ $# -gt 0 ]; do
    case "$1" in
        --no-build) BUILD=0; shift ;;
        --overlay) BUILD=2; shift ;;
        -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        --*) echo "unknown option $1" >&2; exit 2 ;;
        *) break ;;
    esac
done
LABEL="${1:-run}"
[[ "${LABEL}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "label must match [A-Za-z0-9_-]+" >&2; exit 2; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${LABEL}"
RUN_DIR="${RUNS_DIR}/${RUN_ID}"
LOG_DIR="${RUN_DIR}/logs"
PROJECT="l2pse2e-$(echo "${RUN_ID}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')"
# The uid becomes part of the signed settlement message, which uses ":" as its separator
L2PS_UID="e2e_$(date -u +%H%M%S)"
mkdir -p "${LOG_DIR}" "${RUN_DIR}/inputs/empty-snapshot" "${RUN_DIR}/inputs/l2ps-none" "${RUN_DIR}/inputs/l2ps-member/${L2PS_UID}"
chmod 700 "${RUN_DIR}" "${RUN_DIR}/inputs"
ENVFILE="${RUN_DIR}/compose.env"
COMPOSE_FILE="${HERE}/docker-compose.e2e.yml"
say() { echo "[l2ps-e2e $(date -u +%H:%M:%S)] $*" | tee -a "${LOG_DIR}/run.log"; }
dc() { docker compose --env-file "${ENVFILE}" -p "${PROJECT}" -f "${COMPOSE_FILE}" "$@"; }

STARTED_STACK=0
teardown() {
    local rc=$?
    trap - EXIT INT TERM
    if [ "${STARTED_STACK}" = 1 ]; then
        say "collecting container logs"
        for svc in node-1 node-2 node-3 node-4 postgres; do
            local cid
            cid=$(dc ps -aq "${svc}" 2>/dev/null)
            [ -n "${cid}" ] && docker logs "${cid}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${LOG_DIR}/${svc}.log"
        done
        say "tearing down ${PROJECT}"
        dc down -v --remove-orphans >"${LOG_DIR}/teardown.log" 2>&1 || true
    fi
    if [ "${KEEP_INPUTS:-0}" != 1 ]; then
        rm -f "${RUN_DIR}"/inputs/node*.identity "${RUN_DIR}/inputs/wallets.secret.json"
        rm -rf "${RUN_DIR}/inputs/l2ps-member"
    fi
    free -m | sed -n 2p | sed 's/^/host after run: /' >> "${LOG_DIR}/run.log"
    say "run dir: ${RUN_DIR} (exit ${rc})"
    exit "${rc}"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# ---- 1. preflight -------------------------------------------------------------
step=01-preflight
{ df -h /; free -m; echo "nproc $(nproc)"; uptime; vmstat 1 5; } > "${LOG_DIR}/${step}.log" 2>&1
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
avail_mb=$(free -m | awk '/^Mem:/{print $7}')
load1=$(cut -d' ' -f1 /proc/loadavg)
# Swapping in each of the last three 1 s samples: any swap-out, or swap-in
# above 1 MB/s (a trickle of stale pages coming back is not memory pressure)
swapping=$(vmstat 1 4 | tail -3 | awk '$8 > 0 || $7 > 1024 {n++} END {print (n == 3) ? 1 : 0}')
say "preflight: disk ${disk_gb}G free, ${avail_mb}M RAM available, load ${load1}/$(nproc), swapping=${swapping}"
abort_pre() {
    say "ABORT: $*"
    ps -eo pid,comm,rss,%cpu --sort=-rss | head -10 >> "${LOG_DIR}/${step}.log"
    exit 2
}
[ "${disk_gb:-0}" -lt "${MIN_DISK_GB}" ] && abort_pre "free disk ${disk_gb}G < ${MIN_DISK_GB}G"
[ "${avail_mb:-0}" -lt "${MIN_RAM_MB}" ] && abort_pre "available RAM ${avail_mb}M < ${MIN_RAM_MB}M"
awk -v l="${load1}" -v m="${MAX_LOAD}" 'BEGIN { exit !(l > m) }' && abort_pre "load ${load1} > ${MAX_LOAD}"
[ "${swapping}" = 1 ] && abort_pre "the host is actively swapping"
for i in 1 2 3 4; do
    port=$((RPC_BASE + 2 * (i - 1)))
    ss -ltnH "sport = :${port}" | grep -q . && abort_pre "port ${port} is in use (set RPC_BASE)"
done

# ---- 2. SDK and image -----------------------------------------------------------
step=02-build
# A subshell with an explicit exit per command: `set -e` does nothing on the
# left of `||`, and a failed build once went on with the previous image.
(
    # The harness resolves @kynesyslabs/demosdk to the SDK worktree's build.
    [ -f "${SDK_TREE}/package.json" ] || { echo "no SDK worktree at ${SDK_TREE}"; exit 1; }
    newest_src=$(find "${SDK_TREE}/src" -type f -newer "${SDK_TREE}/build" -print -quit 2>/dev/null || true)
    if [ ! -d "${SDK_TREE}/build" ] || [ -n "${newest_src}" ]; then
        echo "SDK build is stale (${newest_src:-no build}); building"
        (cd "${SDK_TREE}" && bun run build) || exit 1
    fi
    echo "SDK $(git -C "${SDK_TREE}" rev-parse --short HEAD)$(git -C "${SDK_TREE}" diff --quiet HEAD -- src || echo +dirty)"
    mkdir -p "${HERE}/node_modules/@kynesyslabs"
    ln -sfn "$(cd "${SDK_TREE}" && pwd)" "${HERE}/node_modules/@kynesyslabs/demosdk"
    if [ "${BUILD}" = 1 ]; then
        docker build -f "${REPO_ROOT}/testing/devnet/Dockerfile" -t "${IMAGE}" "${REPO_ROOT}" || exit 1
    elif [ "${BUILD}" = 2 ]; then
        docker image inspect "${IMAGE}" >/dev/null || exit 1
        printf 'FROM %s\nCOPY . .\nRUN chmod +x ./testing/devnet/run-devnet\n' "${IMAGE}" |
            docker build -f - -t "${IMAGE}" "${REPO_ROOT}" || exit 1
    fi
    docker image inspect "${IMAGE}" --format 'image {{.Id}} {{.Created}}' || exit 1
) > "${LOG_DIR}/${step}.log" 2>&1 || { say "ABORT: build failed (see ${step}.log)"; exit 2; }
say "node $(git -C "${REPO_ROOT}" rev-parse --short HEAD)$(git -C "${REPO_ROOT}" diff --quiet HEAD -- src testing/devnet || echo +dirty), $(grep '^SDK ' "${LOG_DIR}/${step}.log"), image ${IMAGE}"

# ---- 3. inputs: identities, wallets, genesis, peerlist, subnet --------------------
step=03-inputs
GENESIS_TS=$(( $(date -u +%s) + GENESIS_DELAY ))
{
    set -e
    for i in 1 2 3 4; do
        out=$(cd "${REPO_ROOT}" && bun testing/devnet/scripts/generate-identity-helper.ts)
        echo "${out}" | grep '^MNEMONIC:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/node${i}.identity"
        echo "${out}" | grep '^PUBKEY:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/pub${i}"
    done
    chmod 600 "${RUN_DIR}"/inputs/node*.identity
    (cd "${RUN_DIR}/inputs" && bun "${HERE}/wallets.ts")
    python3 - "${RUN_DIR}/inputs" "${REPO_ROOT}" "${GENESIS_TS}" <<'PY'
import json, sys
inputs, repo, genesis_ts = sys.argv[1], sys.argv[2], sys.argv[3]
g = json.load(open(f"{repo}/testing/devnet/genesis.devnet.json"))
assert g["forks"]["l2psSettlement"]["activationHeight"] == 0, "devnet genesis must activate l2psSettlement at 0"
g["timestamp"] = genesis_ts
pubs = [open(f"{inputs}/pub{i}").read().strip() for i in (1, 2, 3, 4)]
ports = ["53551", "53553", "53555", "53557"]
# The stock devnet's 10 is a committee floor four nodes never reach
g["properties"]["shardSize"] = 4
stake = "1000000000000000000"
g["validators"] = [
    {"address": pk, "status": "2", "connection_url": f"http://node-{i + 1}:{ports[i]}",
     "staked_amount": stake, "first_seen": 0, "valid_at": 0}
    for i, pk in enumerate(pubs)
]
wallets = json.load(open(f"{inputs}/genesis-balances.json"))
g["balances"] = [[pk, stake] for pk in pubs] + wallets
json.dump(g, open(f"{inputs}/genesis.json", "w"), indent=2)
# Every node seeds node-1 only and learns the rest from it
json.dump({pubs[0]: "http://node-1:53551"}, open(f"{inputs}/peerlist.json", "w"), indent=2)
print("genesis shardSize 4, validators", len(pubs), "balances", len(g["balances"]))
PY
    sub="${RUN_DIR}/inputs/l2ps-member/${L2PS_UID}"
    openssl rand -hex 32 > "${sub}/private_key.txt"
    openssl rand -hex 16 > "${sub}/iv.txt"
    chmod 600 "${sub}/private_key.txt" "${sub}/iv.txt"
    cat > "${sub}/config.json" <<EOF
{
    "uid": "${L2PS_UID}",
    "enabled": true,
    "config": { "created_at_block": 0, "known_rpcs": ["http://node-1:53551", "http://node-2:53553"] },
    "keys": {
        "private_key_path": "data/l2ps/${L2PS_UID}/private_key.txt",
        "iv_path": "data/l2ps/${L2PS_UID}/iv.txt"
    }
}
EOF
} > "${LOG_DIR}/${step}.log" 2>&1 || { say "ABORT: generating inputs failed (see ${step}.log)"; exit 2; }
say "inputs ready: subnet ${L2PS_UID}, $(grep '^wallets:' "${LOG_DIR}/${step}.log")"

cat > "${ENVFILE}" <<EOF
E2E_IMAGE=${IMAGE}
RUN_DIR=${RUN_DIR}
CONSENSUS_TIME=${CONSENSUS_TIME}
MEMBER_MEM=${MEMBER_MEM}
NODE_MEM=${NODE_MEM}
SETTLEMENT_PROVERS=${SETTLEMENT_PROVERS}
RPC_PORT_1=${RPC_BASE}
RPC_PORT_2=$((RPC_BASE + 2))
RPC_PORT_3=$((RPC_BASE + 4))
RPC_PORT_4=$((RPC_BASE + 6))
EOF

# ---- 4. staggered bring-up ------------------------------------------------------------
step=04-bringup
STARTED_STACK=1
serving() { curl -sS -m3 "http://127.0.0.1:$((RPC_BASE + 2 * ($1 - 1)))/" 2>/dev/null | grep -q Hello; }
dc up -d postgres >> "${LOG_DIR}/${step}.log" 2>&1 || { say "ABORT: postgres did not start"; exit 2; }
for n in 1 2 3 4; do
    dc up -d "node-${n}" >> "${LOG_DIR}/${step}.log" 2>&1
    deadline=$((SECONDS + 240))
    until serving "${n}"; do
        [ ${SECONDS} -ge ${deadline} ] && { say "ABORT: node-${n} did not serve within 240 s"; exit 2; }
        sleep 3
    done
    say "node-${n} serving"
    # One at a time: a simultaneous join races the committee freeze
    [ "${n}" -lt 4 ] && sleep 8
done
wait_s=$((GENESIS_TS - $(date -u +%s)))
say "all four up, ${wait_s} s before the genesis time"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' $(dc ps -q) >> "${LOG_DIR}/${step}.log" 2>&1

# ---- 5. scenarios ---------------------------------------------------------------------
export RUN_DIR L2PS_UID ENVFILE PROJECT COMPOSE_FILE
set -a; . "${ENVFILE}"; set +a
(cd "${HERE}" && bun e2e.ts) 2>&1 | tee -a "${LOG_DIR}/e2e.log"
rc=${PIPESTATUS[0]}
[ "${rc}" -gt 1 ] && rc=1
exit "${rc}"
