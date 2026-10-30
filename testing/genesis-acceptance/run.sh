#!/usr/bin/env bash
# Acceptance of the genesis and fork-schedule rules (docs/design/genesis-enforcement.md)
# on a node image run as published: its own entrypoint, user and command.
#
#   run.sh --image <ref[@digest]> --label <name> [--out DIR]
#
# One node and one throwaway Postgres on a private bridge network with no
# published ports. The node needs a route out only for NTP (it exits at boot
# when no NTP server answers); with an empty peer list it dials no peer, and
# the testnet URLs in the bundled snapshot's validator list are only stored.
# Ten scenarios run in order; 6-10 restart on the database that
# scenario 1 created, restored to its state after scenario 6 before each one.
#
# Evidence (summary.md, per-scenario node logs, fixture genesis files) goes to
# <out>/<label>/; the default <out> is testing/runs/genesis-acceptance.
# Keys never leave the per-run temp dir, which is deleted on exit.
#
# Exit codes: 0 every scenario matched, 1 at least one did not, 2 the run
# could not be carried out (preflight, lock, setup).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
PROJECTS_DIR="$(cd "${REPO_ROOT}/.." && pwd)"

IMAGE=""
LABEL=""
OUT_ROOT="${GACC_OUT_ROOT:-}"
LOCK_FILE="${GACC_LOCK_FILE:-${PROJECTS_DIR}/.crace.lock}"
LOCK_TIMEOUT="${GACC_LOCK_TIMEOUT:-7200}"
# Same image and digest as the postgres service in docker-compose.yml
PG_IMAGE="${GACC_PG_IMAGE:-postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab}"
NODE_MEM="${GACC_NODE_MEM:-2g}"
NODE_CPUS="${GACC_NODE_CPUS:-4}"
PG_MEM="${GACC_PG_MEM:-512m}"
BOOT_TIMEOUT="${GACC_BOOT_TIMEOUT:-600}"
REFUSE_TIMEOUT="${GACC_REFUSE_TIMEOUT:-300}"
MIN_RAM_MB="${GACC_MIN_RAM_MB:-3072}"
MIN_DISK_GB="${GACC_MIN_DISK_GB:-10}"
CHAIN_ID=4242
GENESIS_TS=1793318400
FAR_HEIGHT=1000000
UNKNOWN_FORK=genesisAcceptanceUnknownFork
RPC_PORT=53550
PG_USER=demosuser
PG_PASSWORD=demospassword
MAINNET_FORKS="signatureDomain editBinding quorumParity committeeBinding commitLock"

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="${2:-}"; shift 2 ;;
        --label) LABEL="${2:-}"; shift 2 ;;
        --out) OUT_ROOT="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument $1" >&2; usage >&2; exit 2 ;;
    esac
done
[ -n "${IMAGE}" ] && [ -n "${LABEL}" ] || { usage >&2; exit 2; }
[[ "${LABEL}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo "label must match [A-Za-z0-9][A-Za-z0-9_.-]*" >&2; exit 2; }
OUT_ROOT="${OUT_ROOT:-${REPO_ROOT}/testing/runs/genesis-acceptance}"

EVID="${OUT_ROOT}/${LABEL}"
mkdir -p "${EVID}"
rm -f "${EVID}"/*.log "${EVID}/summary.md" "${EVID}/results.tsv"
rm -rf "${EVID}/fixtures"
RUNLOG="${EVID}/run.log"
: > "${RUNLOG}"
say() { echo "[gacc $(date -u +%H:%M:%S)] $*" | tee -a "${RUNLOG}" >&2; }
die2() { say "ABORT: $*"; exit 2; }

RID="gacc-${LABEL}-$$"
NET="${RID}-net"
PG="${RID}-pg"
TMP=""
CONTAINERS=()
VOLUMES=()
NETWORK_CREATED=0
MNEMONIC_FILE=""

teardown() {
    local rc=$?
    trap - EXIT INT TERM
    local c v
    for c in "${CONTAINERS[@]}"; do docker rm -f -v "${c}" >/dev/null 2>&1 || true; done
    for v in "${VOLUMES[@]}"; do docker volume rm -f "${v}" >/dev/null 2>&1 || true; done
    [ "${NETWORK_CREATED}" = 1 ] && { docker network rm "${NET}" >/dev/null 2>&1 || true; }
    [ -n "${TMP}" ] && rm -rf "${TMP}"
    [ ${#CONTAINERS[@]} -gt 0 ] && say "removed ${RID} containers, volumes and network"
    exit "${rc}"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# ── lock + preflight ────────────────────────────────────────────────────
exec 9>"${LOCK_FILE}" || die2 "cannot open lock ${LOCK_FILE}"
if ! flock -n 9; then
    say "waiting for ${LOCK_FILE} (up to ${LOCK_TIMEOUT}s)"
    flock -w "${LOCK_TIMEOUT}" 9 || die2 "lock ${LOCK_FILE} still held after ${LOCK_TIMEOUT}s"
fi
{
    echo "== preflight $(date -u +%FT%TZ)"
    df -h /
    free -m
    echo "nproc $(nproc)"
    uptime
    vmstat 1 4
} >> "${RUNLOG}" 2>&1
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
avail_mb=$(free -m | awk '/^Mem:/{print $7}')
load1=$(cut -d' ' -f1 /proc/loadavg)
cores=$(nproc)
# Swap-out in each of the last three 1 s samples: memory pressure. Swap-in
# alone, with RAM available, is old pages being read back and is not counted.
swapping=$(vmstat 1 4 | tail -3 | awk '$8 > 0 {n++} END {print (n == 3) ? 1 : 0}')
say "preflight: disk ${disk_gb}G, RAM available ${avail_mb}M, load ${load1}/${cores} cores, swapping=${swapping}"
abort_pre() { ps -eo pid,comm,rss,%cpu --sort=-rss | head -10 >> "${RUNLOG}"; die2 "$*"; }
[ "${disk_gb:-0}" -lt "${MIN_DISK_GB}" ] && abort_pre "free disk ${disk_gb}G < ${MIN_DISK_GB}G"
[ "${avail_mb:-0}" -lt "${MIN_RAM_MB}" ] && abort_pre "available RAM ${avail_mb}M < ${MIN_RAM_MB}M"
awk -v l="${load1}" -v m="${cores}" 'BEGIN { exit !(l > m) }' && abort_pre "1-min load ${load1} > ${cores} cores"
[ "${swapping}" = 1 ] && abort_pre "the host is actively swapping"

for img in "${IMAGE}" "${PG_IMAGE}"; do
    if ! docker image inspect "${img}" >/dev/null 2>&1; then
        say "pulling ${img}"
        docker pull -q "${img}" >> "${RUNLOG}" 2>&1 || die2 "image ${img} is not local and cannot be pulled"
    fi
done
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "${IMAGE}")
IMAGE_DIGEST=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "${IMAGE}")
IMAGE_COMMIT=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${IMAGE}" | sed -n 's/^GIT_COMMIT=//p')
IMAGE_ENTRY=$(docker image inspect --format '{{json .Config.Entrypoint}} user={{.Config.User}}' "${IMAGE}")
say "image ${IMAGE} id ${IMAGE_ID} digest ${IMAGE_DIGEST:-none} commit ${IMAGE_COMMIT:-unknown} ${IMAGE_ENTRY}"

# ── fixtures ────────────────────────────────────────────────────────────
TMP="$(mktemp -d "${TMPDIR:-/tmp}/gacc-${LABEL}.XXXXXX")"
chmod 700 "${TMP}"
FIX="${TMP}/fixtures"
mkdir -p "${FIX}/image" "${FIX}/manifest" "${TMP}/keys"
chmod 755 "${FIX}"

# Read the image's own genesis and snapshot without running it
CP="${RID}-copy"
docker create --name "${CP}" "${IMAGE}" >/dev/null || die2 "docker create ${IMAGE} failed"
CONTAINERS+=("${CP}")
docker cp -q "${CP}:/app/data/genesis.json" "${FIX}/image/genesis.json" &&
    docker cp -q "${CP}:/app/data/snapshot" "${FIX}/image/snapshot" ||
    die2 "the image has no /app/data/genesis.json or /app/data/snapshot"
docker rm -v "${CP}" >/dev/null
cp "${FIX}/image/snapshot/manifest.json" "${FIX}/manifest/manifest.json"

python3 "${HERE}/fixtures.py" --base "${FIX}/image/genesis.json" --manifest "${FIX}/manifest/manifest.json" \
    --out "${FIX}" --chain-id "${CHAIN_ID}" --timestamp "${GENESIS_TS}" \
    --far-height "${FAR_HEIGHT}" --unknown-fork "${UNKNOWN_FORK}" >> "${RUNLOG}" 2>&1 ||
    die2 "fixture generation failed (run.log)"

# A snapshot whose manifest differs by one trailing newline; the files it lists are untouched
cp -a "${FIX}/image/snapshot" "${FIX}/snapshot-ws"
printf '\n' >> "${FIX}/snapshot-ws/manifest.json"

genesis_hash() { # $1 genesis file -> JSON from scripts/genesis-hash.ts (log lines dropped)
    local out
    out=$(cd "${REPO_ROOT}" && bun scripts/genesis-hash.ts --genesis "$1" --snapshot "${FIX}/manifest" --json 2>>"${RUNLOG}")
    local rc=$?
    echo "${out}" | sed -n '/^{/,$p'
    return ${rc}
}
LAUNCH_JSON=$(genesis_hash "${FIX}/launch.json") || { echo "${LAUNCH_JSON}" >> "${RUNLOG}"; die2 "genesis-hash reports problems with the launch genesis"; }
PIN=$(echo "${LAUNCH_JSON}" | jq -r .genesisDataHash)
LAUNCH_DIGEST=$(echo "${LAUNCH_JSON}" | jq -r .forkScheduleDigest)
MANIFEST_SHA=$(echo "${LAUNCH_JSON}" | jq -r .snapshotManifestSha256)
OTHER_PIN=$(genesis_hash "${FIX}/onebyte.json" | jq -r .genesisDataHash)
FAR_DIGEST=$(genesis_hash "${FIX}/forkfar.json" | jq -r .forkScheduleDigest)
[[ "${PIN}" =~ ^[0-9a-f]{64}$ && "${OTHER_PIN}" =~ ^[0-9a-f]{64}$ && "${PIN}" != "${OTHER_PIN}" ]] ||
    die2 "could not compute the launch and one-byte hashes"
BAD_PIN="${PIN:0:63}"
say "launch genesis hash ${PIN}, fork schedule digest ${LAUNCH_DIGEST}, manifest ${MANIFEST_SHA}"
say "one-byte genesis hash ${OTHER_PIN}; far-fork schedule digest ${FAR_DIGEST}"
mkdir -p "${EVID}/fixtures"
cp "${FIX}"/*.json "${EVID}/fixtures/"
echo "${LAUNCH_JSON}" > "${EVID}/fixtures/launch.genesis-hash.json"

# Identity: a fresh devnet key, generated on the host, kept in the temp dir only
id_out=$(cd "${REPO_ROOT}" && bun testing/devnet/scripts/generate-identity-helper.ts 2>>"${RUNLOG}") ||
    die2 "identity generation failed"
MNEMONIC_FILE="${TMP}/keys/node.identity"
echo "${id_out}" | sed -n 's/^MNEMONIC://p' | tr -d '\n' > "${MNEMONIC_FILE}"
chmod 600 "${MNEMONIC_FILE}"
NODE_PUB=$(echo "${id_out}" | sed -n 's/^PUBKEY://p')
unset id_out
[ -s "${MNEMONIC_FILE}" ] || die2 "identity generation printed no mnemonic"
say "node identity ${NODE_PUB}"

# ── docker plumbing ─────────────────────────────────────────────────────
docker network create "${NET}" >/dev/null || die2 "network create failed"
NETWORK_CREATED=1

# A volume made by a root helper (the postgres image) and handed to uid 1000
new_volume() { # $1 name, $2 shell snippet run with the volume at /v and the temp dir at /in
    docker volume create "$1" >/dev/null || return 1
    VOLUMES+=("$1")
    docker run --rm --network none -v "$1:/v" -v "${TMP}:/in:ro" --entrypoint sh "${PG_IMAGE}" \
        -c "set -e; $2; chown -R 1000:1000 /v" >> "${RUNLOG}" 2>&1
}
state_volume() { # $1 name: identity readable only by the node user
    new_volume "$1" "cp /in/keys/node.identity /v/node.identity && chmod 600 /v/node.identity"
}
new_volume "${RID}-snap-ws" "cp -a /in/fixtures/snapshot-ws/. /v/" || die2 "snapshot volume failed"

docker run -d --name "${PG}" --network "${NET}" --memory "${PG_MEM}" --memory-swap "${PG_MEM}" \
    -e POSTGRES_USER="${PG_USER}" -e POSTGRES_PASSWORD="${PG_PASSWORD}" -e POSTGRES_DB=postgres \
    "${PG_IMAGE}" -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null ||
    die2 "postgres did not start"
CONTAINERS+=("${PG}")
for _ in $(seq 1 60); do
    docker exec "${PG}" pg_isready -q -U "${PG_USER}" -d postgres 2>/dev/null &&
        docker exec "${PG}" psql -U "${PG_USER}" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
done
docker exec "${PG}" psql -U "${PG_USER}" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 || die2 "postgres not ready"

psql_db() { docker exec "${PG}" psql -v ON_ERROR_STOP=1 -U "${PG_USER}" -d "$1" -tAc "$2" 2>&1; }
admin() { psql_db postgres "$1" >> "${RUNLOG}" || die2 "postgres: $1"; }
block0_rows() { # count, or 0 when the table does not exist
    local out
    out=$(psql_db "$1" 'SELECT count(*) FROM blocks WHERE number = 0')
    if [[ "${out}" =~ ^[0-9]+$ ]]; then echo "${out}"
    elif [[ "${out}" == *"does not exist"* ]]; then echo 0
    else echo "error:${out//$'\n'/ }"; fi
}
block0_hash() { psql_db "$1" 'SELECT hash FROM blocks WHERE number = 0' | head -1; }
accepted_row() { # the stored accepted schedule as JSON, or "none"/"no-table"
    local out
    out=$(psql_db "$1" 'SELECT json_build_object($$digest$$, digest, $$tip$$, accepted_at_tip, $$schedule$$, schedule) FROM accepted_fork_schedule')
    if [[ "${out}" == *"does not exist"* ]]; then echo no-table
    elif [ -z "${out}" ]; then echo none
    else echo "${out}"; fi
}
fingerprint() { # what a refused restart must leave untouched
    echo "block0=$(block0_hash "$1") tip=$(psql_db "$1" 'SELECT coalesce(max(number), -1) FROM blocks') accepted=$(accepted_row "$1" | jq -r '.digest // .' 2>/dev/null || accepted_row "$1")"
}

# ── node runs ───────────────────────────────────────────────────────────
NODE=""
OBS=""        # up | exit | timeout
OBS_CODE=""
OBS_SECS=0
start_node() { # $1 scenario id, $2 db, $3 state volume, $4 genesis file, $5 pin or "-" for unset, then extra -e/-v args
    local sid="$1" db="$2" vol="$3" gen="$4" pin="$5"
    shift 5
    NODE="${RID}-${sid}"
    local pin_env=()
    [ "${pin}" != "-" ] && pin_env=(-e "EXPECTED_GENESIS_HASH=${pin}")
    docker run -d --name "${NODE}" --network "${NET}" \
        --memory "${NODE_MEM}" --memory-swap "${NODE_MEM}" --cpus "${NODE_CPUS}" \
        -e PG_HOST="${PG}" -e PG_PORT=5432 -e PG_USER="${PG_USER}" -e PG_PASSWORD="${PG_PASSWORD}" \
        -e PG_DATABASE="${db}" -e RPC_PORT="${RPC_PORT}" \
        -e IDENTITY_FILE=/app/state/node.identity \
        -e TLSNOTARY_ENABLED=false -e METRICS_ENABLED=false -e MCP_ENABLED=false \
        -e GOSSIP_ENABLED=false -e OMNI_ENABLED=false -e OMNI_MODE=HTTP_ONLY \
        -e L2PS_MESSAGING_ENABLED=false -e L2PS_ZK_ENABLED=false \
        -e DEMOS_SKIP_SETUP_CHECK=true -e LOG_LEVEL=info \
        "${pin_env[@]}" "$@" \
        -v "${vol}:/app/state" \
        -v "${gen}:/app/data/genesis.json:ro" \
        "${IMAGE}" >> "${RUNLOG}" 2>&1 || return 1
    CONTAINERS+=("${NODE}")
}
# The RPC server listens only once block 0 is in the database, so any HTTP
# answer on /health means the node is up; the status is kept for the notes.
HEALTH_CODE=""
health_ok() {
    HEALTH_CODE=$(docker exec "${NODE}" curl -sS -m3 -o /dev/null -w '%{http_code}' "http://localhost:${RPC_PORT}/health" 2>/dev/null)
    [[ "${HEALTH_CODE}" =~ ^[1-5][0-9][0-9]$ ]]
}
wait_node() { # $1 timeout: until the node exits, serves /health, or the timeout
    local deadline=$((SECONDS + $1)) t0=${SECONDS} running
    while [ ${SECONDS} -lt ${deadline} ]; do
        running=$(docker inspect -f '{{.State.Running}}' "${NODE}" 2>/dev/null)
        if [ "${running}" != "true" ]; then
            OBS=exit; OBS_CODE=$(docker inspect -f '{{.State.ExitCode}}' "${NODE}"); OBS_SECS=$((SECONDS - t0)); return
        fi
        if health_ok; then OBS=up; OBS_CODE=""; OBS_SECS=$((SECONDS - t0)); return; fi
        sleep 2
    done
    OBS=timeout; OBS_CODE=""; OBS_SECS=$((SECONDS - t0))
}
rpc() { # $1 nodeCall message -> response JSON
    docker exec "${NODE}" curl -sS -m10 -X POST -H 'Content-Type: application/json' \
        -d "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"$1\",\"data\":{},\"muid\":null}]}" \
        "http://localhost:${RPC_PORT}/" 2>/dev/null
}
rpc_ready() { # $1 message: retry while the node answers STATE_NOT_READY
    local out i
    for i in $(seq 1 30); do
        out=$(rpc "$1")
        [ "$(echo "${out}" | jq -r '.result' 2>/dev/null)" = 200 ] && { echo "${out}"; return 0; }
        sleep 2
    done
    echo "${out}"
    return 1
}
save_logs() { # $1 scenario file stem
    local f="${EVID}/$1.node.log"
    docker logs "${NODE}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${f}"
    # The key never belongs in evidence; drop any line that would carry it
    if [ -s "${MNEMONIC_FILE}" ] && grep -qF -- "$(cat "${MNEMONIC_FILE}")" "${f}"; then
        grep -vF -- "$(cat "${MNEMONIC_FILE}")" "${f}" > "${f}.tmp"; mv "${f}.tmp" "${f}"
        say "redacted the identity from $1.node.log"
    fi
}
stop_node() { # clean stop; echoes the exit code
    docker stop -t 60 "${NODE}" >/dev/null 2>&1
    docker inspect -f '{{.State.ExitCode}}' "${NODE}" 2>/dev/null
}
remove_node() { docker rm -f -v "${NODE}" >/dev/null 2>&1; }
refusal_line() { # the refusal the node raised, else the fatal error that stopped it
    local f="${EVID}/$1.node.log" line
    line=$(grep -m1 -E '^(GenesisRefusal|ForkConfigValidationError): ' "${f}" | sed -E 's/^[A-Za-z]+: //')
    [ -z "${line}" ] && line=$(grep -m1 -E '"fatal":true' "${f}" | sed -E 's/^\[[0-9:]+\] //')
    echo "${line}" | cut -c1-240
}

# An exit only counts as a refusal when the genesis or fork rules raised it,
# not when the node died of something else. Bun also prints the source lines
# around a throw, so a bare "Refusing to boot" may be code; only the error
# header and the logged error line count.
REFUSAL_RE='^(GenesisRefusal|ForkConfigValidationError): |\[ERROR\] .*[Rr]efusing to boot'
genesis_refusal() { grep -qE "${REFUSAL_RE}" "${EVID}/$1.node.log"; }

# Checks on a running node: the pin it reports and the five forks active.
BOOT_NOTES=""
boot_checks() { # $1 expected pin; sets BOOT_NOTES, returns 0 when all hold
    local ok=0 gh ni f bad=""
    gh=$(rpc_ready getGenesisDataHash | jq -r '.response' 2>/dev/null)
    ni=$(rpc_ready getNetworkInfo)
    echo "${ni}" > "${EVID}/${CUR}.networkInfo.json"
    if [ "${gh}" = "$1" ]; then BOOT_NOTES="getGenesisDataHash = pin"; else BOOT_NOTES="getGenesisDataHash ${gh:-?} != pin"; ok=1; fi
    for f in ${MAINNET_FORKS}; do
        [ "$(echo "${ni}" | jq -r ".response.forks.${f}.activated" 2>/dev/null)" = true ] &&
            [ "$(echo "${ni}" | jq -r ".response.forks.${f}.activationHeight" 2>/dev/null)" = 0 ] || bad="${bad} ${f}"
    done
    if [ -z "${bad}" ]; then BOOT_NOTES="${BOOT_NOTES}; 5 forks active at 0"; else BOOT_NOTES="${BOOT_NOTES}; not active at 0:${bad}"; ok=1; fi
    local cid tip
    cid=$(echo "${ni}" | jq -r '.response.chainId' 2>/dev/null)
    tip=$(echo "${ni}" | jq -r '.response.forks.signatureDomain.currentHeight' 2>/dev/null)
    [ "${cid}" = "${CHAIN_ID}" ] || { BOOT_NOTES="${BOOT_NOTES}; chainId ${cid}"; ok=1; }
    BOOT_NOTES="${BOOT_NOTES}; tip ${tip}"
    return ${ok}
}

printf 'id\tscenario\texpected\tobserved\tverdict\texit\tblock0\tnotes\n' > "${EVID}/results.tsv"
FAILS=0
record() { # id name expected observed verdict exit block0 notes
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "${EVID}/results.tsv"
    [ "$5" = PASS ] || FAILS=$((FAILS + 1))
    say "$1 $2: $5 (expected $3, observed $4; exit $6, block0 rows $7) $8"
}
observed_text() {
    case "${OBS}" in
        up) echo "boots (RPC up after ${OBS_SECS}s, /health ${HEALTH_CODE})" ;;
        exit) echo "exits ${OBS_CODE} after ${OBS_SECS}s" ;;
        *) echo "neither exit nor RPC within ${OBS_SECS}s" ;;
    esac
}

# A fresh database, a node that must be refused before block 0 is written
fresh_refused() { # id name genesis pin [extra docker args]
    local sid="$1" name="$2" gen="$3" pin="$4"
    shift 4
    CUR="${sid}-${name}"
    say "── ${CUR}"
    admin "CREATE DATABASE ${sid}"
    state_volume "${RID}-${sid}-state" || die2 "state volume failed"
    start_node "${sid}" "${sid}" "${RID}-${sid}-state" "${gen}" "${pin}" "$@" || die2 "docker run failed (${CUR})"
    wait_node "${REFUSE_TIMEOUT}"
    local observed code rows verdict notes
    observed=$(observed_text)
    [ "${OBS}" != exit ] && stop_node >/dev/null
    code=$(docker inspect -f '{{.State.ExitCode}}' "${NODE}")
    save_logs "${CUR}"
    remove_node
    rows=$(block0_rows "${sid}")
    notes=$(refusal_line "${CUR}")
    [ -z "${notes}" ] && notes="no refusal line in the log"
    if [ "${OBS}" = exit ] && [ "${code}" = 1 ] && [ "${rows}" = 0 ] && genesis_refusal "${CUR}"; then verdict=PASS; else verdict=FAIL; fi
    [ "${OBS}" = up ] && notes="block 0 written, node served RPC; stopped by the harness (exit ${code}). ${notes}"
    record "${sid}" "${name}" "refused (exit 1, no block 0)" "${observed}" "${verdict}" "${code}" "${rows}" "${notes}"
    admin "DROP DATABASE IF EXISTS ${sid} WITH (FORCE)"
}

# The restart chain: database "chain", state volume of scenario 1
CHAIN_STATE="${RID}-chain-state"
restore_chain() {
    admin "DROP DATABASE IF EXISTS chain WITH (FORCE)"
    admin "CREATE DATABASE chain TEMPLATE chain_base"
}
restart_refused() { # id name genesis pin [regex the refusal must contain]
    local sid="$1" name="$2" gen="$3" pin="$4" needle="${5:-}"
    CUR="${sid}-${name}"
    say "── ${CUR}"
    restore_chain
    local before after observed code rows verdict notes
    before=$(fingerprint chain)
    start_node "${sid}" chain "${CHAIN_STATE}" "${gen}" "${pin}" || die2 "docker run failed (${CUR})"
    wait_node "${REFUSE_TIMEOUT}"
    observed=$(observed_text)
    [ "${OBS}" != exit ] && stop_node >/dev/null
    code=$(docker inspect -f '{{.State.ExitCode}}' "${NODE}")
    save_logs "${CUR}"
    remove_node
    rows=$(block0_rows chain)
    after=$(fingerprint chain)
    notes=$(refusal_line "${CUR}")
    [ -z "${notes}" ] && notes="no refusal line in the log"
    verdict=PASS
    { [ "${OBS}" = exit ] && [ "${code}" = 1 ] && genesis_refusal "${CUR}"; } || verdict=FAIL
    if [ "${before}" != "${after}" ]; then verdict=FAIL; notes="database changed (${before} -> ${after}). ${notes}"; fi
    if [ -n "${needle}" ]; then
        if grep -E "${REFUSAL_RE}" "${EVID}/${CUR}.node.log" | grep -qE -- "${needle}"; then notes="${notes} [refusal names ${needle}]"
        else verdict=FAIL; notes="${notes} [refusal does not name ${needle}]"; fi
    fi
    [ "${OBS}" = up ] && notes="node served RPC; stopped by the harness (exit ${code}). ${notes}"
    record "${sid}" "${name}" "refused (exit 1, DB unchanged)" "${observed}" "${verdict}" "${code}" "${rows}" "${notes}"
}

# ── 1. fresh-correct ────────────────────────────────────────────────────
CUR="s01-fresh-correct"
say "── ${CUR}"
admin "CREATE DATABASE chain"
state_volume "${CHAIN_STATE}" || die2 "state volume failed"
start_node s01 chain "${CHAIN_STATE}" "${FIX}/launch.json" "${PIN}" || die2 "docker run failed (${CUR})"
wait_node "${BOOT_TIMEOUT}"
OBSERVED=$(observed_text)
VERDICT=FAIL
NOTES=""
if [ "${OBS}" = up ]; then
    boot_checks "${PIN}" && VERDICT=PASS
    NOTES="${BOOT_NOTES}"
    DIG=$(jq -r '.response.forkScheduleDigest' "${EVID}/${CUR}.networkInfo.json" 2>/dev/null)
    if [ "${DIG}" = "${LAUNCH_DIGEST}" ]; then NOTES="${NOTES}; schedule digest = launch"; else NOTES="${NOTES}; schedule digest ${DIG} != launch ${LAUNCH_DIGEST}"; VERDICT=FAIL; fi
    STOP_CODE=$(stop_node)
    NOTES="${NOTES}; clean stop exit ${STOP_CODE}"
fi
CODE=$(docker inspect -f '{{.State.ExitCode}}' "${NODE}")
[ "${OBS}" = timeout ] && stop_node >/dev/null
save_logs "${CUR}"
remove_node
H0=$(block0_hash chain)
ROWS=$(block0_rows chain)
[ "${ROWS}" = 1 ] || VERDICT=FAIL
[ "${OBS}" = exit ] && NOTES="$(refusal_line "${CUR}")"
ACC1=$(accepted_row chain)
NOTES="${NOTES}; block 0 ${H0:0:16}…; accepted schedule: $(echo "${ACC1}" | jq -r '.digest // .' 2>/dev/null || echo "${ACC1}")"
record s01 fresh-correct "boots, pin + 5 forks active" "${OBSERVED}" "${VERDICT}" "${CODE}" "${ROWS}" "${NOTES}"
S01_PASS=${VERDICT}

# ── 2-5. fresh refusals ─────────────────────────────────────────────────
fresh_refused s02 fresh-genesis-1byte "${FIX}/onebyte.json" "${PIN}"
fresh_refused s03 fresh-no-pin "${FIX}/launch.json" -
fresh_refused s04 fresh-bad-pin-format "${FIX}/launch.json" "${BAD_PIN}"
fresh_refused s05 fresh-snapshot-changed "${FIX}/launch.json" "${PIN}" \
    -v "${RID}-snap-ws:/app/snapshot-ws:ro" -e DEMOS_SNAPSHOT_DIR=/app/snapshot-ws

# ── 6. restart-same ─────────────────────────────────────────────────────
CUR="s06-restart-same"
say "── ${CUR}"
if [ "${S01_PASS}" != PASS ] && [ "$(block0_rows chain)" != 1 ]; then
    record s06 restart-same "boots, same block 0" "not run" FAIL - - "scenario 1 left no chain to restart"
    record s07 restart-pin-changed "refused (exit 1, DB unchanged)" "not run" FAIL - - "scenario 1 left no chain"
    record s08 restart-fork-moved-past "refused (exit 1, DB unchanged)" "not run" FAIL - - "scenario 1 left no chain"
    record s09 restart-fork-scheduled-far "boots, new schedule stored" "not run" FAIL - - "scenario 1 left no chain"
    record s10 restart-unknown-fork "refused (exit 1, DB unchanged)" "not run" FAIL - - "scenario 1 left no chain"
else
    start_node s06 chain "${CHAIN_STATE}" "${FIX}/launch.json" "${PIN}" || die2 "docker run failed (${CUR})"
    wait_node "${BOOT_TIMEOUT}"
    OBSERVED=$(observed_text)
    VERDICT=FAIL
    NOTES=""
    if [ "${OBS}" = up ]; then
        boot_checks "${PIN}" && VERDICT=PASS
        NOTES="${BOOT_NOTES}"
        STOP_CODE=$(stop_node)
        NOTES="${NOTES}; clean stop exit ${STOP_CODE}"
    fi
    CODE=$(docker inspect -f '{{.State.ExitCode}}' "${NODE}")
    [ "${OBS}" = timeout ] && stop_node >/dev/null
    save_logs "${CUR}"
    remove_node
    [ "${OBS}" = exit ] && NOTES="$(refusal_line "${CUR}")"
    H6=$(block0_hash chain)
    ROWS=$(block0_rows chain)
    if [ -n "${H0}" ] && [ "${H6}" = "${H0}" ] && [ "${ROWS}" = 1 ]; then NOTES="${NOTES}; same block 0"
    else VERDICT=FAIL; NOTES="${NOTES}; block 0 ${H6:-none} vs ${H0:-none}"; fi
    record s06 restart-same "boots, same block 0" "${OBSERVED}" "${VERDICT}" "${CODE}" "${ROWS}" "${NOTES}"

    # The state every later restart starts from
    admin "CREATE DATABASE chain_base TEMPLATE chain"

    # ── 7, 8. restart refusals ──────────────────────────────────────────
    restart_refused s07 restart-pin-changed "${FIX}/launch.json" "${OTHER_PIN}"
    restart_refused s08 restart-fork-moved-past "${FIX}/forkpast.json" "${PIN}" 'DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST=[0-9a-f]{64}'

    # ── 9. restart-fork-scheduled-far ───────────────────────────────────
    CUR="s09-restart-fork-scheduled-far"
    say "── ${CUR}"
    restore_chain
    start_node s09 chain "${CHAIN_STATE}" "${FIX}/forkfar.json" "${PIN}" || die2 "docker run failed (${CUR})"
    wait_node "${BOOT_TIMEOUT}"
    OBSERVED=$(observed_text)
    VERDICT=FAIL
    NOTES=""
    if [ "${OBS}" = up ]; then
        boot_checks "${PIN}" && VERDICT=PASS
        NOTES="${BOOT_NOTES}"
        AW=$(jq -r '.response.forks.atomicWork.activationHeight' "${EVID}/${CUR}.networkInfo.json" 2>/dev/null)
        DIG=$(jq -r '.response.forkScheduleDigest' "${EVID}/${CUR}.networkInfo.json" 2>/dev/null)
        if [ "${AW}" = "${FAR_HEIGHT}" ] && [ "${DIG}" = "${FAR_DIGEST}" ]; then NOTES="${NOTES}; reports atomicWork at ${AW}"
        else VERDICT=FAIL; NOTES="${NOTES}; reports atomicWork ${AW}, digest ${DIG}"; fi
        STOP_CODE=$(stop_node)
        NOTES="${NOTES}; clean stop exit ${STOP_CODE}"
    fi
    CODE=$(docker inspect -f '{{.State.ExitCode}}' "${NODE}")
    [ "${OBS}" = timeout ] && stop_node >/dev/null
    save_logs "${CUR}"
    remove_node
    [ "${OBS}" = exit ] && NOTES="$(refusal_line "${CUR}")"
    ROWS=$(block0_rows chain)
    ACC9=$(accepted_row chain)
    if [ "$(echo "${ACC9}" | jq -r '.digest' 2>/dev/null)" = "${FAR_DIGEST}" ] &&
        [ "$(echo "${ACC9}" | jq -r ".schedule.forks.atomicWork.activationHeight" 2>/dev/null)" = "${FAR_HEIGHT}" ]; then
        NOTES="${NOTES}; new schedule stored"
    else
        VERDICT=FAIL
        NOTES="${NOTES}; new schedule not stored (accepted_fork_schedule: $(echo "${ACC9}" | jq -r '.digest // .' 2>/dev/null || echo "${ACC9}"))"
    fi
    [ "$(block0_hash chain)" = "${H0}" ] || { VERDICT=FAIL; NOTES="${NOTES}; block 0 changed"; }
    record s09 restart-fork-scheduled-far "boots, new schedule stored" "${OBSERVED}" "${VERDICT}" "${CODE}" "${ROWS}" "${NOTES}"

    # ── 10. restart-unknown-fork ────────────────────────────────────────
    restart_refused s10 restart-unknown-fork "${FIX}/unknownfork.json" "${PIN}"
fi

# ── summary ─────────────────────────────────────────────────────────────
TOTAL=$(($(wc -l < "${EVID}/results.tsv") - 1))
{
    echo "# Genesis acceptance: ${LABEL}"
    echo
    echo "- Image: \`${IMAGE}\`"
    echo "- Resolved: \`${IMAGE_DIGEST:-no registry digest (local build)}\`, image id \`${IMAGE_ID}\`"
    echo "- Image commit (GIT_COMMIT): \`${IMAGE_COMMIT:-unknown}\`; entrypoint and user as published: \`${IMAGE_ENTRY}\`"
    echo "- Run: $(date -u +%FT%TZ), harness \`testing/genesis-acceptance/run.sh\` at $(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null)$([ -n "$(git -C "${REPO_ROOT}" status --porcelain -- testing/genesis-acceptance 2>/dev/null)" ] && echo ' (harness not committed there)')"
    echo "- Launch genesis: chain id ${CHAIN_ID}, timestamp ${GENESIS_TS}, forks ${MAINNET_FORKS// /, } at 0, image's bundled snapshot bound by manifest sha256 \`${MANIFEST_SHA}\`"
    echo "- EXPECTED_GENESIS_HASH (launch): \`${PIN}\`; fork schedule digest \`${LAUNCH_DIGEST}\`"
    echo "- Other pins: one-byte genesis \`${OTHER_PIN}\`; malformed \`${BAD_PIN}\` (63 hex)"
    echo "- Containers: node \`--memory ${NODE_MEM} --cpus ${NODE_CPUS}\`, postgres \`--memory ${PG_MEM}\`, private bridge network, no published ports, empty peer list"
    echo
    echo "Result: $((TOTAL - FAILS))/${TOTAL} scenarios matched."
    echo
    echo "| # | Scenario | Expected | Observed | Verdict | Exit | Block-0 rows | Notes |"
    echo "| --- | --- | --- | --- | --- | --- | --- | --- |"
    tail -n +2 "${EVID}/results.tsv" | while IFS=$'\t' read -r id name exp obs ver code rows notes; do
        echo "| ${id} | ${name} | ${exp} | ${obs} | ${ver} | ${code} | ${rows} | ${notes//|/\\|} |"
    done
    echo
    echo "Node logs: \`<scenario>.node.log\`; fixtures: \`fixtures/\`; harness log: \`run.log\`."
} > "${EVID}/summary.md"
say "summary: ${EVID}/summary.md ($((TOTAL - FAILS))/${TOTAL} matched)"
[ "${FAILS}" = 0 ] && exit 0
exit 1
