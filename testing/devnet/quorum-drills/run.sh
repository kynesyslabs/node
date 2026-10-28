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
#   listed-stall    10 staked, 7 running: stop 1 listed, start the 3 others
#   fallback        10 validators: the last block lists 6 (< 7) of them
#   partition       6 validators, shardSize 4: split 3 + 3, then heal
#
# Everything lives in a per-run dir under runs/ (gitignored: it holds the
# devnet keys) and is torn down on exit, failure or Ctrl-C.
# Exit codes: 0 pass, 1 fail, 2 the run could not be carried out.
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

usage() {
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
    echo "Environment: IMAGE SRC_TREE BINDING CONSENSUS_TIME NODE_MEM NODE_EST_MB HEADROOM_MB"
    echo "             RUNS_DIR MIN_DISK_GB STALL_WINDOW PROGRESS_TIMEOUT PARTITION_TIME (README.md)"
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
    listed-stall) N=10; SHARD=10; START=7 ;;
    fallback) N=10; SHARD=10; START=10 ;;
    partition) N=6; SHARD=4; START=6 ;;
    *) usage >&2; exit 2 ;;
esac
case "${BINDING}" in on|off) ;; *) echo "--binding must be on or off" >&2; exit 2 ;; esac
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
CODE="image"
[ -n "${SRC_TREE}" ] && CODE="src:$(basename "${SRC_TREE}")@$(git -C "${SRC_TREE}" rev-parse --short HEAD 2>/dev/null || echo '?')$(git -C "${SRC_TREE}" diff --quiet HEAD -- src 2>/dev/null || echo '+dirty')"
say "scenario=${SCENARIO} N=${N} shardSize=${SHARD} q=${Q} binding=${BINDING} image=${IMAGE} (${IMAGE_ID:7:12}) code=${CODE}"

# ── 2. inputs ───────────────────────────────────────────────────────────
step 02-inputs
GENESIS_TS=$(( $(date -u +%s) + GENESIS_DELAY ))
{
    for i in $(seq 1 "${N}"); do
        out=$(cd "${REPO_ROOT}" && bun testing/devnet/scripts/generate-identity-helper.ts) || exit 1
        echo "${out}" | grep '^MNEMONIC:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/node${i}.identity"
        echo "${out}" | grep '^PUBKEY:' | cut -d: -f2- | tr -d '\n' > "${RUN_DIR}/inputs/pub${i}"
    done
    chmod 600 "${RUN_DIR}"/inputs/node*.identity
    python3 "${HERE}/gen-inputs.py" --run-dir "${RUN_DIR}" --repo "${REPO_ROOT}" \
        --nodes "${N}" --shard-size "${SHARD}" --binding "${BINDING}" --genesis-ts "${GENESIS_TS}" \
        --image "${IMAGE}" --src "${SRC_TREE}" --node-mem "${NODE_MEM}" --consensus-time "${CONSENSUS_TIME}"
} >> "${STEP_LOG}" 2>&1 || { say "ABORT: generating inputs failed (see 02-inputs.log)"; exit 2; }
declare -a PUB UP
for i in $(seq 1 "${N}"); do PUB[i]=$(tr 'A-Z' 'a-z' < "${RUN_DIR}/inputs/pub${i}"); UP[i]=0; done
say "inputs ready (genesis in ${GENESIS_DELAY}s)"

# ── helpers ─────────────────────────────────────────────────────────────
port_of() { echo $((53549 + 2 * $1)); }
cid_of() { dc ps -q "node-$1" 2>/dev/null; }
rpc() { # $1 node, $2 JSON body
    local cid; cid=$(cid_of "$1"); [ -z "${cid}" ] && return 1
    docker exec "${cid}" curl -sS -m4 -X POST -H 'Content-Type: application/json' \
        -d "$2" "http://localhost:$(port_of "$1")/" 2>/dev/null
}
head_of() {
    rpc "$1" '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{},"muid":null}]}' |
        jq -r 'select(.result == 200) | .response' 2>/dev/null
}
block_at() { # $1 node, $2 height -> the block's JSON
    rpc "$1" "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getBlockByNumber\",\"data\":{\"blockNumber\":$2},\"muid\":null}]}" |
        jq -c 'select(.result == 200) | .response' 2>/dev/null
}
hash_at() { block_at "$1" "$2" | jq -r '.hash // empty' 2>/dev/null; }
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
max_head() { local i h m=0; for i in $(running); do h=$(head_of "${i}"); [ -n "${h}" ] && [ "${h}" -gt "${m}" ] && m="${h}"; done; echo "${m}"; }
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

# All running nodes on one head >= $1 with one hash
wait_lockstep() {
    local deadline=$((SECONDS + $2)) i h first hs ok
    while [ ${SECONDS} -lt ${deadline} ]; do
        ok=1; first=""
        for i in $(running); do
            h=$(head_of "${i}")
            if [ -z "${h}" ] || [ "${h}" -lt "$1" ]; then ok=0; break; fi
            [ -z "${first}" ] && first="${h}"
            [ "${h}" != "${first}" ] && { ok=0; break; }
        done
        if [ "${ok}" = 1 ]; then
            hs=""
            for i in $(running); do hs="${hs} $(hash_at "${i}" "${first}")"; done
            if [ "$(echo "${hs}" | tr ' ' '\n' | grep -c .)" = "$(live_count)" ] &&
                [ "$(echo "${hs}" | tr ' ' '\n' | grep . | sort -u | wc -l)" = 1 ]; then
                LOCK_HEIGHT="${first}"; return 0
            fi
        fi
        say "heads: $(heads_line)"
        sleep 5
    done
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
        m=$(max_head)
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
    prev=$(max_head)
    while [ ${SECONDS} -lt ${deadline} ]; do
        sleep 5
        m=$(max_head)
        [ "${m}" != "${prev}" ] && { last_change=${SECONDS}; prev="${m}"; }
    done
    m=$(max_head)
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
    h=$(head_of "${watcher}")
    since=$(date -u +%s)
    deadline=$((SECONDS + 60))
    while [ ${SECONDS} -lt ${deadline} ]; do
        line=$(docker logs --since "${since}" "$(cid_of "${watcher}")" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' |
            grep -aoE 'We are forging block [0-9]+' | awk -v h="${h:-0}" '$5 > h' | head -1)
        [ -n "${line}" ] && break
        sleep 0.3
    done
    event "round start seen on node-${watcher}: ${line:-none within 60s}"
    stop_node "${victim}"
    STOP_HEIGHT="${h:-0}"
}

# Log lines matching $1 across every node's current log
grep_logs() {
    local i cid
    for i in $(seq 1 "${N}"); do
        cid=$(dc ps -aq "node-${i}" 2>/dev/null); [ -z "${cid}" ] && continue
        docker logs "${cid}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -aE "$1" | sed "s/^/node-${i}: /"
    done
}

# ── 3. bring-up ─────────────────────────────────────────────────────────
step 03-bringup
STARTED_STACK=1
dc up -d postgres >> "${STEP_LOG}" 2>&1 || { say "ABORT: postgres did not start"; exit 2; }
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
PHASE_END=0
STOP_HEIGHT=0

lockstep_or_abort() {
    wait_lockstep "$1" "${LOCKSTEP_TIMEOUT}" || { say "ABORT: the running nodes never reached one head >= $1 with one hash"; exit 2; }
    say "running nodes in lockstep at ${LOCK_HEIGHT}"
}

scenario_floor() {
    # Wait past the genesis time plus several round intervals
    local until_ts=$((GENESIS_TS + 8 * CONSENSUS_TIME + 30)) m lines
    while [ "$(date -u +%s)" -lt "${until_ts}" ]; do sleep 5; done
    m=$(max_head)
    lines=$(grep_logs "below the (floor|quorum) of ${Q}" | tee -a "${STEP_LOG}" | wc -l)
    say "head after $((8 * CONSENSUS_TIME + 30))s past genesis: ${m}; floor/quorum refusals logged: ${lines}"
    grep_logs "below the (floor|quorum) of ${Q}" | head -3 | cut -c1-260 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
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
            expect_stall "down-${k}" "${STOP_HEIGHT}" || ok=0
            grep_logs "below the (floor|quorum) of ${Q}" | tail -2 | cut -c1-260 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
        fi
        DETAIL="${DETAIL}down${k}=${expect}:$(tail -1 "${PHASES}" | cut -f9) "
    done
    # Manual recovery: bring the stopped validators back
    local h; h=$(max_head)
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
    pl=$(block_at "${r}" "$(head_of "${r}")" | jq -r '.content.peerlist | length')
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

psql_node() { # $1 node, $2 SQL
    docker exec "$(dc ps -q postgres)" psql -U demosuser -d "node$1_db" -tAc "$2"
}

scenario_fallback() {
    lockstep_or_abort 3
    local i h heads_db listed pl_json fallback_lines ok=1
    # Stop every node at once right after a commit, so they all hold one head
    wait_lockstep "$((LOCK_HEIGHT + 1))" 120 || { say "ABORT: no fresh lockstep"; exit 2; }
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
    for i in $(seq 1 "${N}"); do start_node "${i}" || { say "ABORT: node-${i} did not come back"; exit 2; }; sleep 2; done
    if [ "${BINDING}" = on ]; then
        expect_progress "listed-below-q" "${h}" || ok=0
    else
        # Pre-fork rule: the pool is the 6 listed, below the floor, forever
        expect_stall "listed-below-q" "${h}" || ok=0
    fi
    fallback_lines=$(grep_logs "drawing the committee from all" | tee -a "${STEP_LOG}" | wc -l)
    grep_logs "drawing the committee from all|Shard of [0-9]+ is below the floor" | head -2 | cut -c1-260 | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
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
    wait_lockstep "$((LOCK_HEIGHT + 1))" 120 || { say "ABORT: no fresh lockstep"; exit 2; }
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
        local hh; hh=$(head_of "${i}"); hh=${hh:-0}
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
    for i in $(running); do hh=$(head_of "${i}"); [ -n "${hh}" ] && [ "${hh}" -lt "${hmin}" ] && hmin="${hh}"; done
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

case "${SCENARIO}" in
    floor) scenario_floor ;;
    drop-*) scenario_drop ;;
    listed-stall) scenario_listed_stall ;;
    fallback) scenario_fallback ;;
    partition) scenario_partition ;;
esac

# ── 5. verdict ──────────────────────────────────────────────────────────
step 05-verdict
column -t -s $'\t' "${PHASES}" | sed 's/^/    /' | tee -a "${LOG_DIR}/run.log"
sed 's/^/    /' "${EVENTS}" 2>/dev/null | tee -a "${LOG_DIR}/run.log" >/dev/null
jq -n --arg run "${RUN_ID}" --arg scenario "${SCENARIO}" --arg binding "${BINDING}" \
    --argjson n "${N}" --argjson shardSize "${SHARD}" --argjson q "${Q}" --arg code "${CODE}" \
    --arg image "${IMAGE}" --arg detail "${DETAIL}" --arg result "${RESULT}" \
    '{run: $run, scenario: $scenario, binding: $binding, validators: $n, shardSize: $shardSize,
      q: $q, code: $code, image: $image, detail: $detail, result: $result}' > "${LOG_DIR}/verdict.json"
RESULTS="${RUNS_DIR}/results.tsv"
[ -f "${RESULTS}" ] || printf 'run\tscenario\tbinding\tN\tshardSize\tq\tcode\tdetail\tresult\n' > "${RESULTS}"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${RUN_ID}" "${SCENARIO}" "${BINDING}" "${N}" "${SHARD}" "${Q}" \
    "${CODE}" "${DETAIL}" "${RESULT}" >> "${RESULTS}"
free -m | sed -n 2p | sed 's/^/host after run: /' >> "${LOG_DIR}/run.log"
say "RESULT ${RESULT}: ${SCENARIO} (N=${N}, shardSize ${SHARD}, q ${Q}, binding ${BINDING}) ${DETAIL}"
[ "${RESULT}" = PASS ] && exit 0
exit 1
