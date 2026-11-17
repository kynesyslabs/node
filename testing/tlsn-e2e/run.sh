#!/usr/bin/env bash
# TLSNotary end to end under tlsnVerified, in one command.
#
#   run.sh [--no-build | --overlay] [label]
#
# Builds the devnet image (or, with --overlay, copies this tree onto the
# existing image), generates fresh secp256k1 keys for three stock notaries
# (genesis trusts two), writes the tlsnVerified fork payload from them and
# the committed verifier's sha256, boots postgres + 4 validators + the
# notaries, and drives e2e.ts: the SDK (a local build of kynesyslabs/sdks,
# SDK_TREE) attests real public data from api.github.com in headless
# Chromium through a node relay and a notary, and every step is checked on
# all four validators. Run evidence (report.md, report.json, evidence/,
# logs/) lands in RUNS_DIR/<UTC>-<label>.
#
# Teardown always runs: `down -v`, the run's image when it was built here
# (KEEP_IMAGE=1 keeps it for a --no-build rerun), and the run's secrets
# (node identities, wallet mnemonics, notary private keys). Build cache is
# shared with other projects on the host, so it is left to the operator
# (`docker builder prune --filter until=24h`).
#
# TLSN_E2E_GITHUB_TOKEN, when set, enables the positive identity link
# (GitHub's /user needs one); it is passed to the prover only, never logged,
# and the SDK keeps its value out of the presentation.
#
# Exit codes: 0 every check passed, 1 a check failed, 2 the run could not be
# carried out (preflight, build, boot).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
SDK_TREE="${SDK_TREE:-${REPO_ROOT}/../sdks-tlsn-e2e-wt}"
IMAGE="${IMAGE:-demos-devnet-node:tlsn-e2e}"
# Short blocks: an expired token is reached by advancing the chain past the
# request's TTL (500 blocks), which no setting shortens.
CONSENSUS_TIME="${CONSENSUS_TIME:-2}"
NODE_MEM="${NODE_MEM:-2g}"
RUNS_DIR="${RUNS_DIR:-${REPO_ROOT}/../launch-call-notes/tlsn-at-launch/e2e}"
MIN_DISK_GB="${MIN_DISK_GB:-20}"
MIN_RAM_MB="${MIN_RAM_MB:-6144}"
MAX_LOAD="${MAX_LOAD:-$(nproc)}"
RPC_BASE="${RPC_BASE:-64551}"
NOTARY_BASE="${NOTARY_BASE:-64701}"
RELAY_BASE="${RELAY_BASE:-56300}"
RELAY_WINDOW=10
GENESIS_DELAY="${GENESIS_DELAY:-90}"
BUILD=1

while [ $# -gt 0 ]; do
    case "$1" in
        --no-build) BUILD=0; shift ;;
        --overlay) BUILD=2; shift ;;
        -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        --*) echo "unknown option $1" >&2; exit 2 ;;
        *) break ;;
    esac
done
LABEL="${1:-run}"
[[ "${LABEL}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "label must match [A-Za-z0-9_-]+" >&2; exit 2; }

mkdir -p "${RUNS_DIR}"
RUNS_DIR="$(cd "${RUNS_DIR}" && pwd)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${LABEL}"
RUN_DIR="${RUNS_DIR}/${RUN_ID}"
LOG_DIR="${RUN_DIR}/logs"
INPUTS="${RUN_DIR}/inputs"
PROJECT="tlsne2e-$(echo "${RUN_ID}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-')"
mkdir -p "${LOG_DIR}" "${INPUTS}/empty-snapshot" "${INPUTS}/notary-1" "${INPUTS}/notary-2" "${INPUTS}/notary-3"
chmod 700 "${RUN_DIR}" "${INPUTS}"
ENVFILE="${RUN_DIR}/compose.env"
COMPOSE_FILE="${HERE}/docker-compose.e2e.yml"
say() { echo "[tlsn-e2e $(date -u +%H:%M:%S)] $*" | tee -a "${LOG_DIR}/run.log"; }
dc() { docker compose --env-file "${ENVFILE}" -p "${PROJECT}" -f "${COMPOSE_FILE}" "$@"; }

STARTED_STACK=0
BUILT_IMAGE=0
teardown() {
    local rc=$?
    trap - EXIT INT TERM
    if [ "${STARTED_STACK}" = 1 ]; then
        say "collecting container logs"
        for svc in node-1 node-2 node-3 node-4 notary-1 notary-2 notary-3 postgres; do
            local cid
            cid=$(dc ps -aq "${svc}" 2>/dev/null)
            [ -n "${cid}" ] && docker logs "${cid}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${LOG_DIR}/${svc}.log"
        done
        say "tearing down ${PROJECT}"
        dc down -v --remove-orphans >"${LOG_DIR}/teardown.log" 2>&1 || true
    fi
    if [ "${BUILT_IMAGE}" = 1 ] && [ "${KEEP_IMAGE:-0}" != 1 ]; then
        docker image rm "${IMAGE}" >>"${LOG_DIR}/teardown.log" 2>&1 || true
    fi
    rm -f "${INPUTS}"/node*.identity "${INPUTS}/wallets.secret.json" "${INPUTS}"/notary-*/notary.key
    {
        echo "== after teardown"
        docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}} {{.Status}}'
        docker volume ls --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Name}}'
        docker network ls --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Name}}'
        free -m | sed -n 2p
    } >> "${LOG_DIR}/teardown.log" 2>&1
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
busy() { ss -ltnH "sport = :$1" | grep -q .; }
for i in 1 2 3 4; do
    busy $((RPC_BASE + 2 * (i - 1))) && abort_pre "port $((RPC_BASE + 2 * (i - 1))) is in use (set RPC_BASE)"
    for p in $(seq $((RELAY_BASE + RELAY_WINDOW * (i - 1))) $((RELAY_BASE + RELAY_WINDOW * i - 1))); do
        busy "${p}" && abort_pre "relay port ${p} is in use (set RELAY_BASE)"
    done
done
for i in 1 2 3; do
    busy $((NOTARY_BASE + i - 1)) && abort_pre "port $((NOTARY_BASE + i - 1)) is in use (set NOTARY_BASE)"
done

# ---- 2. SDK and image -----------------------------------------------------------
step=02-build
# A subshell with an explicit exit per command: `set -e` does nothing on the
# left of `||`, and a failed build must not go on with an older image.
(
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
[ "${BUILD}" != 0 ] && BUILT_IMAGE=1
say "node $(git -C "${REPO_ROOT}" rev-parse --short HEAD)$(git -C "${REPO_ROOT}" diff --quiet HEAD -- src testing/devnet || echo +dirty), $(grep '^SDK ' "${LOG_DIR}/${step}.log"), image ${IMAGE}"

# ---- 3. inputs: identities, wallets, notary keys, genesis, peerlist ----------------
step=03-inputs
GENESIS_TS=$(( $(date -u +%s) + GENESIS_DELAY ))
{
    set -e
    for i in 1 2 3 4; do
        out=$(cd "${REPO_ROOT}" && bun testing/devnet/scripts/generate-identity-helper.ts)
        echo "${out}" | grep '^MNEMONIC:' | cut -d: -f2- | tr -d '\n' > "${INPUTS}/node${i}.identity"
        echo "${out}" | grep '^PUBKEY:' | cut -d: -f2- | tr -d '\n' > "${INPUTS}/pub${i}"
    done
    chmod 600 "${INPUTS}"/node*.identity
    (cd "${INPUTS}" && bun "${HERE}/wallets.ts")
    # Fresh notary keys for this run only: the private halves never leave
    # the run dir and are deleted at teardown; only public keys are printed.
    for k in 1 2 3; do
        d="${INPUTS}/notary-${k}"
        openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:secp256k1 -out "${d}/notary.key" 2>/dev/null
        # Read by the notary's non-root user inside its container.
        chmod 644 "${d}/notary.key"
        openssl ec -in "${d}/notary.key" -pubout -conv_form compressed -outform DER 2>/dev/null |
            tail -c 33 | xxd -p -c 100 > "${INPUTS}/notary-${k}.pub"
        echo "notary-${k} public key $(cat "${INPUTS}/notary-${k}.pub")"
    done
    wasm="${REPO_ROOT}/native/tlsn-verify/dist/demos_tlsn_verify.wasm"
    wasm_sha=$(sha256sum "${wasm}" | cut -d' ' -f1)
    pinned=$(awk '{print $1}' "${wasm}.sha256")
    [ "${wasm_sha}" = "${pinned}" ] || { echo "verifier wasm ${wasm_sha} != committed ${pinned}"; exit 1; }
    echo "verifier wasm sha256 ${wasm_sha}"
    python3 - "${INPUTS}" "${REPO_ROOT}" "${GENESIS_TS}" "${wasm_sha}" <<'PY'
import json, sys
inputs, repo, genesis_ts, wasm_sha = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
g = json.load(open(f"{repo}/testing/devnet/genesis.devnet.json"))
forks = g["forks"]
assert forks["tlsnVerified"]["activationHeight"] == 0, "devnet genesis must activate tlsnVerified at 0"
assert forks.get("tlsnDisabled", {}).get("activationHeight") is None, "devnet genesis must leave tlsnDisabled unscheduled"
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
# Only the run's notary-1 and notary-2 are trusted; notary-3 is the
# throwaway untrusted one. The committed devnet keys are replaced.
fork = forks["tlsnVerified"]
fork["notaryKeys"] = [
    {"id": f"e2e-notary-{k}", "alg": "k256", "hex": open(f"{inputs}/notary-{k}.pub").read().strip()}
    for k in (1, 2)
]
fork["verifierWasmSha256"] = wasm_sha
json.dump(g, open(f"{inputs}/genesis.json", "w"), indent=2)
json.dump({"tlsnVerified": fork}, open(f"{inputs}/tlsnVerified.json", "w"), indent=2)
# Every node seeds node-1 only and learns the rest from it
json.dump({pubs[0]: "http://node-1:53551"}, open(f"{inputs}/peerlist.json", "w"), indent=2)
print("genesis shardSize 4, validators", len(pubs), "balances", len(g["balances"]),
      "tlsnVerified keys", [k["id"] for k in fork["notaryKeys"]])
PY
} > "${LOG_DIR}/${step}.log" 2>&1 || { say "ABORT: generating inputs failed (see ${step}.log)"; exit 2; }
say "inputs ready: $(grep '^wallets:' "${LOG_DIR}/${step}.log"), $(grep -c 'public key' "${LOG_DIR}/${step}.log") notary keys"

{
    echo "E2E_IMAGE=${IMAGE}"
    echo "RUN_DIR=${RUN_DIR}"
    echo "CONSENSUS_TIME=${CONSENSUS_TIME}"
    echo "NODE_MEM=${NODE_MEM}"
    for i in 1 2 3 4; do
        echo "RPC_PORT_${i}=$((RPC_BASE + 2 * (i - 1)))"
        echo "RELAY_MIN_${i}=$((RELAY_BASE + RELAY_WINDOW * (i - 1)))"
        echo "RELAY_MAX_${i}=$((RELAY_BASE + RELAY_WINDOW * i - 1))"
    done
    for k in 1 2 3; do
        echo "NOTARY_PORT_${k}=$((NOTARY_BASE + k - 1))"
    done
} > "${ENVFILE}"

# ---- 4. staggered bring-up ------------------------------------------------------------
step=04-bringup
STARTED_STACK=1
serving() { curl -sS -m3 "http://127.0.0.1:$((RPC_BASE + 2 * ($1 - 1)))/" 2>/dev/null | grep -q Hello; }
dc up -d postgres notary-1 notary-2 notary-3 >> "${LOG_DIR}/${step}.log" 2>&1 || { say "ABORT: postgres or a notary did not start"; exit 2; }
for k in 1 2 3; do
    deadline=$((SECONDS + 60))
    until curl -sS -m3 "http://127.0.0.1:$((NOTARY_BASE + k - 1))/info" >/dev/null 2>&1; do
        [ ${SECONDS} -ge ${deadline} ] && { say "ABORT: notary-${k} did not serve /info"; exit 2; }
        sleep 2
    done
done
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
export RUN_DIR ENVFILE PROJECT COMPOSE_FILE SDK_TREE REPO_ROOT
set -a; . "${ENVFILE}"; set +a
(cd "${HERE}" && bun e2e.ts) 2>&1 | tee -a "${LOG_DIR}/e2e.log"
rc=${PIPESTATUS[0]}
[ "${rc}" -gt 1 ] && rc=1
exit "${rc}"
