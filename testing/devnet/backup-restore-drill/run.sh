#!/usr/bin/env bash
# Timed backup / wipe / restore drill on a throwaway 4-validator devnet
# (mainnet-launch #16, G16-b). Configuration is by environment, see README.md
# and docs/runbooks/backup-restore-drill.md.
#
#   NODE_IMAGE=<prebuilt local image> BASE_PORT=65000 testing/devnet/backup-restore-drill/run.sh
#
# VARIANT=rejoin (default)  back up node 4, wipe its database and non-identity
#                           state while KEEPING its identity and signing state,
#                           restore the dump, restart it, time the rejoin.
# VARIANT=isolated          back up node 4 (it keeps running) and restore the
#                           dump into a new non-signing node with no identity.
# SMOKE=1                   startup check only, run it before the full drill:
#                           the same preflight (images, load wait, uid-1000
#                           read and write checks, gossip check), bring up the
#                           4 nodes, wait until each serves RPC at head >= 2
#                           (cap 5 minutes), print PASS/FAIL, tear down.
#
# Gossip is on by default. GOSSIP_ENABLED=false needs ALLOW_GOSSIP_OFF=1.
# The node-state volumes must be writable by uid 1000 (FIX_OWNERSHIP=1 chowns
# this drill's own volumes to 1000:1000 instead of stopping).
#
# Phases timed: A backup, A2 copy the dump to the host, B wipe, C restore, D rejoin.
# Everything lives in $OUT_DIR (mode 700, gitignored under runs/). On exit,
# teardown runs compose down -v on the project (default demos-bkdrill) and
# checks that nothing of it is left.
# Exit codes: 0 every check passed, 1 a check failed, 2 the drill could not be
# carried out (preflight, boot, timeout), 3 every check passed but the teardown
# failed or left something (timings.md says what).

# SC2016: the single-quoted scripts are run by sh inside a container, on purpose.
# SC2329: teardown is the EXIT trap. SC2094: sum_of only reads the files the loops read.
# shellcheck disable=SC2016,SC2329,SC2094
set -euo pipefail

# Everything runs at nice 10 (this script and the docker CLI it starts; the
# containers themselves are dockerd's children, they get cpu_shares instead)
if [ -z "${BKDRILL_NICED:-}" ]; then
    command -v nice >/dev/null 2>&1 || { echo "nice not found" >&2; exit 2; }
    BKDRILL_NICED=1 exec nice -n 10 bash "${BASH_SOURCE[0]}" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"

NODE_IMAGE="${NODE_IMAGE:-demos-node:candidate-5979a716}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
BASE_PORT="${BASE_PORT:-65000}"
PROJECT="${PROJECT:-demos-bkdrill}"
VARIANT="${VARIANT:-rejoin}"
N=4
X_NODE="${X_NODE:-4}"
# q = floor(2 * shardSize / 3) + 1. 4 validators at shardSize 4: q = 3, so the
# 3 others keep forging while node X is down. Set SHARD_SIZE=5 for q = 4
# (4-of-4): the chain then pauses while X is down, which is reported as
# expected, not as a failure.
SHARD_SIZE="${SHARD_SIZE:-4}"
H0="${H0:-5}"
CONSENSUS_TIME="${CONSENSUS_TIME:-10}"
NODE_MEM="${NODE_MEM:-1800m}"
PG_MEM="${PG_MEM:-512m}"
CPU_SHARES="${CPU_SHARES:-256}"
NODE_EST_MB="${NODE_EST_MB:-1100}"
HEADROOM_MB="${HEADROOM_MB:-3072}"
MIN_DISK_GB="${MIN_DISK_GB:-10}"
LOAD_MAX="${LOAD_MAX:-18}"
LOAD_WAIT_MAX="${LOAD_WAIT_MAX:-1800}"
LOAD_POLL="${LOAD_POLL:-20}"
GENESIS_DELAY="${GENESIS_DELAY:-$((60 + N * 25))}"
BRINGUP_TIMEOUT="${BRINGUP_TIMEOUT:-900}"
SERVE_TIMEOUT="${SERVE_TIMEOUT:-240}"
REJOIN_TIMEOUT="${REJOIN_TIMEOUT:-420}"
SIGN_TIMEOUT="${SIGN_TIMEOUT:-300}"
STOP_GRACE="${STOP_GRACE:-10}"
STALL_LIMIT="${STALL_LIMIT:-90}"
# The one command that applies pending migrations (docs/runbooks/database-
# migrations.md). It runs in a one-off container of NODE_IMAGE against one
# database, with PG_HOST / PG_DATABASE set by this script.
MIGRATE_CMD="${MIGRATE_CMD:-bun run migration:run}"
MIGRATE_REQUIRED="${MIGRATE_REQUIRED:-1}"
# Seconds one migrate run may take before it is stopped and counts as failed
MIGRATE_TIMEOUT="${MIGRATE_TIMEOUT:-300}"
# The genesis fork schedule, passed to quorum-drills/gen-inputs.py --fork-set:
# "launch" is the set docs/mainnet/genesis.template.json activates at height 0,
# without the forks the drills cannot run (drill_inputs.py
# LAUNCH_EXCLUDED_FORKS); "devnet" is that of testing/devnet/genesis.devnet.json
FORK_SET="${FORK_SET:-launch}"
ISO_NODE="${ISO_NODE:-1}"
KEEP_KEYS="${KEEP_KEYS:-0}"
IDENTITY_GEN="${IDENTITY_GEN:-auto}"
RUNS_DIR="${RUNS_DIR:-${HERE}/runs}"
# Where the per-PROJECT lock file lives: /tmp, which every run on this host sees,
# whatever its checkout or OUT_DIR (the projects share the host's Docker daemon)
LOCK_DIR="${LOCK_DIR:-/tmp}"
SMOKE="${SMOKE:-0}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-300}"
SMOKE_HEAD="${SMOKE_HEAD:-2}"
# Gossip: on unless GOSSIP_ENABLED=false (gen-compose.py reads it from the
# environment too); off is refused without ALLOW_GOSSIP_OFF=1
GOSSIP_ENABLED="${GOSSIP_ENABLED:-true}"
ALLOW_GOSSIP_OFF="${ALLOW_GOSSIP_OFF:-0}"
FIX_OWNERSHIP="${FIX_OWNERSHIP:-0}"

usage() {
    sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
    echo "Environment: NODE_IMAGE PG_IMAGE BASE_PORT PROJECT VARIANT OUT_DIR SHARD_SIZE H0 CONSENSUS_TIME"
    echo "             NODE_MEM PG_MEM CPU_SHARES LOAD_MAX LOAD_WAIT_MAX STOP_GRACE STALL_LIMIT"
    echo "             MIGRATE_CMD MIGRATE_REQUIRED MIGRATE_TIMEOUT FORK_SET ISO_NODE KEEP_KEYS IDENTITY_GEN RUNS_DIR LOCK_DIR"
    echo "             SMOKE SMOKE_TIMEOUT SMOKE_HEAD GOSSIP_ENABLED ALLOW_GOSSIP_OFF FIX_OWNERSHIP (README.md)"
}
case "${1:-}" in
    -h | --help) usage; exit 0 ;;
    "") ;;
    *) echo "unknown argument $1 (configuration is by environment)" >&2; usage >&2; exit 2 ;;
esac

is_num() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }

# ── configuration checks ────────────────────────────────────────────────
cfg_err() { echo "config: $*" >&2; exit 2; }
for v in BASE_PORT X_NODE SHARD_SIZE H0 CONSENSUS_TIME CPU_SHARES NODE_EST_MB HEADROOM_MB MIN_DISK_GB LOAD_MAX \
    LOAD_WAIT_MAX LOAD_POLL GENESIS_DELAY BRINGUP_TIMEOUT SERVE_TIMEOUT REJOIN_TIMEOUT SIGN_TIMEOUT STOP_GRACE STALL_LIMIT \
    SMOKE_TIMEOUT SMOKE_HEAD MIGRATE_TIMEOUT; do
    is_num "${!v}" || cfg_err "${v} must be a whole number, got '${!v}'"
done
# timeout 0 would mean no limit
[ "${MIGRATE_TIMEOUT}" -ge 1 ] || cfg_err "MIGRATE_TIMEOUT must be at least 1"
case "${FORK_SET}" in launch | devnet) ;; *) cfg_err "FORK_SET must be launch or devnet, got '${FORK_SET}'" ;; esac
for v in SMOKE ALLOW_GOSSIP_OFF FIX_OWNERSHIP; do
    case "${!v}" in 0 | 1) ;; *) cfg_err "${v} must be 0 or 1, got '${!v}'" ;; esac
done
case "${GOSSIP_ENABLED}" in true | false) ;; *) cfg_err "GOSSIP_ENABLED must be true or false, got '${GOSSIP_ENABLED}'" ;; esac
[[ "${PROJECT}" =~ ^demos-[a-z0-9][a-z0-9_-]*$ ]] || cfg_err "PROJECT must match demos-[a-z0-9_-]+ (got '${PROJECT}')"
case "${VARIANT}" in rejoin | isolated) ;; *) cfg_err "VARIANT must be rejoin or isolated" ;; esac
# Node 1 is the peerlist anchor every other node learns the mesh from
{ [ "${X_NODE}" -ge 2 ] && [ "${X_NODE}" -le "${N}" ]; } || cfg_err "X_NODE must be 2..${N} (node 1 is the peerlist anchor)"
# The ports used are BASE_PORT+1 .. BASE_PORT+N+1; 640xx and 643xx belong to the other drills
if [ "${BASE_PORT}" -lt 1024 ] || [ $((BASE_PORT + N + 1)) -gt 65535 ]; then cfg_err "BASE_PORT out of range"; fi
if [ "${BASE_PORT}" -le 64099 ] && [ $((BASE_PORT + N + 1)) -ge 64000 ]; then cfg_err "BASE_PORT overlaps 640xx"; fi
if [ "${BASE_PORT}" -le 64399 ] && [ $((BASE_PORT + N + 1)) -ge 64300 ]; then cfg_err "BASE_PORT overlaps 643xx"; fi
Q=$((SHARD_SIZE * 2 / 3 + 1))
[ "${Q}" -le "${N}" ] || cfg_err "shardSize ${SHARD_SIZE} needs q=${Q} signers but only ${N} validators exist: the chain would never forge"
LIVE_OTHERS=$((N - 1))
EXPECT_PAUSE=0
[ "${LIVE_OTHERS}" -lt "${Q}" ] && EXPECT_PAUSE=1

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${PROJECT}-bkdrill-${VARIANT}"
if [ "${SMOKE}" = 1 ]; then RUN_ID="${RUN_ID%-"${VARIANT}"}-smoke"; fi
OUT_DIR="${OUT_DIR:-${RUNS_DIR}/${RUN_ID}}"
command -v flock > /dev/null 2>&1 || cfg_err "flock not found (util-linux); it keeps two runs of one PROJECT apart"
# Each run writes only to a dir it created itself, so neither a retry nor a run started
# at the same time (another PROJECT, or the same explicit OUT_DIR) can overwrite its
# results. OUT_DIR is reserved by a plain mkdir, which fails when it exists, before
# anything is written; an existing dir is refused even when empty
mkdir -p -- "$(dirname -- "${OUT_DIR}")" || cfg_err "cannot create the parent dir of OUT_DIR ${OUT_DIR}"
if ! mkdir_err="$(mkdir -- "${OUT_DIR}" 2>&1)"; then
    if [ -e "${OUT_DIR}" ] || [ -L "${OUT_DIR}" ]; then
        cfg_err "OUT_DIR ${OUT_DIR} already exists; every run needs a new dir, so an existing one is refused even when empty (it may hold an earlier run's results, or be another run's). Nothing was written. Use a new OUT_DIR, or leave it unset for a new timestamped dir under ${RUNS_DIR}"
    fi
    cfg_err "cannot create OUT_DIR ${OUT_DIR}: ${mkdir_err}"
fi
# One run per PROJECT at a time: two runs of one project would share its containers
# and volumes, and either teardown would delete the other's. The lock is taken before
# any check of the project's resources and held on fd 9 until this process exits,
# after teardown; a second run exits 2 here, before it writes anything (the empty
# OUT_DIR it has just created is removed again)
LOCK_FILE="${LOCK_DIR}/${PROJECT}.lock"
lock_err() { rmdir -- "${OUT_DIR}" 2> /dev/null || true; echo "$*" >&2; exit 2; }
exec 9>> "${LOCK_FILE}" || lock_err "config: cannot open the lock file ${LOCK_FILE}"
if ! flock -n 9; then
    lock_err "another run of PROJECT ${PROJECT} holds ${LOCK_FILE}: it has not finished its teardown. Nothing was done; wait for it to end, or use another PROJECT"
fi
LOG_DIR="${OUT_DIR}/logs"
IN="${OUT_DIR}/inputs"
BACKUP_DIR="${OUT_DIR}/backup"
mkdir -p "${LOG_DIR}" "${IN}/empty-snapshot" "${BACKUP_DIR}"
chmod 700 "${OUT_DIR}" "${BACKUP_DIR}"
PHASES="${OUT_DIR}/phases.tsv"
CHECKS="${OUT_DIR}/checks.tsv"
: > "${PHASES}"
: > "${CHECKS}"

STEP_LOG="${LOG_DIR}/run.log"
say() {
    local m
    m="[bkdrill $(date -u +%H:%M:%S)] $*"
    echo "${m}" | tee -a "${LOG_DIR}/run.log"
    if [ "${STEP_LOG}" != "${LOG_DIR}/run.log" ]; then echo "${m}" >> "${STEP_LOG}"; fi
    return 0
}
step() { STEP_LOG="${LOG_DIR}/$1.log"; say "── $1"; }

dc() { docker compose -f "${OUT_DIR}/compose.yml" -p "${PROJECT}" "$@"; }
vol() { echo "${PROJECT}_$1"; }

# ── timing and verdict bookkeeping ──────────────────────────────────────
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }
PH_T0=0
phase_begin() { PH_T0="$(now)"; }
phase_end() { # id, name
    local s
    s="$(since "${PH_T0}")"
    printf '%s\t%s\t%s\n' "$1" "$2" "${s}" >> "${PHASES}"
    say "PHASE ${1} ${2}: ${s}s"
}
ANY_FAIL=0
check() { # name, PASS|FAIL|INFO, detail
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "${CHECKS}"
    say "CHECK ${2}: ${1} (${3})"
    if [ "$2" = FAIL ]; then ANY_FAIL=1; fi
    return 0
}

RESULT=""
REPORT_WRITTEN=0
# What teardown did; it rewrites the report with this once it has run
CLEANUP="not run yet"
declare -A META
write_report() {
    local res="${RESULT:-ABORTED}" phases checks
    phases="$(jq -Rn '[inputs | split("\t") | {id: .[0], name: .[1], seconds: (.[2] | tonumber)}]' < "${PHASES}")"
    checks="$(jq -Rn '[inputs | split("\t") | {name: .[0], result: .[1], detail: .[2]}]' < "${CHECKS}")"
    local meta='{}' k
    for k in "${!META[@]}"; do meta="$(jq -c --arg k "${k}" --arg v "${META[${k}]}" '. + {($k): $v}' <<< "${meta}")"; done
    jq -n --arg run "${RUN_ID}" --arg variant "${VARIANT}" --arg project "${PROJECT}" --arg result "${res}" \
        --arg image "${NODE_IMAGE}" --arg pgImage "${PG_IMAGE}" --argjson n "${N}" --argjson shardSize "${SHARD_SIZE}" \
        --argjson q "${Q}" --argjson xNode "${X_NODE}" --argjson expectPause "${EXPECT_PAUSE}" --arg forkSet "${FORK_SET}" \
        --argjson phases "${phases}" --argjson checks "${checks}" --argjson meta "${meta}" --arg cleanup "${CLEANUP}" \
        '{run: $run, variant: $variant, project: $project, result: $result, cleanup: $cleanup, image: $image, pgImage: $pgImage,
          forkSet: $forkSet, validators: $n, shardSize: $shardSize, q: $q, drilledNode: $xNode,
          expectChainPauseWhileDown: ($expectPause == 1), phases: $phases, checks: $checks, meta: $meta}' > "${OUT_DIR}/timings.json"
    {
        echo "# Backup / wipe / restore drill ${RUN_ID}"
        echo
        echo "- result: **${res}**; variant \`${VARIANT}\`; node ${X_NODE} of ${N}; shardSize ${SHARD_SIZE}, q ${Q}; fork set \`${FORK_SET}\`"
        echo "- cleanup: ${CLEANUP/#FAILED/**FAILED**}"
        echo "- images: node \`${NODE_IMAGE}\`, postgres \`${PG_IMAGE}\`"
        for k in $(printf '%s\n' "${!META[@]}" | sort); do echo "- ${k}: ${META[${k}]}"; done
        echo
        echo "| Phase | What | Seconds |"
        echo "|---|---|---|"
        awk -F'\t' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }' "${PHASES}"
        echo
        echo "| Check | Result | Detail |"
        echo "|---|---|---|"
        awk -F'\t' '{ printf "| %s | %s | %s |\n", $1, $2, $3 }' "${CHECKS}"
    } > "${OUT_DIR}/timings.md"
    REPORT_WRITTEN=1
}

# ── teardown ────────────────────────────────────────────────────────────
STARTED_STACK=0
MON_PID=""
stop_monitor() {
    if [ -n "${MON_PID}" ]; then
        kill "${MON_PID}" 2>/dev/null || true
        wait "${MON_PID}" 2>/dev/null || true
        MON_PID=""
    fi
}
teardown() {
    local rc=$?
    trap - EXIT INT TERM
    set +e
    stop_monitor
    if [ "${STARTED_STACK}" = 1 ]; then
        say "collecting container logs"
        local i cid
        for i in $(seq 1 "${N}") iso; do
            cid="$(dc ps -aq "node-${i}" 2>/dev/null)"
            if [ -n "${cid}" ]; then docker logs "${cid}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${LOG_DIR}/node-${i}.log"; fi
        done
        [ "${REPORT_WRITTEN}" = 1 ] || write_report
        say "tearing down ${PROJECT} (compose down -v for this project only)"
        # Helper containers carry this label so an interrupted one cannot pin a volume
        docker ps -aq --filter "label=demos.drill.helper=${PROJECT}" | xargs -r docker rm -f > /dev/null 2>&1
        local errs="" left_c left_v left_n nc nv nn
        dc down -v --remove-orphans > "${LOG_DIR}/teardown.log" 2>&1 || errs="compose down -v exited $? (logs/teardown.log); "
        # A failed listing counts as a failure, not as nothing left
        left_c="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}")" || errs+="cannot list containers; "
        left_v="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}")" || errs+="cannot list volumes; "
        left_n="$(docker network ls -q --filter "label=com.docker.compose.project=${PROJECT}")" || errs+="cannot list networks; "
        nc="$(printf '%s' "${left_c}" | grep -c .)"
        nv="$(printf '%s' "${left_v}" | grep -c .)"
        nn="$(printf '%s' "${left_n}" | grep -c .)"
        say "left over in ${PROJECT} after teardown: ${nc} containers, ${nv} volumes, ${nn} networks"
        if [ $((nc + nv + nn)) -gt 0 ]; then errs+="left over: ${nc} containers, ${nv} volumes, ${nn} networks; "; fi
        if [ -z "${errs}" ]; then
            CLEANUP="done, nothing of ${PROJECT} left"
        else
            CLEANUP="FAILED: ${errs%; }"
            say "CLEANUP FAILED: ${errs%; }"
            say "check and remove by hand: docker ps -a, docker volume ls and docker network ls, each with --filter label=com.docker.compose.project=${PROJECT}"
            if [ "${rc}" = 0 ]; then rc=3; fi
        fi
    else
        CLEANUP="not needed, the compose project was never created"
    fi
    write_report
    if [ "${KEEP_KEYS}" != 1 ]; then
        # Throwaway devnet keys: the identity inputs go; dump, logs and timings stay
        rm -f "${IN}"/node*.identity "${IN}"/gen-identity.ts
        rm -rf "${OUT_DIR}/state-sums"
    fi
    say "run dir: ${OUT_DIR}"
    exit "${rc}"
}
trap teardown EXIT
trap 'exit 130' INT TERM

die() { say "ERROR: $*"; RESULT=ERROR; exit 2; }
abort_pre() { say "ABORT: $*"; RESULT=ERROR; exit 2; }

# ── helpers: ports, rpc, heads ──────────────────────────────────────────
port_of() { if [ "$1" = iso ]; then echo $((53549 + 2 * (N + 1))); else echo $((53549 + 2 * $1)); fi; }
db_of() { if [ "$1" = iso ]; then echo nodeiso_db; else echo "node$1_db"; fi; }
declare -A CID PUB
refresh_cid() { CID[$1]="$(dc ps -q "node-$1" 2>/dev/null || true)"; }
rpc() { # $1 node, $2 JSON body
    local cid="${CID[$1]:-}"
    [ -n "${cid}" ] || return 1
    docker exec "${cid}" curl -sS -m4 -X POST -H 'Content-Type: application/json' \
        -d "$2" "http://localhost:$(port_of "$1")/" 2>/dev/null
}
# The reads below fail (status not 0) when the read fails or gives nothing: no head
# number, no block, no hash. A caller that goes on records that as unreadable
head_of() {
    rpc "$1" '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{},"muid":null}]}' |
        jq -er 'select(.result == 200) | .response | tostring | select(test("^[0-9]+$"))' 2>/dev/null
}
block_at() { # $1 node, $2 height -> the block's JSON
    rpc "$1" "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getBlockByNumber\",\"data\":{\"blockNumber\":$2},\"muid\":null}]}" |
        jq -ec 'select(.result == 200) | .response | objects' 2>/dev/null
}
hash_at() { block_at "$1" "$2" | jq -er '.hash | strings | select(length > 0)' 2>/dev/null; }
serving() {
    local cid="${CID[$1]:-}"
    [ -n "${cid}" ] || return 1
    docker exec "${cid}" curl -sS -m3 "http://localhost:$(port_of "$1")/" 2>/dev/null | grep -q Hello
}
wait_serve() { # $1 node, $2 timeout
    local deadline=$((SECONDS + $2))
    while [ "${SECONDS}" -lt "${deadline}" ]; do
        if serving "$1"; then return 0; fi
        sleep 3
    done
    return 1
}
read_head() { # retried so one slow answer is not a failed read
    local k h
    for k in 1 2 3; do
        h="$(head_of "$1")"
        if is_num "${h}"; then echo "${h}"; return 0; fi
        sleep 1
    done
    return 1
}
OTHERS=()
ALL_NODES=()
for i in $(seq 1 "${N}"); do
    ALL_NODES+=("${i}")
    if [ "${i}" != "${X_NODE}" ]; then OTHERS+=("${i}"); fi
done
# Highest head among the given nodes that answer; empty when none does
max_head_of() {
    local i h m=""
    for i in "$@"; do
        h="$(head_of "${i}")"
        if is_num "${h}" && { [ -z "${m}" ] || [ "${h}" -gt "${m}" ]; }; then m="${h}"; fi
    done
    echo "${m}"
}
min_head_of() { # empty if any does not answer
    local i h m=""
    for i in "$@"; do
        h="$(head_of "${i}")"
        is_num "${h}" || { echo ""; return 0; }
        if [ -z "${m}" ] || [ "${h}" -lt "${m}" ]; then m="${h}"; fi
    done
    echo "${m}"
}
span_head_of() { # "lowest<TAB>highest" head of the given nodes, empty if any does not answer
    local i h lo="" hi=""
    for i in "$@"; do
        h="$(head_of "${i}")"
        is_num "${h}" || { echo ""; return 0; }
        if [ -z "${lo}" ] || [ "${h}" -lt "${lo}" ]; then lo="${h}"; fi
        if [ -z "${hi}" ] || [ "${h}" -gt "${hi}" ]; then hi="${h}"; fi
    done
    printf '%s\t%s\n' "${lo}" "${hi}"
}
# One chain above a height: every given node answers its head, the lowest of them is
# above $1, and all give the same block hash at it. Prints that block, or what is not
# so and then returns 1
same_chain() { # $1 floor, rest: nodes, the one to compare first
    local floor="$1" lo i h ref=""
    shift
    lo="$(min_head_of "$@")"
    is_num "${lo}" || { echo "a head of nodes $* unreadable"; return 1; }
    [ "${lo}" -gt "${floor}" ] || { echo "the highest height all of nodes $* have, ${lo}, is not above ${floor}"; return 1; }
    for i in "$@"; do
        h="$(hash_at "${i}" "${lo}")" || { echo "no hash of block ${lo} on node ${i}"; return 1; }
        ref="${ref:-${h}}"
        [ "${h}" = "${ref}" ] || { echo "block ${lo} is ${h:0:12}.. on node ${i}, ${ref:0:12}.. on node $1"; return 1; }
    done
    echo "block ${lo} ${ref:0:12}.. on nodes $*"
}

# ── helpers: containers and volumes ─────────────────────────────────────
pgx() { # $1 postgres name (1..N|iso), rest: command in its container, stdin passes through
    local cid
    cid="$(dc ps -q "pg-$1" 2>/dev/null)"
    [ -n "${cid}" ] || return 1
    shift
    docker exec -i "${cid}" "$@"
}
psql_q() { pgx "$1" psql -U demosuser -d "$(db_of "$1")" -tAc "$2"; }
wait_pg() { # $1 name, $2 timeout. TCP on 127.0.0.1: the init-time server listens on the socket only
    local deadline=$((SECONDS + $2)) cid
    while [ "${SECONDS}" -lt "${deadline}" ]; do
        cid="$(dc ps -q "pg-$1" 2>/dev/null)"
        if [ -n "${cid}" ] && docker exec "${cid}" pg_isready -h 127.0.0.1 -U demosuser -d "$(db_of "$1")" > /dev/null 2>&1; then return 0; fi
        sleep 2
    done
    return 1
}
# One-off root shell on PG_IMAGE (busybox), no network, labelled for teardown.
# $1 script, rest: docker run options before it (volumes)
helper() {
    local script="$1"
    shift
    docker run --rm --user 0 --network none --label "demos.drill.helper=${PROJECT}" --entrypoint sh "$@" -c "${script}" sh
}
xstate_ro() { helper "$1" -v "$(vol "state-${X_NODE}"):/s:ro" "${PG_IMAGE}"; }
# Hash of every identity / signing state file, one "hash  name" line each. The
# short-lived .lock files change every beat and are left out. Never prints contents.
# Fails when one cannot be hashed
state_sums() {
    xstate_ro 'cd /s || exit 1; for f in node.identity*; do [ -f "$f" ] || continue; case "$f" in *.lock) continue ;; esac; sha256sum "$f" || exit 1; done' | sort -k2
}
# "height round" of a signing state file, never the rest of it; fails when the file is
# absent, cannot be read or lacks either. The node orders each by height, then round: the round is
# .timestamp in the signing record (src/libs/identity/signingRecord.ts: "a round is
# identified by (height, timestamp)") and .round in the commit lock (judgeLock in
# src/libs/consensus/v2/commitLock/lockStore.ts) and in the prevote record
# (prevoteRefusal in prevoteRecord.ts there)
record_pos() { # $1 signed|commitlock|prevote
    local field=round
    if [ "$1" = signed ]; then field=timestamp; fi
    xstate_ro "cat /s/node.identity.${1}.json 2>/dev/null" |
        jq -er --arg f "${field}" 'select((.height | type) == "number" and (.[$f] | type) == "number") | "\(.height) \(.[$f])"' 2>/dev/null
}
# How the "height round" $2 stands to $1: newer, equal or older (height first, then
# round); unknown when either is missing
pos_order() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        if (split(a, x, " ") != 2 || split(b, y, " ") != 2) r = "unknown"
        else if (x[1] + 0 != y[1] + 0) r = (y[1] + 0 > x[1] + 0) ? "newer" : "older"
        else if (x[2] + 0 != y[2] + 0) r = (y[2] + 0 > x[2] + 0) ? "newer" : "older"
        else r = "equal"
        print r
    }'
}
sum_of() { awk -v n="$2" '$2 == n { print $1 }' "$1"; }
short() { printf '%s' "${1:0:12}"; }
sha_ok() { [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]]; }
state_names() { xstate_ro 'ls -A /s'; }
# "uid:gid mode name" of the state dir (.) and the identity files: the wipe, which runs as root, must leave them as the node's uid 1000 had them
state_owners() { xstate_ro 'cd /s && stat -c "%u:%g %a %n" . node.identity*' | sort; }
# No container, running or not, may hold the drilled node's state volume or be its node service
assert_x_not_running() {
    local running holders
    running="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=node-${X_NODE}")" || die "cannot list the node-${X_NODE} containers"
    [ -z "${running}" ] || die "node-${X_NODE} is still running; refusing to touch its key"
    holders="$(docker ps -q --filter "volume=$(vol "state-${X_NODE}")")" || die "cannot list the containers on node ${X_NODE}'s state volume"
    [ -z "${holders}" ] || die "a container still holds the state volume of node ${X_NODE}"
}
assert_single_x() {
    local n
    n="$(docker ps -q --filter "volume=$(vol "state-${X_NODE}")" | wc -l)" || die "cannot list the containers on node ${X_NODE}'s state volume"
    [ "${n}" = 1 ] || die "expected exactly one container on node ${X_NODE}'s state volume, found ${n}"
    n="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=node-${X_NODE}" | wc -l)" || die "cannot list the node-${X_NODE} containers"
    [ "${n}" = 1 ] || die "expected exactly one node-${X_NODE} container, found ${n}"
}

run_migrations() { # $1 name; the manual step of docs/runbooks/database-migrations.md
    local rc=0 t0="${SECONDS}"
    say "migrations on $(db_of "$1"): ${MIGRATE_CMD}"
    # Bounded, as in quorum-drills/run.sh: a hung migration must not hang the
    # drill. docker compose is spelled out because timeout cannot run the dc
    # function. -k: if compose outlives the TERM (it may pass it on to the
    # container and keep waiting), it is killed 10 s later, exit 137 instead of
    # 124. timeout runs its command in a process group of its own, where a read
    # from the terminal would stop it, so stdin is /dev/null.
    timeout -k 10 "${MIGRATE_TIMEOUT}" docker compose -f "${OUT_DIR}/compose.yml" -p "${PROJECT}" \
        run --rm --no-deps -T -e "PG_HOST=pg-$1" -e "PG_DATABASE=$(db_of "$1")" migrate < /dev/null >> "${STEP_LOG}" 2>&1 || rc=$?
    if [ "${rc}" = 124 ] || { [ "${rc}" = 137 ] && [ $((SECONDS - t0)) -ge "${MIGRATE_TIMEOUT}" ]; }; then
        say "migrations on $(db_of "$1") timed out after ${MIGRATE_TIMEOUT}s and were stopped (MIGRATE_CMD='${MIGRATE_CMD}')"
    fi
    return "${rc}"
}

start_node() { # $1 name
    dc up -d --no-deps --pull never "node-$1" >> "${STEP_LOG}" 2>&1 || return 1
    refresh_cid "$1"
    wait_serve "$1" "${SERVE_TIMEOUT}"
}

# Counts of every public table plus the head, sorted "name|count" lines
STATS_SQL="${IN}/stats.sql"
cat > "${STATS_SQL}" << 'SQL'
SELECT 'max_block|' || coalesce(max(number)::text, 'none') FROM blocks;
SELECT format('SELECT %L || ''|'' || count(*) FROM %I', tablename, tablename)
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
\gexec
SQL
stats_of() { # $1 postgres name
    pgx "$1" psql -U demosuser -d "$(db_of "$1")" -tA -f - < "${STATS_SQL}" | sort
}
stat_of() { awk -F'|' -v k="$2" '$1 == k { print $2 }' "$1"; }
in_range() { is_num "$1" && is_num "$2" && is_num "$3" && [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; }

# The restored database against the counts taken before and after the dump.
# $1 label, $2 restored stats file. blocks and transactions only grow, so the
# restored count must sit between the two; fork_state and migrations must match.
check_restored_stats() {
    local label="$1" file="$2" t b a r bad="" detail
    for t in max_block blocks transactions; do
        b="$(stat_of "${BACKUP_DIR}/stats.before.txt" "${t}")"
        a="$(stat_of "${BACKUP_DIR}/stats.after.txt" "${t}")"
        r="$(stat_of "${file}" "${t}")"
        in_range "${r}" "${b}" "${a}" || bad="${bad} ${t}=${r:-?} not in [${b:-?},${a:-?}]"
    done
    for t in fork_state migrations; do
        a="$(stat_of "${BACKUP_DIR}/stats.after.txt" "${t}")"
        r="$(stat_of "${file}" "${t}")"
        if [ -z "${a}" ] || [ "${r}" != "${a}" ]; then bad="${bad} ${t}=${r:-?} != dump ${a:-?}"; fi
    done
    if [ "$(cut -d'|' -f1 "${BACKUP_DIR}/stats.after.txt" | tr '\n' ' ')" != "$(cut -d'|' -f1 "${file}" | tr '\n' ' ')" ]; then
        bad="${bad} table set differs from the dump's"
    fi
    detail="max_block $(stat_of "${file}" max_block) (dump window $(stat_of "${BACKUP_DIR}/stats.before.txt" max_block)..$(stat_of "${BACKUP_DIR}/stats.after.txt" max_block)), blocks $(stat_of "${file}" blocks), transactions $(stat_of "${file}" transactions)"
    if [ -z "${bad}" ]; then check "${label}: restored counts match the dump" PASS "${detail}"; else check "${label}: restored counts match the dump" FAIL "${bad}; ${detail}"; fi
}

# ── monitor: does the chain keep moving while node X is down? ───────────
MON_FILE="${LOG_DIR}/monitor.tsv"
start_monitor() { # nodes to watch
    : > "${MON_FILE}"
    (
        # not a holder of the project lock: a sleep left behind when it is killed must not keep it
        exec 9>&-
        set +e
        # The slowest and the furthest watched node's heads, empty (a missed read) when one
        # of them does not answer: one node that keeps rising alone must not pass for the
        # chain, nor one that catches up while the others make no new block
        while :; do
            printf '%s\t%s\n' "$(date +%s)" "$(span_head_of "$@")" >> "${MON_FILE}"
            sleep 5
        done
    ) &
    MON_PID=$!
}
# "maxgap first last samples unreadable blind top" between two unix times. first, last:
# the lowest heads of the window's first and last successful reads; top: the highest
# head of its first (a line without one, as before it was recorded, counts its lowest).
# maxgap: the longest time the lowest or the highest head was not seen to rise, from
# the window's start, measured up to the sample that sees it rise (before that sample
# becomes the new start) and, last, up to the window's end. blind: the longest time
# without a successful read, from the window's start, between reads, and up to its end
monitor_stats() {
    awk -F'\t' -v from="$1" -v to="$2" '
        BEGIN { last = from; lastread = from; lasthi = from }
        $1 >= from && $1 <= to {
            if ($2 ~ /^[0-9]+$/) {
                hi = ($3 ~ /^[0-9]+$/) ? $3 : $2
                if ($1 - lastread > blind) blind = $1 - lastread
                lastread = $1
                lasthead = $2
                if (!seen) { first = $2; best = $2; top = hi; besthi = hi; seen = 1 }
                else {
                    if ($2 > best) { if ($1 - last > maxgap) maxgap = $1 - last; best = $2; last = $1 }
                    if (hi > besthi) { if ($1 - lasthi > maxgap) maxgap = $1 - lasthi; besthi = hi; lasthi = $1 }
                }
                n++
            } else { unread++ }
        }
        END {
            if (to - last > maxgap) maxgap = to - last
            if (to - lasthi > maxgap) maxgap = to - lasthi
            if (to - lastread > blind) blind = to - lastread
            printf "%d %d %d %d %d %d %d", maxgap + 0, first + 0, lasthead + 0, n + 0, unread + 0, blind + 0, top + 0
        }' "${MON_FILE}"
}
# The verdict of the "kept forging" checks on the window [$1, $2]: STALL_RESULT (PASS
# or FAIL), STALL_DETAIL, and monitor_stats' numbers. No head read for longer than
# STALL_LIMIT is a FAIL, whatever the heads around the hole: the chain may have
# stalled in it, and the run cannot show it did not. A window whose lowest head at its
# last successful read is not above the highest at its first is a FAIL too, however
# short: then no watched validator is shown a block that none of them had at the
# start, only that they answered, or that a slow one caught up
stall_verdict() {
    read -r maxgap first last samples unread blind top <<< "$(monitor_stats "$1" "$2")"
    STALL_DETAIL="longest gap ${maxgap}s, longest without a head read ${blind}s (limit ${STALL_LIMIT}s), head ${first} -> ${last}, ${samples} samples, ${unread} unreadable, highest head at the first read ${top}"
    if [ "${blind}" -gt "${STALL_LIMIT}" ]; then
        STALL_RESULT=FAIL
        STALL_DETAIL="no head read for ${blind}s, more than ${STALL_LIMIT}s: a stall in that time cannot be ruled out; ${STALL_DETAIL}"
    elif [ "${last}" -le "${top}" ]; then
        STALL_RESULT=FAIL
        STALL_DETAIL="no new block on the watched validators between ${1} and ${2} (unix times, as in logs/monitor.tsv); ${STALL_DETAIL}"
    elif [ "${samples}" -gt 0 ] && [ "${maxgap}" -le "${STALL_LIMIT}" ] && [ "${unread}" -le $((samples / 2)) ]; then
        STALL_RESULT=PASS
    else
        STALL_RESULT=FAIL
    fi
}

# ═════════════════════════════════════════════════════════════════════════
# 1. preflight
# ═════════════════════════════════════════════════════════════════════════
step 01-preflight
say "variant=${VARIANT} fork_set=${FORK_SET} project=${PROJECT} node=${X_NODE} N=${N} shardSize=${SHARD_SIZE} q=${Q} base_port=${BASE_PORT} out=${OUT_DIR}"
META[run_dir]="${OUT_DIR}"
for tool in docker jq python3 awk sort vmstat free df nproc xargs timeout; do command -v "${tool}" > /dev/null 2>&1 || abort_pre "${tool} not found"; done
docker compose version >> "${STEP_LOG}" 2>&1 || abort_pre "docker compose (v2) is not available"
docker info > /dev/null 2>&1 || abort_pre "cannot talk to the docker daemon"

# Wait for a quiet host: the 1-minute load must be under LOAD_MAX (quorum-drills
# only aborts above the core count; this waits instead, up to LOAD_WAIT_MAX)
load_deadline=$((SECONDS + LOAD_WAIT_MAX))
while :; do
    load1="$(cut -d' ' -f1 /proc/loadavg)"
    if awk -v l="${load1}" -v m="${LOAD_MAX}" 'BEGIN { exit !(l < m) }'; then break; fi
    [ "${SECONDS}" -lt "${load_deadline}" ] || abort_pre "load ${load1} still >= ${LOAD_MAX} after ${LOAD_WAIT_MAX}s"
    say "waiting for the host: load1 ${load1} >= ${LOAD_MAX} ($((load_deadline - SECONDS))s left)"
    sleep "${LOAD_POLL}"
done
{
    df -h /
    free -m
    echo "nproc $(nproc)"
    uptime
    vmstat 1 5
} >> "${STEP_LOG}" 2>&1
disk_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
avail_mb="$(free -m | awk '/^Mem:/{print $7}')"
need_mb=$((N * NODE_EST_MB + N * 150 + 256 + HEADROOM_MB))
[ "${disk_gb:-0}" -ge "${MIN_DISK_GB}" ] || abort_pre "free disk ${disk_gb}G < ${MIN_DISK_GB}G"
[ "${avail_mb:-0}" -ge "${need_mb}" ] || abort_pre "available RAM ${avail_mb}M < ${need_mb}M for ${N} nodes"
swapping="$(vmstat 1 4 | tail -3 | awk '$7 + $8 > 0 {n++} END {print (n == 3) ? 1 : 0}')"
[ "${swapping}" = 0 ] || abort_pre "the host is actively swapping"
say "preflight: load ${load1}, disk ${disk_gb}G free, ${avail_mb}M RAM available (need ${need_mb}M)"

# Own project only: nothing of this name may exist, so down -v can only remove what this run made
# (the exact volume names the compose file declares are checked once it is generated, in 02-inputs)
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}")" ] || abort_pre "containers of project ${PROJECT} already exist"
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}")" ] || abort_pre "volumes of project ${PROJECT} already exist"
if command -v ss > /dev/null 2>&1; then
    for p in $(seq $((BASE_PORT + 1)) $((BASE_PORT + N + 1))); do
        if ss -Hltn "sport = :${p}" | grep -q .; then abort_pre "host port ${p} is in use"; fi
    done
else
    say "WARNING: ss not found, host ports not checked"
fi
# Images: both must be local, nothing is pulled or built
for img in "${NODE_IMAGE}" "${PG_IMAGE}"; do
    docker image inspect "${img}" > /dev/null 2>&1 || abort_pre "image ${img} is not present locally (this drill never pulls or builds)"
done
NODE_IMAGE_ID="$(docker image inspect "${NODE_IMAGE}" --format '{{.Id}}')"
PG_IMAGE_ID="$(docker image inspect "${PG_IMAGE}" --format '{{.Id}}')"
META[node_image_id]="${NODE_IMAGE_ID:7:12}"
META[pg_image_id]="${PG_IMAGE_ID:7:12}"
say "images: node ${NODE_IMAGE} (${NODE_IMAGE_ID:7:12}), postgres ${PG_IMAGE} (${PG_IMAGE_ID:7:12}); no other image is used"
# A failed count, or a count of none (grep -c then exits 1), is "unreadable": the schema check fails on it
MIGRATION_FILES="$(docker run --rm --entrypoint sh "${NODE_IMAGE}" -c 'ls src/migrations | grep -cE "[.](ts|js)$"')" || MIGRATION_FILES=unreadable
META[migration_files_in_image]="${MIGRATION_FILES}"
say "migration files in the node image: ${MIGRATION_FILES}"
if [ "${EXPECT_PAUSE}" = 1 ]; then
    say "NOTE: ${LIVE_OTHERS} live validators < q=${Q}: the chain is EXPECTED to pause while node ${X_NODE} is down"
fi

# ═════════════════════════════════════════════════════════════════════════
# 2. inputs
# ═════════════════════════════════════════════════════════════════════════
step 02-inputs
GENESIS_TS=$(($(date -u +%s) + GENESIS_DELAY))
gen_identity() {
    local mode="${IDENTITY_GEN}"
    if [ "${mode}" = auto ]; then
        if command -v bun > /dev/null 2>&1 && [ -d "${REPO_ROOT}/node_modules" ]; then mode=host; else mode=image; fi
    fi
    if [ "${mode}" = host ]; then
        (cd "${REPO_ROOT}" && bun testing/devnet/scripts/generate-identity-helper.ts)
    else
        # Same helper, run in the node image (its node_modules); copied under inputs/
        # and made readable for the image user
        cp "${REPO_ROOT}/testing/devnet/scripts/generate-identity-helper.ts" "${IN}/gen-identity.ts"
        chmod 644 "${IN}/gen-identity.ts"
        docker run --rm --entrypoint bun -v "${IN}/gen-identity.ts:/app/.gen-identity.ts:ro" "${NODE_IMAGE}" /app/.gen-identity.ts
    fi
}
make_inputs() { # explicit returns: set -e does not apply inside a function used in a || list
    local i out
    for i in $(seq 1 "${N}"); do
        out="$(gen_identity)" || return 1
        echo "${out}" | grep '^MNEMONIC:' | cut -d: -f2- | tr -d '\n' > "${IN}/node${i}.identity" || return 1
        echo "${out}" | grep '^PUBKEY:' | cut -d: -f2- | tr -d '\n' > "${IN}/pub${i}" || return 1
    done
    out=""
    # Genesis, peerlist and the fork schedule (FORK_SET) exactly as the quorum drills make them
    python3 "${REPO_ROOT}/testing/devnet/quorum-drills/gen-inputs.py" --run-dir "${OUT_DIR}" --repo "${REPO_ROOT}" \
        --nodes "${N}" --shard-size "${SHARD_SIZE}" --binding on --fork-set "${FORK_SET}" --genesis-ts "${GENESIS_TS}" \
        --image "${NODE_IMAGE}" --node-mem "${NODE_MEM}" --consensus-time "${CONSENSUS_TIME}" || return 1
    rm -rf "${IN}/pg-init"
    cp -R "${REPO_ROOT}/testing/devnet/l2ps" "${IN}/l2ps" || return 1
    # Overwrites the compose.yml gen-inputs.py wrote (tmpfs state, one shared postgres)
    python3 "${HERE}/gen-compose.py" --run-dir "${OUT_DIR}" --nodes "${N}" --image "${NODE_IMAGE}" --pg-image "${PG_IMAGE}" \
        --node-mem "${NODE_MEM}" --pg-mem "${PG_MEM}" --consensus-time "${CONSENSUS_TIME}" --base-port "${BASE_PORT}" \
        --cpu-shares "${CPU_SHARES}" --x-node "${X_NODE}" --migrate-cmd "${MIGRATE_CMD}" || return 1
}
make_inputs >> "${STEP_LOG}" 2>&1 || abort_pre "generating inputs failed (see 02-inputs.log)"
for i in $(seq 1 "${N}"); do PUB[${i}]="$(tr '[:upper:]' '[:lower:]' < "${IN}/pub${i}")"; done
# The forks as they are in the genesis the nodes get, and for "launch" the ones left out
FORKS="$(jq -r '[.forks | to_entries[] | "\(.key)@\(.value.activationHeight)"] | join(", ")' "${IN}/genesis.json")" \
    || abort_pre "cannot read the forks of ${IN}/genesis.json"
META[forks]="${FORKS}"
excluded_note=""
if [ "${FORK_SET}" = launch ]; then
    META[forks_excluded]="$(jq -r 'to_entries | map("\(.key) (\(.value))") | join(", ") | if . == "" then "none" else . end' "${IN}/launch-excluded.json")" \
        || abort_pre "no excluded-forks list in ${IN}/launch-excluded.json"
    excluded_note="; excluded: ${META[forks_excluded]}"
fi
say "forks (${FORK_SET}): ${FORKS}${excluded_note}"

# host3 runs with umask 0077 and the release image runs as uid 1000: everything a
# container reads from the 700 run dir has to be readable by that uid, whoever
# owns the file. The identities are throwaway devnet keys; the run dir keeps them
# private, and teardown deletes them (KEEP_KEYS=1 keeps them).
find "${IN}" -type d -exec chmod 755 {} +
find "${IN}" -type f -exec chmod 644 {} +
mounts=()
paths=()
for i in $(seq 1 "${N}"); do
    mounts+=(-v "${IN}/node${i}.identity:/in/node${i}.identity:ro")
    paths+=("/in/node${i}.identity")
done
mounts+=(-v "${IN}/peerlist.json:/in/peerlist.json:ro" -v "${IN}/genesis.json:/in/genesis.json:ro"
    -v "${IN}/empty-snapshot:/in/empty-snapshot:ro" -v "${IN}/l2ps:/in/l2ps:ro")
paths+=(/in/peerlist.json /in/genesis.json /in/empty-snapshot /in/l2ps)
say "checking the image user (uid 1000) can read the mounted inputs"
if ! docker run --rm --user 1000 --entrypoint sh "${mounts[@]}" "${NODE_IMAGE}" -c '
    rc=0
    for p in "$@"; do
        if [ -d "$p" ]; then
            { test -r "$p" && test -x "$p" && ls "$p" > /dev/null; } || { echo "uid 1000 cannot read directory $p"; rc=1; }
            for f in $(find "$p" -type f 2> /dev/null); do test -r "$f" || { echo "uid 1000 cannot read $f"; rc=1; }; done
        else
            test -r "$p" || { echo "uid 1000 cannot read $p"; rc=1; }
        fi
    done
    exit $rc' sh "${paths[@]}" >> "${STEP_LOG}" 2>&1; then
    tail -n 8 "${STEP_LOG}" >&2
    abort_pre "the image user (uid 1000) cannot read the mounted inputs under ${IN} (see 02-inputs.log); check umask and the chmod of the run dir"
fi
dc config -q >> "${STEP_LOG}" 2>&1 || abort_pre "the generated compose file is not valid (see 02-inputs.log)"
# Compose uses a volume that already has the name of one it declares, labelled or
# not, and teardown's down -v deletes it: no such name may exist before the first up
decl_vols="$(jq -r --arg p "${PROJECT}" '(.volumes // {}) | to_entries[] | .value.name // "\($p)_\(.key)"' "${OUT_DIR}/compose.yml")" \
    || abort_pre "cannot read the volumes of ${OUT_DIR}/compose.yml"
[ -n "${decl_vols}" ] || abort_pre "no named volume in the generated compose file"
all_vols="$(docker volume ls -q)" || abort_pre "cannot list the docker volumes"
taken=""
while IFS= read -r v; do
    if grep -Fxq -- "${v}" <<< "${all_vols}"; then taken+="${v} "; fi
done <<< "${decl_vols}"
[ -z "${taken}" ] || abort_pre "volumes with the names the compose file declares already exist: ${taken% }. This run would use them and its teardown would delete them; no container or volume was created. Use another PROJECT, or find out what they hold before removing them"
say "inputs ready, genesis in ${GENESIS_DELAY}s"

# ═════════════════════════════════════════════════════════════════════════
# 2b. what the nodes need before anything timed starts: gossip, writable state
# ═════════════════════════════════════════════════════════════════════════
step 02b-node-checks

# Gossip. A validator with gossip off never catches up after a restart (it says
# "already synced" while behind), which would wreck the restore timings. What
# counts is what the generated compose file gives each node.
node_services="$(jq -r '.services | keys[] | select(startswith("node-"))' "${OUT_DIR}/compose.yml")" || abort_pre "cannot read ${OUT_DIR}/compose.yml"
[ -n "${node_services}" ] || abort_pre "no node service in the generated compose file"
gossip_off="$(jq -r '.services | to_entries[] | select(.key | startswith("node-")) | select((.value.environment.GOSSIP_ENABLED // "unset") != "true") | "\(.key)=\(.value.environment.GOSSIP_ENABLED // "unset")"' "${OUT_DIR}/compose.yml" | tr '\n' ' ')" \
    || abort_pre "cannot read ${OUT_DIR}/compose.yml"
if [ -z "${gossip_off}" ]; then
    # The sidecar is spawned as `node` from the same login shell the nodes start in
    docker run --rm --network none --entrypoint bash "${NODE_IMAGE}" -lc 'command -v node' >> "${STEP_LOG}" 2>&1 \
        || abort_pre "gossip is on but ${NODE_IMAGE} has no \`node\` on the PATH of a login shell: the gossip sidecar needs Node >= 20 (see 02b-node-checks.log)"
    META[gossip]="enabled on every node"
    check "gossip enabled on every node" PASS "GOSSIP_ENABLED=true in the compose file; node found in the image"
elif [ "${ALLOW_GOSSIP_OFF}" = 1 ]; then
    say "WARNING: gossip is not enabled (${gossip_off}) and ALLOW_GOSSIP_OFF=1: going on. A node with gossip off does not catch up after a restart, so the rejoin and restore timings mean nothing"
    META[gossip]="OFF (${gossip_off}), ALLOW_GOSSIP_OFF=1"
    check "gossip enabled on every node" INFO "OFF on purpose (ALLOW_GOSSIP_OFF=1): ${gossip_off}"
else
    abort_pre "gossip is not enabled on every node (${gossip_off}). A validator with gossip off never catches up after a restart (it says 'already synced' while behind), so the timings would be wrong. Unset GOSSIP_ENABLED (the default is true); for a deliberate negative run set GOSSIP_ENABLED=false ALLOW_GOSSIP_OFF=1"
fi

# State writability. The image user is uid 1000: a named volume or tmpfs the node
# writes to has to be writable by it, else the node dies with `cp: cannot create
# ... Permission denied`. Volumes are created by compose (up --no-start), so they
# carry the compose labels and the project's teardown removes them; each one is then
# probed as uid 1000 at the very path the node gets it (a new volume takes the
# owner of that directory in the image).
NODE_SVCS=()
for i in $(seq 1 "${N}"); do NODE_SVCS+=("node-${i}"); done
if [ "${VARIANT}" = isolated ] && [ "${ISO_NODE}" = 1 ] && [ "${SMOKE}" != 1 ]; then NODE_SVCS+=(node-iso); fi
STARTED_STACK=1
dc up --no-start --pull never "${NODE_SVCS[@]}" >> "${STEP_LOG}" 2>&1 || abort_pre "could not create the containers and volumes (see 02b-node-checks.log)"

probe_write() { # $1 path in the container, rest: docker run options mounting it; can uid 1000 create and delete a file there?
    local p="$1"
    shift
    docker run --rm --user 1000 --network none --label "demos.drill.helper=${PROJECT}" "$@" --entrypoint sh "${NODE_IMAGE}" \
        -c 'touch "$1/.w" && rm -f "$1/.w"' sh "${p}" < /dev/null
}
# Only a volume of this compose project is ever touched, and only with FIX_OWNERSHIP=1
fix_owner() { # $1 full volume name
    local owner
    owner="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$1" 2> /dev/null)" || return 1
    [ "${owner}" = "${PROJECT}" ] || return 1
    say "FIX_OWNERSHIP=1: chown -R 1000:1000 on volume $1"
    helper 'chown -R 1000:1000 /x' -v "$1:/x" "${PG_IMAGE}" >> "${STEP_LOG}" 2>&1
}
# "kind  source  path  service": named volumes mounted read-write and tmpfs of the node services
jq -r --argjson svcs "$(printf '%s\n' "${NODE_SVCS[@]}" | jq -Rn '[inputs]')" '
    .services | to_entries[] | select(.key as $k | $svcs | index($k)) | .key as $svc | .value
    | ((.volumes // [])[] | select(type == "string") | split(":")
        | select((.[0] | test("^[A-Za-z0-9][A-Za-z0-9_.-]*$")) and ((.[2] // "") | split(",") | index("ro") | not))
        | "vol\t\(.[0])\t\(.[1])\t\($svc)"),
      ((.tmpfs // [])[] | "tmpfs\t\(.)\t\(split(":")[0])\t\($svc)")' "${OUT_DIR}/compose.yml" | sort -u > "${OUT_DIR}/writable-mounts.tsv" \
    || abort_pre "cannot list the node mounts from the compose file"
[ -s "${OUT_DIR}/writable-mounts.tsv" ] || abort_pre "no read-write volume or tmpfs of a node service in the compose file to probe"
unwritable=()
fixed=()
mounted_paths=" "
while IFS=$'\t' read -r kind src path svc; do
    mounted_paths="${mounted_paths}${path} "
    if [ "${kind}" = vol ]; then
        full="$(vol "${src}")"
        what="volume ${full} at ${path} (${svc})"
        opts=(-v "${full}:${path}")
    else
        full=""
        what="tmpfs ${src} (${svc})"
        opts=(--tmpfs "${src}")
    fi
    if probe_write "${path}" "${opts[@]}" >> "${STEP_LOG}" 2>&1; then
        say "uid 1000 can write: ${what}"
    elif [ "${kind}" = vol ] && [ "${FIX_OWNERSHIP}" = 1 ] && fix_owner "${full}" && probe_write "${path}" "${opts[@]}" >> "${STEP_LOG}" 2>&1; then
        say "uid 1000 can write after the chown: ${what}"
        fixed+=("${full}")
    else
        say "uid 1000 CANNOT write: ${what}"
        unwritable+=("${what}")
    fi
done < "${OUT_DIR}/writable-mounts.tsv"
# What the image itself declares as volumes, and its working directory (the node
# writes there too: gossip key, logs): not mounted by compose, docker makes them
img_dirs="$({
    docker image inspect "${NODE_IMAGE}" --format '{{json .Config.Volumes}}' | jq -r '(. // {}) | keys[]'
    docker image inspect "${NODE_IMAGE}" --format '{{.Config.WorkingDir}}'
} | grep . | sort -u)" || abort_pre "cannot read the declared volumes and the working directory of ${NODE_IMAGE} to probe them"
for d in ${img_dirs}; do
    case "${mounted_paths}" in *" ${d} "*) continue ;; esac
    if probe_write "${d}" >> "${STEP_LOG}" 2>&1; then
        say "uid 1000 can write: ${d} (from the image)"
    else
        say "uid 1000 CANNOT write: ${d} (from the image)"
        unwritable+=("${d} in the image (not a mount of this compose file: it is the image's own directory or declared volume)")
    fi
done
if [ "${#unwritable[@]}" -gt 0 ]; then
    tail -n 6 "${STEP_LOG}" >&2
    abort_pre "the node image user (uid 1000) cannot write to: $(printf '%s; ' "${unwritable[@]}")the node would fail with 'Permission denied' as soon as it writes its state. Nothing was changed. Set FIX_OWNERSHIP=1 to chown 1000:1000 this drill's own volumes (${PROJECT}_*), or fix the owner of the directory in the image (see 02b-node-checks.log)"
fi
if [ "${#fixed[@]}" -gt 0 ]; then META[ownership_fixed]="${fixed[*]} (FIX_OWNERSHIP=1)"; fi
check "node state is writable by uid 1000" PASS "$(wc -l < "${OUT_DIR}/writable-mounts.tsv") mounts and the image's own directories probed${fixed[0]:+; chowned: ${fixed[*]}}"

# ═════════════════════════════════════════════════════════════════════════
# SMOKE=1: the startup check, then out
# ═════════════════════════════════════════════════════════════════════════
if [ "${SMOKE}" = 1 ]; then
    step 03-smoke
    META[mode]="SMOKE=1 (startup check only)"
    phase_begin
    dc up -d --pull never pg-1 pg-2 pg-3 pg-4 >> "${STEP_LOG}" 2>&1 || die "postgres did not start"
    for i in $(seq 1 "${N}"); do wait_pg "${i}" 120 || die "pg-${i} not ready within 120s"; done
    for i in $(seq 1 "${N}"); do
        run_migrations "${i}" || say "WARNING: migrations on node ${i}'s database failed (see 03-smoke.log); continuing"
    done
    # The cap counts from the first node start. Nodes start one at a time (a
    # simultaneous join races the committee freeze); a node that does not serve
    # in time is recorded and the rest still start
    smoke_deadline=$((SECONDS + SMOKE_TIMEOUT))
    declare -A SMOKE_WHY=() SMOKE_HEADS=()
    for i in $(seq 1 "${N}"); do
        if dc up -d --no-deps --pull never "node-${i}" >> "${STEP_LOG}" 2>&1; then
            refresh_cid "${i}"
        else
            SMOKE_WHY[${i}]="docker compose up failed"
            continue
        fi
        if [ "${i}" -lt "${N}" ]; then sleep 4; fi
    done
    say "waiting up to ${SMOKE_TIMEOUT}s for every node to serve RPC at head >= ${SMOKE_HEAD}"
    while :; do
        all=1
        for i in $(seq 1 "${N}"); do
            [ -z "${SMOKE_WHY[${i}]:-}" ] || continue
            h="$(head_of "${i}")" || h=unreadable
            if is_num "${h}"; then SMOKE_HEADS[${i}]="${h}"; else SMOKE_HEADS[${i}]=""; fi
            if ! is_num "${h}" || [ "${h}" -lt "${SMOKE_HEAD}" ]; then all=0; fi
        done
        if [ "${all}" = 1 ] && [ "${#SMOKE_WHY[@]}" = 0 ]; then break; fi
        if [ "${SECONDS}" -ge "${smoke_deadline}" ]; then break; fi
        sleep 3
    done
    if [ "${all}" = 1 ] && [ "${#SMOKE_WHY[@]}" = 0 ]; then
        phase_end S "smoke: up to every node serving at head >= ${SMOKE_HEAD}"
    else
        phase_end S "smoke: waited for every node serving at head >= ${SMOKE_HEAD}, not all got there"
    fi
    smoke_ok=1
    for i in $(seq 1 "${N}"); do
        if [ -n "${SMOKE_WHY[${i}]:-}" ]; then why="${SMOKE_WHY[${i}]}"
        elif serving "${i}" && [ -n "${SMOKE_HEADS[${i}]:-}" ] && [ "${SMOKE_HEADS[${i}]}" -ge "${SMOKE_HEAD}" ]; then why=""
        elif serving "${i}"; then why="serves RPC but head ${SMOKE_HEADS[${i}]:-unreadable} < ${SMOKE_HEAD}"
        else why="does not serve RPC"; fi
        if [ -z "${why}" ]; then
            check "smoke: node ${i} serves RPC at head >= ${SMOKE_HEAD}" PASS "head ${SMOKE_HEADS[${i}]}"
        else
            smoke_ok=0
            check "smoke: node ${i} serves RPC at head >= ${SMOKE_HEAD}" FAIL "${why}; log: ${LOG_DIR}/node-${i}.log (written at teardown), live: docker compose -p ${PROJECT} -f ${OUT_DIR}/compose.yml logs node-${i}"
            say "last lines of node-${i}:"
            { docker logs --tail 15 "${CID[${i}]:-none}" 2>&1 || true; } | sed 's/\x1b\[[0-9;]*m//g; s/^/    /' | tee -a "${STEP_LOG}"
        fi
    done
    if [ "${smoke_ok}" = 1 ]; then RESULT=PASS; else RESULT=FAIL; fi
    write_report
    say "SMOKE ${RESULT}: $(awk -F'\t' '$1 == "S" { print $3 }' "${PHASES}")s; tearing down, reports in ${OUT_DIR}/timings.md"
    if [ "${RESULT}" = PASS ]; then exit 0; fi
    exit 1
fi

# ═════════════════════════════════════════════════════════════════════════
# 3. bring-up
# ═════════════════════════════════════════════════════════════════════════
step 03-bringup
STARTED_STACK=1
dc up -d --pull never pg-1 pg-2 pg-3 pg-4 >> "${STEP_LOG}" 2>&1 || die "postgres did not start"
for i in $(seq 1 "${N}"); do wait_pg "${i}" 120 || die "pg-${i} not ready within 120s"; done
for i in $(seq 1 "${N}"); do
    # The manual step. Only a run-devnet image migrates at start, so a failure here is a
    # warning; a release node never migrates at boot and will fail the serve wait below
    run_migrations "${i}" || say "WARNING: migrations on node ${i}'s database failed (see 03-bringup.log); continuing"
done
for i in $(seq 1 "${N}"); do
    start_node "${i}" || die "node-${i} did not serve within ${SERVE_TIMEOUT}s (see node logs; with migrationsRun false the migrations above must have worked)"
    say "node-${i} serving"
    # One node at a time: a simultaneous join races the committee freeze
    if [ "${i}" -lt "${N}" ]; then sleep 4; fi
done

step 04-reach-height
say "waiting for every node at height >= ${H0}"
deadline=$((SECONDS + BRINGUP_TIMEOUT))
while :; do
    m="$(min_head_of "${ALL_NODES[@]}")"
    if is_num "${m}" && [ "${m}" -ge "${H0}" ]; then break; fi
    [ "${SECONDS}" -lt "${deadline}" ] || die "the nodes did not all reach height ${H0} within ${BRINGUP_TIMEOUT}s (min head '${m}')"
    sleep 5
done
H_REC="$(read_head "${X_NODE}")" || die "node ${X_NODE} does not answer its head"
HASH_REC="$(hash_at "${X_NODE}" "${H_REC}")" || die "node ${X_NODE} has no hash at its head ${H_REC}"
state_sums > "${OUT_DIR}/sums.step2" || die "cannot hash node ${X_NODE}'s identity and signing state files"
# For the record only (the checks compare the files at stop and after the rejoin)
H_SIGNED_2="$(record_pos signed)" || H_SIGNED_2=none
IDENT_SUM_2="$(sum_of "${OUT_DIR}/sums.step2" node.identity)"
sha_ok "${IDENT_SUM_2}" || die "no identity file hashed in node ${X_NODE}'s state volume"
META[head_recorded]="${H_REC}"
META[hash_recorded]="${HASH_REC}"
META[signing_record_height_step2]="${H_SIGNED_2%% *}"
META[state_files_step2]="$(awk '{ printf "%s ", $2 }' "${OUT_DIR}/sums.step2")"
say "step 2: node ${X_NODE} head ${H_REC} hash ${HASH_REC:0:16}..; identity sha ${IDENT_SUM_2:0:12}..; signing record height ${H_SIGNED_2%% *}; state files: $(awk '{ printf "%s ", $2 }' "${OUT_DIR}/sums.step2")"
T_DRILL_START="$(date +%s)"
if [ "${VARIANT}" = rejoin ]; then start_monitor "${OTHERS[@]}"; else start_monitor "${ALL_NODES[@]}"; fi

# ═════════════════════════════════════════════════════════════════════════
# 5. phase A: backup (node X keeps running)
# ═════════════════════════════════════════════════════════════════════════
step 05-backup
phase_begin
psql_q "${X_NODE}" 'select 1' > /dev/null || die "cannot query pg-${X_NODE}"
stats_of "${X_NODE}" > "${BACKUP_DIR}/stats.before.txt"
DUMP_NAME="node${X_NODE}.dump"
pgx "${X_NODE}" sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Fc -f /backup/${DUMP_NAME}" >> "${STEP_LOG}" 2>&1 || die "pg_dump failed"
stats_of "${X_NODE}" > "${BACKUP_DIR}/stats.after.txt"
# The dump has to be not empty and readable to its end before it counts as a backup,
# and before the wipe. pg_restore --list reads only the table of contents, so a dump
# cut short after it would pass (docs/runbooks/database-migrations.md, step 1)
pgx "${X_NODE}" sh -c "cd /backup && test -s ${DUMP_NAME} && pg_restore --file=/dev/null ${DUMP_NAME} && sha256sum ${DUMP_NAME} > ${DUMP_NAME}.sha256" >> "${STEP_LOG}" 2>&1 \
    || die "the dump is empty or cannot be read to its end (test -s or pg_restore --file=/dev/null failed)"
DUMP_BYTES="$(pgx "${X_NODE}" stat -c %s "/backup/${DUMP_NAME}")"
# The database only: the identity and signing state stay on node X's state
# volume and are not copied (a copy taken while the node runs is not a valid
# signing-state backup)
phase_end A "backup: pg_dump -Fc + verify"
META[dump_bytes]="${DUMP_BYTES}"
H_DUMP_BEFORE="$(stat_of "${BACKUP_DIR}/stats.before.txt" max_block)"
H_DUMP_AFTER="$(stat_of "${BACKUP_DIR}/stats.after.txt" max_block)"
META[dump_head_window]="${H_DUMP_BEFORE}..${H_DUMP_AFTER}"
say "dump ${DUMP_BYTES} bytes, head window ${H_DUMP_BEFORE}..${H_DUMP_AFTER}"

# Copy off the node's volume to the host (models "copied off the host")
phase_begin
XPG_CID="$(dc ps -q "pg-${X_NODE}")"
docker cp "${XPG_CID}:/backup/." "${BACKUP_DIR}/" >> "${STEP_LOG}" 2>&1 || die "copying the dump to the host failed"
chmod -R go-rwx "${BACKUP_DIR}"
(cd "${BACKUP_DIR}" && sha256sum -c "${DUMP_NAME}.sha256") >> "${STEP_LOG}" 2>&1 || die "the copy on the host does not match its sha256"
DUMP_FILE="${BACKUP_DIR}/${DUMP_NAME}"
phase_end A2 "copy the dump to the host dir + sha256 check"

# ═════════════════════════════════════════════════════════════════════════
if [ "${VARIANT}" = rejoin ]; then
    # ═════════════════════════════════════════════════════════════════════
    # 6. phase B: wipe node X, keep identity and signing state
    # ═════════════════════════════════════════════════════════════════════
    step 06-wipe
    T_B0="$(now)"
    T_STOP="$(date +%s)"
    phase_begin
    say "stopping node-${X_NODE} (grace ${STOP_GRACE}s); chain head on the others: $(max_head_of "${OTHERS[@]}")"
    dc stop -t "${STOP_GRACE}" "node-${X_NODE}" >> "${STEP_LOG}" 2>&1 || die "could not stop node-${X_NODE}"
    XNODE_CID="${CID[${X_NODE}]}"
    say "node-${X_NODE} exit code $(docker inspect -f '{{.State.ExitCode}}' "${XNODE_CID}" 2>/dev/null || echo '?') (137 means it ignored SIGTERM and was killed after the grace period)"
    docker logs "${XNODE_CID}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${LOG_DIR}/node-${X_NODE}.pre-wipe.log"
    # Node stopped, database still up: the true pre-wipe head, and the signing state at rest
    H_STOP="$(psql_q "${X_NODE}" 'SELECT max(number) FROM blocks')" && is_num "${H_STOP}" || die "cannot read node ${X_NODE}'s head from its database"
    HASH_STOP="$(psql_q "${X_NODE}" "SELECT hash FROM blocks WHERE number = ${H_STOP}")" && [ -n "${HASH_STOP}" ] || die "cannot read node ${X_NODE}'s block hash at ${H_STOP} from its database"
    # The baseline of the wipe's comparison and of the checks: every file hashed, the identity among them
    state_sums > "${OUT_DIR}/sums.stop" || die "cannot hash node ${X_NODE}'s identity and signing state files at stop"
    sha_ok "$(sum_of "${OUT_DIR}/sums.stop" node.identity)" || die "no identity file hashed in node ${X_NODE}'s state volume at stop"
    own_read=ok
    state_owners > "${OUT_DIR}/own.before" || own_read="failed at stop"
    # Height and round of each signing state file at rest; the files after the rejoin are compared with these
    declare -A POS_STOP=() POS_END=()
    for rec in signed commitlock prevote; do POS_STOP[${rec}]="$(record_pos "${rec}")" || POS_STOP[${rec}]=unreadable; done
    H_SIGNED_STOP="${POS_STOP[signed]%% *}"
    META[head_at_stop]="${H_STOP}"
    META[signing_record_height_at_stop]="${H_SIGNED_STOP}"
    say "stopped: pre-wipe head ${H_STOP}; signing record height ${H_SIGNED_STOP}"
    # Remove node X's containers (and their anonymous volumes), its database and its backup staging.
    # The state volume stays; only what is not identity or signing state leaves it.
    dc rm -f -v "node-${X_NODE}" >> "${STEP_LOG}" 2>&1 || die "could not remove node-${X_NODE}"
    CID[${X_NODE}]=""
    dc stop "pg-${X_NODE}" >> "${STEP_LOG}" 2>&1 || die "could not stop pg-${X_NODE}"
    dc rm -f -v "pg-${X_NODE}" >> "${STEP_LOG}" 2>&1 || die "could not remove pg-${X_NODE}"
    docker volume rm "$(vol "pgdata-${X_NODE}")" "$(vol "backup-${X_NODE}")" >> "${STEP_LOG}" 2>&1 || die "could not remove the database volumes"
    # node.identity* is this drill's IDENTITY_FILE (gen-compose.py), not the file
    # names on a validator's state volume (.demos_identity*): drill volumes only
    helper 'cd /s && find . -mindepth 1 -maxdepth 1 ! -name "node.identity*" -exec rm -rf {} +' \
        -v "$(vol "state-${X_NODE}"):/s" "${PG_IMAGE}" >> "${STEP_LOG}" 2>&1 || die "could not clear the non-identity state (see 06-wipe.log)"
    # Whatever the exit status said, only node.identity* may be left before node X starts again
    left="$(xstate_ro 'ls -A /s')" || die "cannot list node ${X_NODE}'s state volume after the wipe"
    say "left on the state volume: $(printf '%s' "${left}" | tr '\n' ' ')"
    stray="$(printf '%s\n' "${left}" | awk '!/^node\.identity/ && NF { printf "%s ", $0 }')"
    [ -z "${stray}" ] || die "the wipe left more than node.identity* on node ${X_NODE}'s state volume: ${stray% }"
    # Node X restarts from the identity and signing state files it stopped with: the
    # same names and bytes as at stop, checked before it can start again
    state_sums > "${OUT_DIR}/sums.wiped" || die "cannot hash node ${X_NODE}'s identity and signing state files after the wipe"
    # The lines in one list only: a file changed, added or removed
    wipe_changed="$(sort "${OUT_DIR}/sums.stop" "${OUT_DIR}/sums.wiped" | uniq -u | awk '{ print $2 }' | sort -u | tr '\n' ' ')"
    [ -z "${wipe_changed}" ] || die "the wipe changed or removed node ${X_NODE}'s identity or signing state files: ${wipe_changed% } (sums.stop, sums.wiped)"
    # The state volume is kept and only emptied (as root, rm only: nothing is created on
    # it), so its owner must be what it was. The volumes recreated below, the database
    # and the backup staging one, belong to postgres, not to uid 1000. Whatever the
    # restarted node writes to /app/state has to work as uid 1000, so prove that now.
    state_owners > "${OUT_DIR}/own.after" || own_read="failed after the wipe"
    own_changed="$(sort "${OUT_DIR}/own.before" "${OUT_DIR}/own.after" | uniq -u | tr '\n' ';')"
    if [ "${own_read}" = ok ] && [ -z "${own_changed}" ] && grep -q ' \.$' "${OUT_DIR}/own.after" && grep -q ' node\.identity$' "${OUT_DIR}/own.after"; then
        check "the wipe kept the ownership of the state volume" PASS "owner and mode of the state dir and the identity files unchanged ($(grep ' \.$' "${OUT_DIR}/own.after" | cut -d' ' -f1,2))"
    else
        check "the wipe kept the ownership of the state volume" FAIL "changed or missing: ${own_changed:-no state dir or identity file line}; reading the owners ${own_read}"
    fi
    x_opts=(-v "$(vol "state-${X_NODE}"):/app/state")
    if ! probe_write /app/state "${x_opts[@]}" >> "${STEP_LOG}" 2>&1; then
        if [ "${FIX_OWNERSHIP}" = 1 ] && fix_owner "$(vol "state-${X_NODE}")" && probe_write /app/state "${x_opts[@]}" >> "${STEP_LOG}" 2>&1; then
            say "FIX_OWNERSHIP=1: node ${X_NODE}'s state volume was chowned back to 1000:1000"
        else
            die "after the wipe uid 1000 cannot write node ${X_NODE}'s state volume ($(vol "state-${X_NODE}")); the restarted node would fail with 'Permission denied' (see 06-wipe.log)"
        fi
    fi
    assert_x_not_running
    phase_end B "wipe: stop node, remove its database volume and non-identity state, keep identity + signing state"

    # ═════════════════════════════════════════════════════════════════════
    # 7. phase C: restore
    # ═════════════════════════════════════════════════════════════════════
    step 07-restore
    phase_begin
    assert_x_not_running
    (cd "${BACKUP_DIR}" && sha256sum -c "${DUMP_NAME}.sha256") >> "${STEP_LOG}" 2>&1 || die "the dump on the host fails its sha256 before restore"
    dc up -d --no-deps --pull never "pg-${X_NODE}" >> "${STEP_LOG}" 2>&1 || die "pg-${X_NODE} did not start"
    wait_pg "${X_NODE}" 120 || die "pg-${X_NODE} not ready within 120s"
    tables="$(psql_q "${X_NODE}" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
    [ "${tables}" = 0 ] || die "the new database is not empty (${tables} tables): the wipe did not work"
    # The whole dump into an empty database (docs/runbooks/database-migrations.md, "Roll back")
    pgx "${X_NODE}" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "${DUMP_FILE}" >> "${STEP_LOG}" 2>&1 \
        || die "pg_restore failed"
    stats_of "${X_NODE}" > "${OUT_DIR}/stats.restored.txt"
    if run_migrations "${X_NODE}"; then
        MIGRATED=1
    else
        MIGRATED=0
        tail -n 15 "${STEP_LOG}" | sed 's/^/    /' >&2
        if [ "${MIGRATE_REQUIRED}" = 1 ]; then die "migrations failed on the restored database (MIGRATE_CMD='${MIGRATE_CMD}'; see 07-restore.log)"; fi
        say "WARNING: migrations failed, continuing (MIGRATE_REQUIRED=0)"
    fi
    stats_of "${X_NODE}" > "${OUT_DIR}/stats.migrated.txt"
    # The restored database against the dump, and the schema against the image: checked
    # here, where they are read
    check_restored_stats "restore" "${OUT_DIR}/stats.restored.txt"
    mig_rows="$(stat_of "${OUT_DIR}/stats.migrated.txt" migrations)"
    if is_num "${MIGRATION_FILES}" && [ "${MIGRATION_FILES}" -gt 0 ] && [ "${mig_rows}" = "${MIGRATION_FILES}" ]; then
        check "schema at the image's head after the manual migration" PASS "migrations table ${mig_rows} rows = ${MIGRATION_FILES} files in src/migrations"
    else
        check "schema at the image's head after the manual migration" FAIL "migrations table ${mig_rows:-none} rows vs ${MIGRATION_FILES} files in the image (migrated=${MIGRATED})"
    fi
    # One instance only: the node is removed, no other container holds its volume
    assert_x_not_running
    T_X_START="$(date +%s)"
    dc up -d --no-deps --pull never "node-${X_NODE}" >> "${STEP_LOG}" 2>&1 || die "node-${X_NODE} did not start"
    refresh_cid "${X_NODE}"
    assert_single_x
    check "one instance of the key at a time" PASS "node ${X_NODE} was removed and its volume had no holder before the single start (asserted)"
    wait_serve "${X_NODE}" "${SERVE_TIMEOUT}" || die "restored node-${X_NODE} did not serve within ${SERVE_TIMEOUT}s (see node-${X_NODE}.log)"
    phase_end C "restore: start postgres, pg_restore, migrations, start node (until it serves)"
    T_C_END="$(now)"

    # ═════════════════════════════════════════════════════════════════════
    # 8. phase D: rejoin
    # ═════════════════════════════════════════════════════════════════════
    step 08-rejoin
    PH_T0="${T_C_END}"
    # Rejoined: within 2 blocks of the highest other node, and on the others' chain: at the
    # highest height all of them and node X have, above the pre-wipe head, one block hash
    say "waiting for node ${X_NODE} to come within 2 blocks of the others, on their chain"
    deadline=$((SECONDS + REJOIN_TIMEOUT))
    SYNCED=0
    while [ "${SECONDS}" -lt "${deadline}" ]; do
        chain=""
        hx="$(head_of "${X_NODE}")" || hx=unreadable
        ho="$(max_head_of "${OTHERS[@]}")"
        if is_num "${hx}" && is_num "${ho}" && [ "${hx}" -ge $((ho - 2)) ] && chain="$(same_chain "${H_STOP}" "${X_NODE}" "${OTHERS[@]}")"; then SYNCED=1; break; fi
        sleep 3
    done
    if [ "${SYNCED}" = 1 ]; then
        phase_end D1 "rejoin: node head within 2 blocks of the others, on their chain (from node serving)"
    else
        say "node ${X_NODE} did not come within 2 blocks on the others' chain in ${REJOIN_TIMEOUT}s (x=${hx} others=${ho:-unreadable})"
        check "node ${X_NODE} rejoins (head within 2 blocks, on the others' chain)" FAIL "head ${hx} vs others ${ho:-unreadable} after ${REJOIN_TIMEOUT}s${chain:+; ${chain}}"
    fi
    # Signing: the signing record moves past its at-stop value (it is written before a
    # signature leaves the node), or a block after the restart carries node X's signature
    SIGNED=0
    SIGN_EVIDENCE=""
    if [ "${SYNCED}" = 1 ]; then
        deadline=$((SECONDS + SIGN_TIMEOUT))
        while [ "${SECONDS}" -lt "${deadline}" ]; do
            if hs="$(record_pos signed)" && is_num "${H_SIGNED_STOP}" && [ "${hs%% *}" -gt "${H_SIGNED_STOP}" ]; then
                SIGNED=1
                SIGN_EVIDENCE="signing record advanced ${H_SIGNED_STOP} -> ${hs%% *}"
                break
            fi
            if hx="$(head_of "${X_NODE}")"; then
                for h in $(seq "${hx}" -1 $((hx > 5 ? hx - 5 : 1))); do
                    if [ "$(block_at "${X_NODE}" "${h}" | jq -r --arg pk "${PUB[${X_NODE}]}" --argjson t "${T_X_START}" '
                        def n: (. | ascii_downcase | ltrimstr("0x"));
                        (.content.timestamp // 0 | tonumber | if . > 100000000000 then . / 1000 else . end) as $ts
                        | if $ts >= $t and (((.validation_data.signatures // {}) | keys | map(n) | index($pk | n)) != null) then "yes" else "no" end' 2>/dev/null)" = yes ]; then
                        SIGNED=1
                        SIGN_EVIDENCE="block ${h} carries node ${X_NODE}'s signature"
                        break 2
                    fi
                done
            fi
            sleep 5
        done
        if [ "${SIGNED}" = 1 ]; then
            phase_end D "rejoin: head within 2 blocks and node signing (from node serving)"
        else
            check "node ${X_NODE} signs after the restart" FAIL "no signing within ${SIGN_TIMEOUT}s of syncing"
        fi
    fi
    T_END="$(date +%s)"
    if [ "${SIGNED}" = 1 ]; then
        printf 'ALL\toutage: node %s stopped until rejoined and signing\t%s\n' "${X_NODE}" "$(awk -v a="${T_B0}" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }')" >> "${PHASES}"
    fi
    stop_monitor

    # ═════════════════════════════════════════════════════════════════════
    # 9. checks
    # ═════════════════════════════════════════════════════════════════════
    step 09-checks
    # Each check below passes only on evidence read here or before: a read that fails or
    # gives nothing fails the check that needs it
    end_read=ok
    state_sums > "${OUT_DIR}/sums.end" || end_read="; cannot hash the state files after the rejoin"
    for rec in signed commitlock prevote; do POS_END[${rec}]="$(record_pos "${rec}")" || POS_END[${rec}]=unreadable; done
    HX_END="$(read_head "${X_NODE}")" || HX_END=unreadable
    HO_END="$(max_head_of "${OTHERS[@]}")"

    # 1. head
    if is_num "${HX_END}" && [ "${HX_END}" -ge "${H_STOP}" ]; then
        check "restored head >= pre-wipe head" PASS "head ${HX_END} >= ${H_STOP} (pre-wipe), ${H_REC} (step 2)"
    else
        check "restored head >= pre-wipe head" FAIL "head ${HX_END} < ${H_STOP}"
    fi
    # still within 2 blocks of the others now that D is over, not only once during it, and on their chain
    if [ "${SYNCED}" = 1 ]; then
        chain=""
        if is_num "${HX_END}" && is_num "${HO_END}" && [ "${HX_END}" -ge $((HO_END - 2)) ] && chain="$(same_chain "${H_STOP}" "${X_NODE}" "${OTHERS[@]}")"; then
            check "node ${X_NODE} within 2 blocks of the others at the end of D, on their chain" PASS "head ${HX_END} vs others ${HO_END}; ${chain}"
        else
            check "node ${X_NODE} within 2 blocks of the others at the end of D, on their chain" FAIL "head ${HX_END} vs others ${HO_END:-unreadable}: ${chain:-it came within 2 blocks during D, then fell behind}"
        fi
    fi
    # 2. hashes at the pre-wipe heights: each node's, node X's too, is the one recorded at
    # step 2 (H_REC) and read from node X's database at stop (H_STOP)
    bad=""
    agree=0
    for hh in "${H_REC} ${HASH_REC}" "${H_STOP} ${HASH_STOP}"; do
        for i in "${X_NODE}" "${OTHERS[@]}"; do
            got="$(hash_at "${i}" "${hh%% *}")" || got=none
            if [ "${got}" = "${hh#* }" ]; then agree=$((agree + 1)); else bad="${bad} node${i}@${hh%% *}=${got:0:10}!=${hh#* }"; fi
        done
    done
    if [ "${agree}" = $((2 * N)) ]; then
        check "block hash at pre-wipe heights equals the other nodes'" PASS "heights ${H_REC} and ${H_STOP}, all ${N} nodes agree"
    else
        check "block hash at pre-wipe heights equals the other nodes'" FAIL "${bad}"
    fi
    # 3. identity file identical
    ident_stop="$(sum_of "${OUT_DIR}/sums.stop" node.identity)"
    ident_end="$(sum_of "${OUT_DIR}/sums.end" node.identity)"
    if [ "${end_read}" = ok ] && sha_ok "${IDENT_SUM_2}" && [ "${ident_end}" = "${IDENT_SUM_2}" ] && [ "${ident_stop}" = "${IDENT_SUM_2}" ]; then
        check "identity file checksum identical (step 2, at stop, after rejoin)" PASS "sha256 ${IDENT_SUM_2:0:12}.."
    else
        check "identity file checksum identical (step 2, at stop, after rejoin)" FAIL "step2=$(short "${IDENT_SUM_2}") stop=$(short "${ident_stop}") end=$(short "${ident_end}")${end_read#ok}"
    fi
    # 4. signing state: every file there at stop, and each signing record, commit lock and
    # prevote record there at step 2, is still there; those three never older than at stop
    # by (height, round), and at least one of them compared; state which
    bad="${end_read#ok}"
    desc=""
    nrec=0
    names="$(awk 'FILENAME ~ /stop$/ || $2 ~ /^node\.identity\.(signed|commitlock|prevote)\.json$/ { print $2 }' "${OUT_DIR}/sums.step2" "${OUT_DIR}/sums.stop" | sort -u)"
    while read -r name; do
        case "${name}" in "" | node.identity) continue ;; esac
        s_stop="$(sum_of "${OUT_DIR}/sums.stop" "${name}")"
        s_end="$(sum_of "${OUT_DIR}/sums.end" "${name}")"
        if [ -z "${s_stop}" ]; then
            bad="${bad} ${name} was there at step 2, not at stop"
            continue
        fi
        if [ -z "${s_end}" ]; then
            bad="${bad} ${name} is gone"
            continue
        fi
        case "${name}" in
            node.identity.signed.json | node.identity.commitlock.json | node.identity.prevote.json)
                rec="${name#node.identity.}"
                rec="${rec%.json}"
                # "height/round" for the detail
                p_stop="${POS_STOP[${rec}]/ //}"
                p_end="${POS_END[${rec}]/ //}"
                case "$(pos_order "${POS_STOP[${rec}]}" "${POS_END[${rec}]}")" in
                    newer) desc="${desc} ${name#node.identity}=advanced ${p_stop} -> ${p_end}"; nrec=$((nrec + 1)) ;;
                    equal) desc="${desc} ${name#node.identity}=unchanged ${p_end}"; nrec=$((nrec + 1)) ;;
                    older) bad="${bad} ${name} is older than at stop: ${p_stop} -> ${p_end} (height/round)" ;;
                    *) bad="${bad} ${name} has no height and round to compare: ${p_stop:-none} at stop, ${p_end:-none} after" ;;
                esac
                ;;
            *)
                if [ "${s_end}" = "${s_stop}" ]; then desc="${desc} ${name#node.identity}=unchanged"; else desc="${desc} ${name#node.identity}=changed"; fi
                ;;
        esac
    done <<< "${names}"
    if [ -z "${bad}" ] && [ "${nrec}" -gt 0 ]; then
        check "signing state unchanged or advanced, never older" PASS "height/round at stop -> after the rejoin:${desc}"
    else
        check "signing state unchanged or advanced, never older" FAIL "${bad:- no signing record, commit lock or prevote record to compare};${desc}"
    fi
    # 5. no halt marker, no foreign signature. The state volume's listing must be read and
    # hold the identity; node X's log, read once to a file, must be read and not empty
    names_ok=1
    names_end="$(state_names | tr '\n' ' ')" || names_ok=0
    xlog="${LOG_DIR}/node-${X_NODE}.at-checks.log"
    x_log_ok=1
    docker logs "${CID[${X_NODE}]}" > "${xlog}" 2>&1 || x_log_ok=0
    [ -s "${xlog}" ] || x_log_ok=0
    foreign_now="$(awk '/another process is signing|foreign signature/ { n++ } END { print n + 0 }' "${xlog}")" || x_log_ok=0
    floor_lines="$(awk '/Restart signing floor/ { n++ } END { print n + 0 }' "${xlog}")" || x_log_ok=0
    if [ "${names_ok}" = 0 ] || [[ " ${names_end}" != *" node.identity "* ]]; then
        check "no halt marker, no foreign-signature log" FAIL "cannot list node ${X_NODE}'s state volume, or no node.identity in the list (${names_end:-nothing listed})"
    elif [[ "${names_end}" == *.halted* ]]; then
        check "no halt marker, no foreign-signature log" FAIL "a .halted marker is on the state volume"
    elif [ "${x_log_ok}" = 0 ]; then
        check "no halt marker, no foreign-signature log" FAIL "docker logs cannot read node ${X_NODE}'s log, or it is empty, so a foreign-signature line cannot be ruled out"
    elif [ "${foreign_now}" != 0 ]; then
        check "no halt marker, no foreign-signature log" FAIL "${foreign_now} foreign-signature lines after the restart"
    else
        check "no halt marker, no foreign-signature log" PASS "none (state volume: ${names_end})"
    fi
    if [ "${x_log_ok}" = 0 ]; then
        check "restart signing floor logged before signing" FAIL "docker logs cannot read node ${X_NODE}'s log, or it is empty: the line cannot be looked for"
    elif [ "${floor_lines}" -gt 0 ]; then
        check "restart signing floor logged before signing" PASS "[SIGNING] Restart signing floor line present"
    else
        check "restart signing floor logged before signing" INFO "the [SIGNING] Restart signing floor line is missing from node ${X_NODE}'s log"
    fi
    # 6. signing again
    if [ "${SIGNED}" = 1 ]; then check "node ${X_NODE} signs after the restart" PASS "${SIGN_EVIDENCE}"; fi
    # 7. the other nodes never stalled
    stall_verdict "${T_STOP}" "${T_END}"
    if [ "${EXPECT_PAUSE}" = 1 ]; then
        check "other nodes kept forging while node ${X_NODE} was down" INFO "EXPECTED PAUSE: ${LIVE_OTHERS} live < q=${Q} (shardSize ${SHARD_SIZE}); observed ${STALL_DETAIL}"
    else
        check "other nodes never stalled while node ${X_NODE} was down" "${STALL_RESULT}" "q=${Q}, ${LIVE_OTHERS} live; ${STALL_DETAIL}"
    fi
    META[outage_others_head]="${first} -> ${last}, longest gap ${maxgap}s"
    # 8. the restored counts, the schema and the one instance of the key: checked in phase C
else
    # ═════════════════════════════════════════════════════════════════════
    # Variant: restore into a new, isolated, non-signing node
    # ═════════════════════════════════════════════════════════════════════
    step 06-isolated-restore
    phase_begin
    dc up -d --no-deps --pull never pg-iso >> "${STEP_LOG}" 2>&1 || die "pg-iso did not start"
    wait_pg iso 120 || die "pg-iso not ready within 120s"
    tables="$(psql_q iso "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
    [ "${tables}" = 0 ] || die "the isolated database is not empty"
    pgx iso sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "${DUMP_FILE}" >> "${STEP_LOG}" 2>&1 \
        || die "pg_restore into the isolated database failed"
    stats_of iso > "${OUT_DIR}/stats.restored.txt"
    if run_migrations iso; then MIGRATED=1; else
        MIGRATED=0
        if [ "${MIGRATE_REQUIRED}" = 1 ]; then die "migrations failed on the isolated database (see 06-isolated-restore.log)"; fi
    fi
    stats_of iso > "${OUT_DIR}/stats.migrated.txt"
    phase_end IC "isolated restore: start postgres, pg_restore, migrations"
    check_restored_stats "isolated restore" "${OUT_DIR}/stats.restored.txt"
    mig_rows="$(stat_of "${OUT_DIR}/stats.migrated.txt" migrations)"
    if is_num "${MIGRATION_FILES}" && [ "${MIGRATION_FILES}" -gt 0 ] && [ "${mig_rows}" = "${MIGRATION_FILES}" ]; then
        check "schema at the image's head after the manual migration" PASS "migrations table ${mig_rows} rows = ${MIGRATION_FILES} files"
    else
        check "schema at the image's head after the manual migration" FAIL "migrations table ${mig_rows:-none} rows vs ${MIGRATION_FILES} files (migrated=${MIGRATED})"
    fi
    DB_HEAD="$(stat_of "${OUT_DIR}/stats.restored.txt" max_block)"
    if is_num "${DB_HEAD}" && [ "${DB_HEAD}" -ge "${H_DUMP_BEFORE}" ]; then
        check "isolated DB reaches the dump's head" PASS "max block ${DB_HEAD} (dump window ${H_DUMP_BEFORE}..${H_DUMP_AFTER})"
    else
        check "isolated DB reaches the dump's head" FAIL "max block ${DB_HEAD:-?} < ${H_DUMP_BEFORE}"
    fi
    nethash=""
    dbhash=""
    if is_num "${DB_HEAD}" && nethash="$(hash_at "${OTHERS[0]}" "${DB_HEAD}")" && dbhash="$(psql_q iso "SELECT hash FROM blocks WHERE number = ${DB_HEAD}")" && [ "${nethash}" = "${dbhash}" ]; then
        check "isolated DB's head block hash equals the network's" PASS "height ${DB_HEAD}"
    else
        check "isolated DB's head block hash equals the network's" FAIL "db $(short "${dbhash:-none}") net $(short "${nethash:-none}")"
    fi
    if [ "${ISO_NODE}" = 1 ]; then
        step 07-isolated-node
        phase_begin
        dc up -d --no-deps --pull never node-iso >> "${STEP_LOG}" 2>&1 || die "node-iso did not start"
        refresh_cid iso
        wait_serve iso "${SERVE_TIMEOUT}" || die "node-iso did not serve within ${SERVE_TIMEOUT}s (see node-iso.log)"
        deadline=$((SECONDS + REJOIN_TIMEOUT))
        ISO_OK=0
        # Caught up: at or above the DB head, within 2 blocks of the highest validator, and on
        # their chain: at the highest height node-iso and all of them have, above the DB head, one block hash
        while [ "${SECONDS}" -lt "${deadline}" ]; do
            chain=""
            hi="$(head_of iso)" || hi=unreadable
            ho="$(max_head_of "${ALL_NODES[@]}")"
            if is_num "${hi}" && is_num "${DB_HEAD}" && [ "${hi}" -ge "${DB_HEAD}" ] && is_num "${ho}" && [ "${hi}" -ge $((ho - 2)) ] \
                && chain="$(same_chain "${DB_HEAD}" iso "${ALL_NODES[@]}")"; then ISO_OK=1; break; fi
            sleep 3
        done
        if [ "${ISO_OK}" = 1 ]; then
            phase_end ID "isolated node: serving and within 2 blocks of the network, on its chain"
            check "isolated node reaches the expected head, on the validators' chain" PASS "head ${hi} >= DB head ${DB_HEAD}, network ${ho}; ${chain}"
        else
            check "isolated node reaches the expected head, on the validators' chain" FAIL "head ${hi} vs DB head ${DB_HEAD}, network ${ho:-unreadable} after ${REJOIN_TIMEOUT}s${chain:+; ${chain}}"
        fi
        # Node X's key never went anywhere: node-iso's own state volume among its mounts and
        # none of node X's, and a different identity, both identities read as a sha256
        mounts_iso="$(docker inspect -f '{{range .Mounts}}{{.Source}} {{.Name}}{{"\n"}}{{end}}' "${CID[iso]}")" || mounts_iso=unreadable
        iso_sum="$(helper 's="$(sha256sum /s/node.identity)" && echo "${s%% *}"' -v "$(vol state-iso):/s:ro" "${PG_IMAGE}")" || iso_sum=unreadable
        if ! awk -v v="$(vol state-iso)" '$NF == v { f = 1 } END { exit !f }' <<< "${mounts_iso}"; then
            check "isolated node holds no copy of node ${X_NODE}'s key" FAIL "cannot read node-iso's mounts, or its own state volume is not among them"
        elif grep -qE "node${X_NODE}\.identity|state-${X_NODE}" <<< "${mounts_iso}"; then
            check "isolated node holds no copy of node ${X_NODE}'s key" FAIL "its mounts include node ${X_NODE}'s identity or state volume"
        elif ! sha_ok "${iso_sum}" || ! sha_ok "${IDENT_SUM_2}"; then
            check "isolated node holds no copy of node ${X_NODE}'s key" FAIL "cannot read node-iso's identity file from its state volume as a sha256 to compare it (node-iso: ${iso_sum:-nothing}, node ${X_NODE} at step 2: $(short "${IDENT_SUM_2:-nothing}"))"
        elif [ "${iso_sum}" = "${IDENT_SUM_2}" ]; then
            check "isolated node holds no copy of node ${X_NODE}'s key" FAIL "same identity file hash"
        else
            check "isolated node holds no copy of node ${X_NODE}'s key" PASS "own state volume mounted, no identity or state volume of node ${X_NODE}, different identity (sha256 $(short "${iso_sum}").. vs $(short "${IDENT_SUM_2}")..)"
        fi
    fi
    stop_monitor
    T_END="$(date +%s)"
    stall_verdict "${T_DRILL_START}" "${T_END}"
    check "the validators kept forging during the drill" "${STALL_RESULT}" "${STALL_DETAIL}"
    # The running node-X containers, and the containers on its state volume, must both be
    # just the one started at bring-up (ids cut to 12: docker ps and compose ps differ)
    x_cid="${CID[${X_NODE}]:0:12}"
    x_svc="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=node-${X_NODE}" | cut -c1-12 | tr '\n' ' ')" || x_svc="cannot list "
    x_holders="$(docker ps -q --filter "volume=$(vol "state-${X_NODE}")" | cut -c1-12 | tr '\n' ' ')" || x_holders="cannot list "
    if [ -n "${x_cid}" ] && [ "${x_svc}" = "${x_cid} " ] && [ "${x_holders}" = "${x_cid} " ]; then
        check "node ${X_NODE} untouched and the only holder of its key" PASS "one node-${X_NODE} container, the one started at bring-up, and the only container on its state volume"
    else
        check "node ${X_NODE} untouched and the only holder of its key" FAIL "node-${X_NODE} containers: ${x_svc:-none }; on its state volume: ${x_holders:-none }; started at bring-up: ${x_cid:-?}"
    fi
fi

# ═════════════════════════════════════════════════════════════════════════
# 10. report
# ═════════════════════════════════════════════════════════════════════════
step 10-report
if [ "${ANY_FAIL}" = 1 ]; then RESULT=FAIL; else RESULT=PASS; fi
write_report
echo
tee -a "${LOG_DIR}/run.log" < "${OUT_DIR}/timings.md"
say "RESULT ${RESULT}: ${VARIANT} drill, timings in ${OUT_DIR}/timings.md and timings.json"
if [ "${RESULT}" = PASS ]; then exit 0; fi
exit 1
