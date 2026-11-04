#!/usr/bin/env bash
# Fault injection and verdict for one same-height race run. Called by run.sh
# once the four validators are up; see README.md for what each mode does.
#
# Faults are iptables rules in a netshoot sidecar that shares a node's
# network namespace. They are timed from the nodes' own log lines (round
# start, secretary, vote tally), not from sleeps, so they land on the same
# phase of the round regardless of host speed.
set -uo pipefail
: "${MODE:?}" "${PROJECT:?}" "${RUN_DIR:?}" "${LOG_DIR:?}" "${ENVFILE:?}"

LOCKSTEP_TIMEOUT="${LOCKSTEP_TIMEOUT:-300}"
ROUND_TIMEOUT="${ROUND_TIMEOUT:-90}"
FAULT_MAX="${FAULT_MAX:-150}"
SETTLE_BLOCKS="${SETTLE_BLOCKS:-3}"
SETTLE_TIMEOUT="${SETTLE_TIMEOUT:-180}"
DETECT_WINDOW="${DETECT_WINDOW:-60}"
NETSHOOT_IMAGE="${NETSHOOT_IMAGE:-nicolaka/netshoot:latest}"
METRIC="demos_conflicting_block_total"

dc() { docker compose --env-file "${ENVFILE}" -p "${PROJECT}" "$@"; }
STEP_LOG="${LOG_DIR}/orchestrate.log"
say() { echo "[race $(date -u +%H:%M:%S)] $*" | tee -a "${LOG_DIR}/run.log" >> "${STEP_LOG}"; echo "[race $(date -u +%H:%M:%S)] $*"; }
step() { STEP_LOG="${LOG_DIR}/$1.log"; say "── $1"; }
event() { echo "$(date -u +%H:%M:%S.%3N) $*" >> "${LOG_DIR}/05-fault.log"; }

declare -a CID PORT PUB
for i in 1 2 3 4; do
    CID[i]=$(dc ps -q "node-${i}")
    PORT[i]=$((53549 + 2 * i))
    PUB[i]=$(tr 'A-Z' 'a-z' < "${RUN_DIR}/inputs/pub${i}")
done

rpc() { # $1 node, $2 JSON body
    docker exec "${CID[$1]}" curl -sS -m4 -X POST -H 'Content-Type: application/json' \
        -d "$2" "http://localhost:${PORT[$1]}/" 2>/dev/null
}
head_of() {
    rpc "$1" '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{},"muid":null}]}' |
        jq -r 'select(.result == 200) | .response' 2>/dev/null
}
hash_at() {
    rpc "$1" "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getBlockByNumber\",\"data\":{\"blockNumber\":$2},\"muid\":null}]}" |
        jq -r 'select(.result == 200) | .response.hash // empty' 2>/dev/null
}
# A node that does not answer counts as height 0
heads() { local i h; for i in 1 2 3 4; do h=$(head_of "${i}"); printf '%s ' "${h:-0}"; done; }
node_of_pub() { local i; for i in 1 2 3 4; do [ "${PUB[i]}" = "$(echo "$1" | tr 'A-Z' 'a-z')" ] && echo "${i}" && return; done; }

# ── iptables through the sidecars ──────────────────────────────────────
sidecar() { echo "${PROJECT}-fault-$1"; }
ipt() { # $1 node, rest iptables args
    local n="$1"; shift
    if docker exec "$(sidecar "${n}")" iptables "$@" 2>>"${LOG_DIR}/05-fault.log"; then
        event "node-${n}: iptables $*"
    else
        event "node-${n}: FAILED iptables $*"
        return 1
    fi
}
match_rule() { # $1 chain, $2 string, $3 tag -> rule spec
    echo "$1 -p tcp -m string --algo bm --string $2 -m comment --comment crace-$3 -j DROP"
}
# Outgoing requests carrying a method name, e.g. node 2 sending proposals
block_string() { ipt "$1" -I $(match_rule OUTPUT "$2" "$3"); }
unblock_string() { ipt "$1" -D $(match_rule OUTPUT "$2" "$3"); }
# Incoming requests carrying a method name, e.g. node 2 serving blocks
block_incoming() { ipt "$1" -I $(match_rule INPUT "$2" "$3"); }
clear_rules() { # remove every rule this harness added in node $1's namespace
    # `iptables -S` quotes the match strings; the words carry no spaces
    docker exec "$(sidecar "$1")" sh -c \
        'iptables -S | grep -- "--comment crace-" | sed "s/^-A /-D /; s/\"//g" | while read -r r; do iptables $r; done' \
        2>>"${LOG_DIR}/05-fault.log"
    event "node-$1: cleared harness rules"
}

# ── log watchers ───────────────────────────────────────────────────────
# One `docker logs -f` per node streams into a file for the fault window, and
# watchers poll those files: a `docker logs -f | awk` pipeline does not end
# when awk exits (the CLI survives the broken pipe), so it would report a
# match only at its timeout.
STREAMS=()
start_streams() { # $1 since
    local i
    for i in 1 2 3 4; do
        timeout "$((FAULT_MAX + ROUND_TIMEOUT + 120))" docker logs -f --since "$1" "${CID[i]}" \
            > "${LOG_DIR}/.stream-${i}" 2>&1 &
        STREAMS+=($!)
    done
}
stop_streams() {
    [ ${#STREAMS[@]} -gt 0 ] && kill "${STREAMS[@]}" 2>/dev/null
    wait "${STREAMS[@]}" 2>/dev/null
    STREAMS=()
    rm -f "${LOG_DIR}"/.stream-*
}
trap stop_streams EXIT

# The first line of node $1's stream matching the awk condition $3 once a
# round at height >= $2 has started
match_after_round() {
    awk -v H="$2" -v node="$1" '
        { gsub(/\033\[[0-9;]*m/, "") }
        match($0, /We are forging block [0-9]+/) {
            if (substr($0, RSTART + 21, RLENGTH - 21) + 0 >= H) started = 1
        }
        started && ('"$3"') { print node "\t" $0; exit }
    ' "${LOG_DIR}/.stream-$1" 2>/dev/null
}
# Same, waiting up to $4 s; prints nothing on timeout
watch_after_round() {
    local deadline=$((SECONDS + $4)) line
    while [ ${SECONDS} -lt ${deadline} ]; do
        line=$(match_after_round "$1" "$2" "$3")
        [ -n "${line}" ] && { echo "${line}"; return 0; }
        sleep 0.2
    done
    return 1
}

# ── 4. lockstep ────────────────────────────────────────────────────────
step 04-lockstep
deadline=$((SECONDS + LOCKSTEP_TIMEOUT))
h0=""
while [ ${SECONDS} -lt ${deadline} ]; do
    read -r -a hs <<< "$(heads)"
    say "heads: n1=${hs[0]} n2=${hs[1]} n3=${hs[2]} n4=${hs[3]}"
    a="${hs[0]}"
    if [ "${a}" -ge 3 ] && [ "${a}" = "${hs[1]}" ] && [ "${a}" = "${hs[2]}" ] && [ "${a}" = "${hs[3]}" ]; then
        x1=$(hash_at 1 "${a}"); x2=$(hash_at 2 "${a}"); x3=$(hash_at 3 "${a}"); x4=$(hash_at 4 "${a}")
        if [ -n "${x1}" ] && [ "${x1}" = "${x2}" ] && [ "${x1}" = "${x3}" ] && [ "${x1}" = "${x4}" ]; then
            h0="${a}"; break
        fi
    fi
    sleep 3
done
if [ -z "${h0}" ]; then say "ABORT: the four nodes never reached one head with one hash"; exit 2; fi
say "all four nodes hold block ${h0} with one hash"

# ── 5. fault ───────────────────────────────────────────────────────────
step 05-fault
for i in 1 2 3 4; do
    # Fresh sidecars: a node restarted since the bring-up has a new namespace
    docker rm -f "$(sidecar "${i}")" >/dev/null 2>&1
    docker run -d --name "$(sidecar "${i}")" --network "container:${CID[i]}" \
        --cap-add NET_ADMIN --memory 64m --label "crace.project=${PROJECT}" \
        "${NETSHOOT_IMAGE}" sleep infinity >/dev/null 2>>"${STEP_LOG}" ||
        { say "ABORT: sidecar for node-${i} did not start"; exit 2; }
    docker exec "$(sidecar "${i}")" iptables -S OUTPUT >/dev/null 2>>"${STEP_LOG}" ||
        { say "ABORT: iptables unusable in node-${i}'s namespace"; exit 2; }
done
say "sidecars up"

# The target is the second height from now, so the rules go in between
# rounds: after every node holds H-1 and before round H votes
H=""
for attempt in 1 2 3; do
    cur=0
    for h in $(heads); do [ "${h}" -gt "${cur}" ] && cur="${h}"; done
    target=$((cur + 2))
    deadline=$((SECONDS + 90))
    while [ ${SECONDS} -lt ${deadline} ]; do
        min=999999; max=0
        for h in $(heads); do
            [ "${h}" -lt "${min}" ] && min="${h}"
            [ "${h}" -gt "${max}" ] && max="${h}"
        done
        [ "${min}" -ge $((target - 1)) ] && break
        sleep 0.5
    done
    if [ "${min}" -ge $((target - 1)) ] && [ "${max}" -lt "${target}" ]; then H="${target}"; break; fi
    say "missed the window for height ${target} (heads ${min}..${max}), retrying"
done
[ -z "${H}" ] && { say "ABORT: could not place the fault between two rounds"; exit 2; }
T0=$(( $(date -u +%s) - 2 ))
start_streams "${T0}"

# A is the member left able to propose. It is never the secretary, which
# runs the round's phase bookkeeping as well.
pick_non_secretary() {
    local sec_node i
    sec_node=$(node_of_pub "$1")
    for i in 1 2 3 4; do [ "${i}" != "${sec_node}" ] && echo "${i}" && return; done
}

: > "${LOG_DIR}/05-fault.log"
event "target height ${H}, mode ${MODE}"
wait_round_start() { # prints the secretary of round H, as soon as any node logs it
    local line="" deadline=$((SECONDS + ROUND_TIMEOUT)) i
    while [ -z "${line}" ] && [ ${SECONDS} -lt ${deadline} ]; do
        for i in 1 2 3 4; do
            line=$(match_after_round "${i}" "${H}" '/SECRETARY: /')
            [ -n "${line}" ] && break
        done
        [ -z "${line}" ] && sleep 0.1
    done
    [ -z "${line}" ] && return 1
    event "round ${H} started (seen on node-$(echo "${line}" | cut -f1))"
    echo "${line}" | awk '{print $NF}'
}

if [ "${MODE}" = control ]; then
    # Secretaries change between rounds, so A is a guess until round H names
    # its secretary
    last_sec=$(docker logs "${CID[1]}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -a 'SECRETARY: ' | tail -1 | awk '{print $NF}')
    A=$(pick_non_secretary "${last_sec}")
    for i in 1 2 3 4; do [ "${i}" != "${A}" ] && block_string "${i}" proposeBlockHash propose; done
    say "height ${H}: proposals blocked on every node but node-${A}"
    sec=$(wait_round_start) || { say "ABORT: round ${H} did not start within ${ROUND_TIMEOUT}s"; exit 2; }
    if [ "$(node_of_pub "${sec}")" = "${A}" ]; then
        # Nobody has proposed yet at this point of the round
        B=$(pick_non_secretary "${sec}")
        block_string "${A}" proposeBlockHash propose
        unblock_string "${B}" proposeBlockHash propose
        event "node-${A} is the secretary of ${H}; node-${B} is A instead"
        A="${B}"
    fi
else
    for i in 1 2 3 4; do block_string "${i}" proposeBlockHash propose; done
    say "height ${H}: proposals blocked on all four nodes; waiting for the round to start"
    sec=$(wait_round_start) || { say "ABORT: round ${H} did not start within ${ROUND_TIMEOUT}s"; exit 2; }
    A=$(pick_non_secretary "${sec}")
    if [ "${MODE}" = race-strict ]; then
        # Nobody may learn A's commit from A: no push, no sync-data claim,
        # and requests for its blocks go unanswered
        block_string "${A}" syncNewBlock push
        block_string "${A}" updateSyncData syncdata
        block_incoming "${A}" getBlocks serve
    fi
    unblock_string "${A}" proposeBlockHash propose
fi
event "A = node-${A}, secretary node-$(node_of_pub "${sec}")"
say "round ${H} started: node-${A} may propose (secretary node-$(node_of_pub "${sec}"))"

# Each other member gets its proposals back once its own first tally at H
# has failed and A holds H: its retry then runs against a committed block,
# as in the incident, instead of racing A's commit
a_holds_h() {
    local deadline=$((SECONDS + FAULT_MAX)) h
    while [ ${SECONDS} -lt ${deadline} ]; do
        h=$(head_of "${A}"); [ -n "${h}" ] && [ "${h}" -ge "${H}" ] && return 0
        sleep 0.3
    done
    return 1
}
WATCHERS=()
for i in 1 2 3 4; do
    [ "${i}" = "${A}" ] && continue
    (
        line=$(watch_after_round "${i}" "${H}" '/Vote tally for block/' "${FAULT_MAX}")
        if [ -n "${line}" ]; then
            event "node-${i} tally: $(echo "${line}" | grep -oE 'pro=[0-9]+, con=[0-9]+')"
        else
            event "node-${i}: no tally within ${FAULT_MAX}s"
        fi
        a_holds_h || event "node-${A} (A) did not reach ${H} within ${FAULT_MAX}s"
        unblock_string "${i}" proposeBlockHash propose
    ) &
    WATCHERS+=($!)
done

line=$(watch_after_round "${A}" "${H}" '/Vote tally for block/' "${FAULT_MAX}")
event "node-${A} (A) tally: $(echo "${line}" | grep -oE 'pro=[0-9]+, con=[0-9]+' || echo none)"
if [ "${MODE}" = race-strict ]; then
    # Keep A's block out of reach until the others have settled H without it
    deadline=$((SECONDS + FAULT_MAX))
    while [ ${SECONDS} -lt ${deadline} ]; do
        done_count=0
        for i in 1 2 3 4; do
            [ "${i}" = "${A}" ] && continue
            h=$(head_of "${i}"); [ -n "${h}" ] && [ "${h}" -ge "${H}" ] && done_count=$((done_count + 1))
        done
        [ "${done_count}" -eq 3 ] && break
        sleep 1
    done
    event "the other three hold height ${H}: ${done_count}/3"
    clear_rules "${A}"
    say "node-${A} serves and announces its blocks again"
fi
for pid in "${WATCHERS[@]}"; do wait "${pid}"; done
for i in 1 2 3 4; do clear_rules "${i}"; done
stop_streams
say "fault window over; all harness rules removed"
sed 's/^/    /' "${LOG_DIR}/05-fault.log" | tee -a "${LOG_DIR}/run.log"

# ── 6. settle ──────────────────────────────────────────────────────────
step 06-settle
deadline=$((SECONDS + SETTLE_TIMEOUT))
while [ ${SECONDS} -lt ${deadline} ]; do
    read -r a b c d <<< "$(heads)"
    say "heads: n1=${a:-?} n2=${b:-?} n3=${c:-?} n4=${d:-?}"
    past=0
    for h in ${a:-0} ${b:-0} ${c:-0} ${d:-0}; do [ "${h}" -ge $((H + SETTLE_BLOCKS)) ] && past=$((past + 1)); done
    [ "${past}" -ge 3 ] && break
    sleep 5
done
# Room for the height probes (one per peer per 10 s) to run after the fault
say "detection window ${DETECT_WINDOW}s"
sleep "${DETECT_WINDOW}"

# ── 7. verdict ─────────────────────────────────────────────────────────
step 07-verdict
declare -a HASH HEAD FORKS METRICV TALLY
distinct=""
missing=0
for i in 1 2 3 4; do
    HEAD[i]=$(head_of "${i}")
    HASH[i]=$(hash_at "${i}" "${H}")
    [ -z "${HASH[i]}" ] && missing=$((missing + 1))
    FORKS[i]=$(docker logs "${CID[i]}" 2>&1 | grep -ac '\[FORK\]')
    METRICV[i]=$(docker exec "${CID[i]}" curl -sS -m4 http://localhost:9090/metrics 2>/dev/null |
        awk -v m="${METRIC}" '$1 == m { print $2 }')
    [ -z "${METRICV[i]}" ] && METRICV[i]="n/a"
    # The first two tallies from round H on: the failed attempt and its retry
    TALLY[i]=$(docker logs --since "${T0}" "${CID[i]}" 2>&1 |
        awk -v H="${H}" '
            match($0, /We are forging block [0-9]+/) {
                if (substr($0, RSTART + 21, RLENGTH - 21) + 0 >= H) started = 1
            }
            started && match($0, /Vote tally for block [0-9a-f]+: pro=[0-9]+, con=[0-9]+/) {
                t = substr($0, RSTART + 21, RLENGTH - 21)
                out = out (n++ ? ";" : "") substr(t, 1, 8) " " substr(t, index(t, "pro="))
                if (n == 2) exit
            }
            END { print out }
        ')
    case " ${distinct} " in *" ${HASH[i]} "*) ;; *) [ -n "${HASH[i]}" ] && distinct="${distinct} ${HASH[i]}" ;; esac
    say "node-${i}$([ "${i}" = "${A}" ] && echo ' (A)'): head ${HEAD[i]:-?} hash@${H} ${HASH[i]:-none} [FORK] lines ${FORKS[i]} ${METRIC} ${METRICV[i]} tallies ${TALLY[i]:-none}"
done
n_distinct=$(echo "${distinct}" | wc -w)
fork=no
[ "${n_distinct}" -gt 1 ] && fork=yes

detected=no
for i in 1 2 3 4; do
    if [ "${FORKS[i]}" -gt 0 ] && [ "${METRICV[i]}" != n/a ] && awk -v v="${METRICV[i]}" 'BEGIN { exit !(v > 0) }'; then
        detected=yes
    fi
done

if [ "${MODE}" = race-strict ]; then
    if [ "${fork}" = no ] && [ "${missing}" -eq 0 ]; then result=PASS
    elif [ "${fork}" = yes ] && [ "${detected}" = yes ]; then result=FORK-DETECTED
    else result=FAIL
    fi
else
    if [ "${fork}" = no ] && [ "${missing}" -eq 0 ]; then result=PASS; else result=FAIL; fi
fi

short() { [ -n "$1" ] && echo "${1:0:10}" || echo "-"; }
jq -n \
    --arg run "$(basename "${RUN_DIR}")" --arg mode "${MODE}" --arg code "${CODE:-}" \
    --arg image "${IMAGE:-}" --argjson height "${H}" --argjson nodeA "${A}" \
    --arg h1 "${HASH[1]}" --arg h2 "${HASH[2]}" --arg h3 "${HASH[3]}" --arg h4 "${HASH[4]}" \
    --arg f "${FORKS[1]},${FORKS[2]},${FORKS[3]},${FORKS[4]}" \
    --arg m "${METRICV[1]},${METRICV[2]},${METRICV[3]},${METRICV[4]}" \
    --arg fork "${fork}" --arg detected "${detected}" --arg result "${result}" \
    '{run: $run, mode: $mode, code: $code, image: $image, height: $height, nodeA: $nodeA,
      hashes: [$h1, $h2, $h3, $h4], forkLines: ($f | split(",")), metric: ($m | split(",")),
      fork: $fork, detected: $detected, result: $result}' > "${LOG_DIR}/verdict.json"

RESULTS="$(dirname "${RUN_DIR}")/results.tsv"
[ -f "${RESULTS}" ] || printf 'run\tmode\tcode\theight\tA\tn1\tn2\tn3\tn4\tfork\tforkLines\tmetric\tresult\n' > "${RESULTS}"
printf '%s\t%s\t%s\t%s\tnode-%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(basename "${RUN_DIR}")" "${MODE}" "${CODE:-}" "${H}" "${A}" \
    "$(short "${HASH[1]}")" "$(short "${HASH[2]}")" "$(short "${HASH[3]}")" "$(short "${HASH[4]}")" \
    "${fork}" "${FORKS[1]},${FORKS[2]},${FORKS[3]},${FORKS[4]}" \
    "${METRICV[1]},${METRICV[2]},${METRICV[3]},${METRICV[4]}" "${result}" >> "${RESULTS}"

say "RESULT ${result}: mode ${MODE}, height ${H}, fork ${fork}, detected ${detected}, A node-${A}"
case "${result}" in
    PASS|FORK-DETECTED) exit 0 ;;
    *) exit 1 ;;
esac
