#!/usr/bin/env bash
# Stub tests of run.sh's lockstep wait. The real helper functions are taken
# from run.sh itself (head_of ... wait_lockstep, lockstep_fail,
# lockstep_or_abort); only `rpc` is replaced by a fake that answers from files:
#   head.<node>          the head, or "empty" / "timeout" / "flaky" (empty once)
#   hash.<node>.<height> the hash (default 0xb<height>), or "empty" / "timeout" / "flaky"
# FAKE_SLEEP makes every rpc call take that many seconds.
# Usage: bash lockstep-stub.test.sh        (exit 0 when every case passes)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${HERE}/run.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ── the code under test, straight from run.sh ───────────────────────────
region() { # $1 text the first line starts with, $2 text the line after the region starts with
    awk -v a="$1" -v b="$2" 'index($0, a) == 1 { on = 1 } index($0, b) == 1 { on = 0 } on' "${RUN_SH}"
}
source <(region 'port_of() {' '# Mean and longest gap')
source <(region 'lockstep_fail() {' 'scenario_floor() {')
say() { echo "[qdrill] $*" | tee -a "${STEP_LOG}"; }

# ── the fake rpc ────────────────────────────────────────────────────────
rpc() { # $1 node, $2 JSON body, $3 curl timeout
    [ -n "${FAKE_SLEEP:-}" ] && sleep "${FAKE_SLEEP}"
    local f v n kind
    case "$2" in
        *getLastBlockNumber*) kind=head; f="${FAKE}/head.$1" ;;
        *) kind=hash; n=$(printf '%s' "$2" | sed 's/.*blockNumber":\([0-9]*\).*/\1/'); f="${FAKE}/hash.$1.${n}"
           echo "hash n$1 ${n}" >> "${FAKE}/calls" ;;
    esac
    v=$(cat "${f}" 2>/dev/null)
    if [ -z "${v}" ] && [ "${kind}" = hash ]; then v="0xb${n}"; fi
    case "${v}" in
        timeout) return 28 ;;
        empty | "") return 0 ;;
        flaky) if [ -e "${f}.seen" ]; then v=$([ "${kind}" = head ] && echo 25 || echo "0xb${n}"); else touch "${f}.seen"; return 0; fi ;;
    esac
    if [ "${kind}" = head ]; then printf '{"result":200,"response":%s}' "${v}"
    else printf '{"result":200,"response":{"hash":"%s"}}' "${v}"; fi
}

# ── a case: fresh state, heads from "n1 n2 ..." ─────────────────────────
N=13; READ_TIMEOUT=8; LOCKSTEP_TIMEOUT=12
new_case() { # $1 name, $2.. heads
    CASE="$1"; shift
    FAKE="${WORK}/${CASE}/fake"; LOG_DIR="${WORK}/${CASE}/logs"; STEP_LOG="${LOG_DIR}/step.log"
    rm -rf "${WORK:?}/${CASE}"; mkdir -p "${FAKE}" "${LOG_DIR}"; : > "${STEP_LOG}"
    UP=(); local i=0 h
    for h in "$@"; do i=$((i + 1)); echo "${h}" > "${FAKE}/head.${i}"; UP[i]=1; done
    N=${i}; FAKE_SLEEP=""; LOCKSTEP_FAIL_ON_DIVERGENCE=0
}
fails=0
check() { # $1 what, $2.. a test command
    local what="$1"; shift
    if "$@"; then echo "  ok   ${what}"; else echo "  FAIL ${what}"; fails=$((fails + 1)); fi
}
has() { grep -q -- "$1" <<< "${OUT}"; }
hashed_only() { ! grep -q "^hash n[0-9]* $1\$" "${FAKE}/calls"; } # no hash read at height $1

echo "== ok: all 13 heads equal"
new_case ok $(for i in $(seq 13); do echo 25; done)
OUT=$(wait_lockstep 7 12; echo "rc=$? h=${LOCK_HEIGHT} min=${LOCK_MIN} max=${LOCK_MAX}"); echo "${OUT}" | tail -3
check "returns 0 with h=25" has "rc=0 h=25 min=25 max=25"

echo "== ok, straddle: n1..n5 at 25, n6..n13 at 26, one hash at 25"
new_case straddle 25 25 25 25 25 26 26 26 26 26 26 26 26
OUT=$(wait_lockstep 7 12; echo "rc=$? h=${LOCK_HEIGHT} min=${LOCK_MIN} max=${LOCK_MAX}"); echo "${OUT}" | tail -3
check "returns 0 with h=25 (the minimum)" has "rc=0 h=25 min=25 max=26"
check "reads hashes at 25 only, never at 26" hashed_only 26
check "step log names h and every node's head" grep -q "at h=25 (heads 25..26: n1=25 .* n13=26 ):.*0xb25=n1,n2,n3,n4,n5,n6,n7,n8,n9,n10,n11,n12,n13" "${STEP_LOG}"

echo "== not level: a spread of 2 retries, then the exit-2 path with the summary"
new_case spread 25 25 25 25 25 25 27 27 27 27 27 27 27
OUT=$( ( lockstep_or_abort 7 ) 2>&1; echo "rc=$?" ); echo "${OUT}" | tail -4
check "exits 2" has "rc=2"
# Tries start 5 s apart in a 12 s window of whole seconds: a 2nd fits (a try
# takes well under 6 s), a 4th never does (it would start after 15 s), a 3rd only
# when the first two tries took under 1 to 2 s together
check "retried (2 or 3 tries in a 12 s window, 5 s apart)" has "after [0-9]*s, [23] tries;"
check "says the heads were apart by 2" has "apart:2 of at most 1; min 25 max 27"
check "prints ABORT" has "ABORT: the running nodes never reached one head >= 7 with one hash"

echo "== unreadable head: n4 empty twice names n4, exit 2"
new_case unreadable_head 25 25 25 empty 25 25 25 25 25 25 25 25 25
OUT=$( ( lockstep_or_abort 7 ) 2>&1; echo "rc=$?" ); echo "${OUT}" | tail -3
check "exits 2" has "rc=2"
check "names n4 as unreadable" has "unreadable: n4 "

echo "== unreadable hash: n4 empty at h twice names n4, exit 2"
new_case unreadable_hash 25 25 25 25 25 25 25 25 25 25 25 25 25
echo empty > "${FAKE}/hash.4.25"
OUT=$( ( lockstep_or_abort 7 ) 2>&1; echo "rc=$?" ); echo "${OUT}" | tail -3
check "exits 2" has "rc=2"
check "names n4:EMPTY" has "empty/timeout:  *n4:EMPTY"

echo "== unreadable hash: n9 times out at h"
new_case timeout_hash 25 25 25 25 25 25 25 25 25 25 25 25 25
echo timeout > "${FAKE}/hash.9.25"
OUT=$( ( lockstep_or_abort 7 ) 2>&1; echo "rc=$?" ); echo "${OUT}" | tail -2
check "exits 2, names n9:TIMEOUT" has "n9:TIMEOUT"

echo "== one empty read is retried: n4 head and n6 hash empty once, then fine"
new_case flaky 25 25 25 flaky 25 25 25 25 25 25 25 25 25
echo flaky > "${FAKE}/hash.6.25"
OUT=$(wait_lockstep 7 12; echo "rc=$? h=${LOCK_HEIGHT}"); echo "${OUT}" | tail -2
check "returns 0 with h=25" has "rc=0 h=25"

echo "== divergence: two hashes at h=25 is exit 1 naming both nodes"
new_case divergence 25 25 25 25 25 25 25 25 25 25 25 25 25
echo 0xfork > "${FAKE}/hash.3.25"
LOCKSTEP_FAIL_ON_DIVERGENCE=1
OUT=$( ( lockstep_or_abort 7 ) 2>&1; echo "rc=$?" ); echo "${OUT}" | tail -3
check "exits 1" has "rc=1"
check "names both hashes with their nodes" has "0xfork=n3"
check "names the other group" has "0xb25=n1,n2,n4"

echo "== divergence seen from the nodes one block ahead (straddle): n6..n13 are at 26"
new_case divergence_straddle 25 25 25 25 25 26 26 26 26 26 26 26 26
echo 0xfork > "${FAKE}/hash.10.25"
LOCKSTEP_FAIL_ON_DIVERGENCE=1
OUT=$( ( lockstep_or_abort 7 ) 2>&1; echo "rc=$?" ); echo "${OUT}" | tail -3
check "exits 1, names n10" has "rc=1"
check "names 0xfork=n10" has "0xfork=n10"

echo "== exact: heads split 25/26 are not level for fallback and partition, equal heads are"
new_case exact_split 25 25 25 25 25 26 26 26 26 26 26 26 26
OUT=$(wait_lockstep 7 12 exact; echo "rc=$?"); echo "${OUT}" | tail -2
check "rc=1 with exact" has "rc=1"
check "says apart:1, allowed 0" has "apart:1 of at most 0"
new_case exact_ok 25 25 25 25 25 25 25 25 25 25 25 25 25
OUT=$(wait_lockstep 7 12 exact; echo "rc=$? h=${LOCK_HEIGHT}"); echo "${OUT}" | tail -1
check "rc=0 with equal heads" has "rc=0 h=25"

echo "== behind: all heads level but below the floor"
new_case behind 5 5 5 5 5 5 5 5 5 5 5 5 5
OUT=$(wait_lockstep 7 8; echo "rc=$?"); echo "${OUT}" | tail -2
check "rc=1, names the nodes behind" has "behind: n1 n2"

echo "== parallel reads: every rpc call sleeps 1 s, 13 nodes"
new_case parallel $(for i in $(seq 13); do echo 25; done)
FAKE_SLEEP=1
t0=$(date +%s%N)
OUT=$(wait_lockstep 7 60; echo "rc=$? h=${LOCK_HEIGHT}")
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
echo "${OUT}" | tail -1; echo "  elapsed ${ms} ms (13 sequential reads of heads and then hashes would be 26000+, 4 at a time 8000)"
check "returns 0" has "rc=0 h=25"
check "finishes in under 8 s (more than 4 reads at a time)" test "${ms}" -lt 8000
check "takes at least 2 s (one head round, one hash round)" test "${ms}" -ge 2000

echo "== partition fork scan: an unread hash at a height every node holds is ERROR, above the lowest head it is left out"
# run.sh's own fork_scan and read_error; heights 23..26, the lowest head 25. A subshell
# so that read_error's exit ends the case: OUT is its output, then rc=
source <(region 'fork_scan() {' 'scenario_partition() {')
source <(region 'read_error() {' '# A node log whose matching')
fs_case() { new_case "$1" 25 25 25 26 26 26; PHASES="${WORK}/${CASE}/phases.tsv"; RESULT=""; DETAIL=""; }
fs_scan() {
    OUT=$( ( write_verdict() { echo "VERDICT ${RESULT}: ${DETAIL}"; }
        fork_scan 23 26 25; echo "scan done conflicts=[${FORK_CONFLICTS}]" ) 2>&1; echo "rc=$?")
    echo "${OUT}" | tail -2 | cut -c1-200 | sed 's/^/    | /'
}
reads_of() { grep -c "^hash n$1 $2\$" "${FAKE}/calls"; } # hash reads of node $1 at height $2
fs_case fs_same; fs_scan
check "all hashes read, all equal: no fork" has "scan done conflicts=\[\]"
check "all hashes read, all equal: rc=0" has "rc=0"
check "a node is read once per height (n1 at 23, n6 at 26)" test "$(reads_of 1 23)$(reads_of 6 26)" = 11
fs_case fs_fork; echo 0xfork > "${FAKE}/hash.3.24"; fs_scan
check "two hashes at 24 (<= the lowest head): fork at 24 and no other height" has "scan done conflicts=\[ 24\]"
check "two hashes at 24: rc=0 (a fork is a result, not an error)" has "rc=0"
fs_case fs_gap; echo empty > "${FAKE}/hash.4.24"; fs_scan
check "n4's hash at 24 (<= the lowest head) unread: exit 2, the scan does not finish" bash -c '! grep -q "scan done" <<< "$1" && grep -q "^rc=2$" <<< "$1"' _ "${OUT}"
check "n4's hash at 24 unread: VERDICT ERROR, phase healed" bash -c 'grep -q "VERDICT ERROR: healed: node unreadable" <<< "$1" && grep -q "^healed" "$2"' _ "${OUT}" "${PHASES}"
fs_case fs_gap_timeout; echo timeout > "${FAKE}/hash.2.23"; fs_scan
check "n2's hash at 23 times out: exit 2, ERROR" bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "VERDICT ERROR" <<< "$1"' _ "${OUT}"
fs_case fs_above; echo empty > "${FAKE}/hash.1.26"; fs_scan
check "n1's hash at 26 (above the lowest head) unread: left out, no fork" has "scan done conflicts=\[\]"
check "n1's hash at 26 unread: rc=0" has "rc=0"
fs_case fs_above_fork; echo empty > "${FAKE}/hash.1.26"; echo 0xfork > "${FAKE}/hash.5.26"; echo 0xother > "${FAKE}/hash.6.26"; fs_scan
check "n1 unread at 26, n5 and n6 differ there: fork at 26 still found" has "scan done conflicts=\[ 26\]"

echo "== database reads (psql_node, block_rows) are bounded; a timed-out read is a failure, not an empty result"
fn_src() { # $1 function name: its definition, from `name() {` to the first line that is `}`
    awk -v a="$1() {" 'index($0, a) == 1 { on = 1 } on { print } on && /^}/ { exit }' "${RUN_SH}"
}
for f in pg_cid psql_node pg_limit_preflight pg_limit_gate; do source <(fn_src "${f}"); done
source <(grep -E '^(DB_TIMEOUT_S|PG_LIMITS)=' "${RUN_SH}")
source <(region 'block_rows() {' 'phase_row() {')
# run.sh's own dc: every compose call goes to the fake docker
source <(grep -E '^dc\(\) ' "${RUN_SH}")
RUN_DIR="${WORK}/run"; PROJECT=qdrill-stub
mkdir -p "${WORK}/bin"
# docker exec ... psql: FAKE_DB is rows (default), hang, killed (SIGKILL, nothing on
# stderr), stmt (the server cancels the query) or toomany (the server is out of
# connections); SHOW max_connections
# answers FAKE_MAXCONN (default 100, the postgres default). An exec with an empty
# container fails, as docker's does.
# The postgres lookup, `compose ... ps -q postgres`, answers fakepg; FAKE_PGPS
# makes it hang (sleep 60 s), hang-once (only the first lookup of a case), empty
# (no running container) or fail (a daemon error).
# The node logs: `compose ... ps -aq node-<n>` (and `ps -q`) answers cid<n> (nothing when
# FAKE/nocontainer.<n> exists), `logs ... cid<n>` prints FAKE/nodelog.<n> (its
# last lines with --tail; no file: an empty log), after sleeping the seconds in
# FAKE/nodelog.<n>.hang, or fails as a daemon error when FAKE/nodelog.<n>.fail exists.
# A fake log holds no NUL byte: the fake reads it into a bash variable, which would
# cut the log off at its first NUL (--tail all) or drop the NUL bytes (--tail N).
# Cut off by its reader, it exits 141 as if it died of SIGPIPE, as the docker CLI
# does whether SIGPIPE is ignored or not: a Go program that gets EPIPE on stdout
# raises SIGPIPE with its default action. The fake's printf dies of SIGPIPE, or
# where SIGPIPE is ignored fails with EPIPE, and in bash a SIGPIPE that came in
# ignored cannot be unignored, so the fake exits 141 instead of raising it
cat > "${WORK}/bin/docker" <<'FAKEDOCKER'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_DOCKER_LOG}"
case "$*" in "exec "*"  psql "*) echo "Error response from daemon: No such container: " >&2; exit 1 ;; esac
case "$*" in *"SHOW max_connections"*) echo "${FAKE_MAXCONN:-100}"; exit 0 ;; esac
case "$1" in
    compose)
        case "$*" in
            *" ps -aq node-"* | *" ps -q node-"*) n=${@: -1}; n=${n#node-}; [ -e "${FAKE}/nocontainer.${n}" ] || echo "cid${n}"; exit 0 ;;
            *" ps -q postgres")
                case "${FAKE_PGPS:-}" in
                    hang) sleep 60 ;;
                    hang-once) [ -e "${FAKE}/pgps.seen" ] || { touch "${FAKE}/pgps.seen"; sleep 60; } ;;
                    empty) exit 0 ;;
                    fail) echo "Error response from daemon: stub: compose ps failed" >&2; exit 1 ;;
                esac
                echo fakepg; exit 0 ;;
        esac ;;
    logs)
        n=${@: -1}; n=${n#cid}; tail=all
        [ "$2" = --tail ] && tail=$3
        [ -e "${FAKE}/nodelog.${n}.hang" ] && sleep "$(cat "${FAKE}/nodelog.${n}.hang")"
        [ -e "${FAKE}/nodelog.${n}.fail" ] && { echo "Error response from daemon: stub: cannot read the log of cid${n}" >&2; exit 1; }
        [ -e "${FAKE}/nodelog.${n}" ] || exit 0
        # The log is taken into a variable first, then written by bash's own printf:
        # no cat or tail faces the reader, so what happens when it stops reading
        # does not depend on the coreutils on the PATH (GNU cat fails on EPIPE; uutils
        # cat 0.12.0 exits 0 without a word, and the cat of the ubuntu-26.04 CI runner
        # appears to behave the same)
        if [ "${tail}" = all ]; then
            IFS= read -r -d '' out < "${FAKE}/nodelog.${n}"
        else
            out=$(LC_ALL=C tail -n "${tail}" "${FAKE}/nodelog.${n}"; echo x); out=${out%x}
        fi
        # printf is killed by SIGPIPE where it is not ignored, and where it is ignored
        # fails with EPIPE: docker's 141 then
        printf '%s' "${out}" 2> /dev/null || exit 141
        exit 0 ;;
esac
case "${FAKE_DB:-rows}" in
    hang) sleep 30 ;;
    killed) kill -KILL $$ ;;
    stmt) echo "ERROR:  canceling statement due to statement timeout" >&2; exit 1 ;;
    toomany) echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  sorry, too many clients already' >&2; exit 2 ;;
    *) printf '5|0xb5|7\n6|0xb6|8\n' ;;
esac
FAKEDOCKER
chmod +x "${WORK}/bin/docker"
export FAKE_DOCKER_LOG="${WORK}/docker.log" FAKE
PATH="${WORK}/bin:${PATH}"
check "run.sh bounds its database calls at 30 s" test "${DB_TIMEOUT_S}" = 30
# The bounds the stub runs under from here on (DB_TIMEOUT_S, LOG_READ_TIMEOUT_S)
# are 3 s, except where every call stalls: a call the stub answers ends in
# milliseconds and must not be taken for a stalled one when the host is slow. A
# call that stalls sleeps 30 s or more, and a time limit on it is half that or less
new_case dbread 25; DB_TIMEOUT_S=3

: > "${FAKE_DOCKER_LOG}"
OUT=$(FAKE_DB=rows block_rows 5 6 1 2 2>&1; echo "rc=$?"); echo "${OUT}" | tail -2 | cut -c1-300
check "an answered read gives the rows of both nodes" has '"node":2,"number":6,"hash":"0xb6","signatures":8'
check "and rc=0" has "rc=0"
check "the query runs with a server-side statement_timeout" grep -q "PGOPTIONS=-c statement_timeout=20000" "${FAKE_DOCKER_LOG}"
check "and a connect timeout" grep -q "PGCONNECT_TIMEOUT=10" "${FAKE_DOCKER_LOG}"

t0=$(date +%s%N)
OUT=$(FAKE_DB=hang block_rows 5 6 1 2>&1; echo "rc=$?")
ms=$(( ($(date +%s%N) - t0) / 1000000 )); echo "${OUT}" | tail -3 | cut -c1-200; echo "  elapsed ${ms} ms (the fake docker sleeps 30 s)"
check "a read that hangs fails (rc=1)" has "rc=1"
check "and says which node, and that it got no answer" has "psql node1_db: no answer within 3s"
check "and the block rows message names node-1" has "of node-1 could not be read"
check "within DB_TIMEOUT_S, not 30" test "${ms}" -lt 15000

OUT=$(FAKE_DB=stmt block_rows 5 6 1 2>&1; echo "rc=$?")
check "a query the server cancels fails too (rc=1), with the server's reason shown" has "canceling statement due to statement timeout"
check "(rc=1 for the cancelled query)" has "rc=1"

# What the run does with that failure: every block_rows call ends the run as exit 2
calls=$(grep -c '\$(block_rows ' "${RUN_SH}")
guarded=$(grep '\$(block_rows ' "${RUN_SH}" | grep -c '|| { say "ABORT: .*; exit 2; }')
check "all ${calls} block_rows calls end the run with ABORT and exit 2 when the read fails" test "${calls}" -ge 4 -a "${calls}" = "${guarded}"
unbounded=$(grep -n 'docker exec .*psql ' "${RUN_SH}" | grep -v 'timeout "${DB_TIMEOUT_S}" docker exec ' || true)
check "every psql that run.sh execs is bounded by DB_TIMEOUT_S${unbounded:+ (not: ${unbounded})}" test -z "${unbounded}"

echo "== postgres connection limit: the preflight refuses a server below what N nodes need"
# need = 10 x N + 20 (drill_inputs.py pgconn); the compose sets 2 x 10 x N + 20
for spec in "4 100 ok" "10 220 ok" "13 280 ok" "13 100 refused" "10 100 refused" "13 149 refused" "13 150 ok"; do
    set -- ${spec}
    N=$1
    OUT=$(FAKE_MAXCONN=$2 pg_limit_preflight 2>&1; echo "rc=$?")
    if [ "$3" = ok ]; then
        check "N=$1, max_connections $2: accepted" has "rc=0"
    else
        check "N=$1, max_connections $2: refused (rc=1) with the numbers" has "could not run: postgres max_connections is $2, $1 nodes need $((10 * $1 + 20))"
        check "N=$1, max_connections $2: exits non-zero" has "rc=1"
    fi
done

echo "== postgres connection limit: 'too many clients' never ends in a pass or a fail"
# The gate's real log reads (and grep_logs, the reader it used up to ef47fe4c19)
# against the fake docker: a case has 13 started nodes whose logs are FAKE/nodelog.<n>
for f in pg_gate_unreadable grep_logs teardown; do source <(fn_src "${f}"); done
write_verdict() { echo "VERDICT ${RESULT}: ${DETAIL}"; }
gate_case() { # $1 name, $2 the result before the gate
    new_case "$1" 25; N=13; STARTED=(); for i in $(seq 1 13); do STARTED[i]=1; done
    RESULT=$2; DETAIL="phases fine"; PG_GATE_PASSED=0
}
for verdict in PASS FAIL; do
    gate_case gate_clean "${verdict}"
    echo "FATAL: nothing wrong" > "${FAKE}/nodelog.1"
    OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
    check "no hit, ${verdict}: the gate lets it through" has "rc=0"
    check "no hit, ${verdict}: and writes nothing" test "$(grep -c VERDICT <<< "${OUT}")" = 0

    gate_case gate_nodes "${verdict}"
    printf 'ok line\nerror: sorry, too many clients already\n' > "${FAKE}/nodelog.7"
    printf 'FATAL:  sorry, too many clients already\n' > "${FAKE}/nodelog.11"
    OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
    check "node logs hit, ${verdict}: exit 2" has "rc=2"
    check "node logs hit, ${verdict}: says could not run: postgres connection limit hit" has "ABORT: could not run: postgres connection limit hit (2 'too many clients' lines; node-11 node-7 )"
    check "node logs hit, ${verdict}: the verdict is ERROR and keeps what the result was" has "VERDICT ERROR: could not run: postgres connection limit hit (2 lines in node-11 node-7); the result was ${verdict}"
done

gate_case gate_psql PASS; DB_TIMEOUT_S=3
OUT=$(FAKE_DB=toomany psql_node 3 "SELECT 1" 2>&1; echo "rc=$?")
check "a psql_node read refused for connections still fails (rc=2) and shows the server's words" has "too many clients already"
check "(psql's own exit code is passed on)" has "rc=2"
check "and is recorded in psql-errors.log, with the database" grep -q "psql node3_db: .*too many clients already" "${LOG_DIR}/psql-errors.log"
OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
check "a harness read that hit the limit, node logs clean: the gate exits 2" has "rc=2"
check "and says so" has "postgres connection limit hit (1 'too many clients' lines; harness psql reads only)"
gate_case gate_psql_ok PASS; DB_TIMEOUT_S=3
FAKE_DB=stmt psql_node 3 "SELECT 1" > /dev/null 2>&1
OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
check "another psql error is not a connection-limit hit" has "rc=0"

# Every file write of a command fails, as on a full disk: past a file size limit
# of WRITE_LIMIT blocks (default 0), with SIGXFSZ ignored so that the write
# fails (EFBIG, as ENOSPC would) and no process is killed
unwritable() { ( trap '' XFSZ; ulimit -f "${WRITE_LIMIT:-0}"; "$@" ); }
gate_case gate_psql_unwritten PASS; DB_TIMEOUT_S=3
OUT=$(FAKE_DB=toomany unwritable psql_node 3 "SELECT 1" 2>&1; echo "rc=$?")
check "a psql_node read refused for connections, its errors written nowhere: still rc=2" has "^rc=2$"
check "and says they are not in psql-errors.log" has "psql node3_db: its errors could not be written to ${LOG_DIR}/psql-errors.log"
OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
check "the gate then exits 2, not 0, with a verdict of ERROR naming the file psql_node kept" \
    has "VERDICT ERROR: could not run: could not read ${LOG_DIR}/psql-errors.log to check for the postgres connection limit (psql errors not written to it, kept in ${LOG_DIR}/psql-err\."
gate_case gate_psql_append PASS; head -c 4096 /dev/zero | tr '\0' '\n' > "${LOG_DIR}/psql-errors.log"
FAKE_DB=toomany WRITE_LIMIT=1 unwritable psql_node 3 "SELECT 1" > /dev/null 2>&1
check "only the append to psql-errors.log fails (it is over the limit): psql_node keeps the errors" \
    bash -c 'grep -q "too many clients" "$1"/psql-err.*' _ "${LOG_DIR}"
OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
check "and the gate exits 2" has "^rc=2$"
check "a psql refused for connections, its errors written nowhere: not taken for one that gave none" \
    bash -c '! grep -q "none given" "$1"/psql-err.* 2>/dev/null' _ "${WORK}/gate_psql_unwritten/logs"
gate_case gate_psql_killed PASS; DB_TIMEOUT_S=3
OUT=$(FAKE_DB=killed psql_node 3 "SELECT 1" 2>&1; echo "rc=$?")
echo "${OUT}" | cut -c1-220 | sed 's/^/    | /'
check "a psql killed with nothing on stderr: its exit status is passed on (137)" has "^rc=137$"
check "and says the error text was none given, with the exit status" has "^psql node3_db: exit 137, error text: none given (${LOG_DIR}/psql-err\.[A-Za-z0-9]* is kept)$"
check "not that its errors could not be written" eval '! has "could not be written"'
check "the file it keeps says so too" grep -qx "psql node3_db: exit 137, error text: none given" "${LOG_DIR}"/psql-err.*
OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
check "the gate then exits 2, as for errors that could not be written" has "^rc=2$"

echo "== the gate fails closed: a node log it cannot read whole is exit 2, never a pass or a fail"
check "run.sh bounds each docker call of a node-log read at 60 s" test "${LOG_READ_TIMEOUT_S:-unset}" = 60
QDRILL_TEST_LOG_READ_TIMEOUT_S=3 source <(grep -E '^LOG_READ_TIMEOUT_S=' "${RUN_SH}")
check "QDRILL_TEST_LOG_READ_TIMEOUT_S sets the bound (3 s here)" test "${LOG_READ_TIMEOUT_S:-unset}" = 3
gate() { # pg_limit_gate in a subshell: OUT, and ms it took
    local t0; t0=$(date +%s%N)
    OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
}
for verdict in PASS FAIL; do
    gate_case gate_unread "${verdict}"; echo "clean" > "${FAKE}/nodelog.1"; touch "${FAKE}/nodelog.3.fail"
    gate
    echo "${OUT}" | tail -2 | cut -c1-220 | sed 's/^/    | /'
    check "docker logs fails for node-3, ${verdict}: exit 2" has "rc=2"
    check "docker logs fails for node-3, ${verdict}: the verdict is ERROR, names node-3 and docker's words, keeps the result" \
        has "VERDICT ERROR: could not run: could not read the log of node-3 to check for the postgres connection limit (docker logs failed (exit 1): Error response from daemon: stub: cannot read the log of cid3); the result was ${verdict}"
done
gate_case gate_hang PASS; echo 30 > "${FAKE}/nodelog.2.hang"
gate
echo "${OUT}" | tail -2 | cut -c1-220 | sed 's/^/    | /'
check "docker logs stalls for node-2: exit 2" has "rc=2"
check "docker logs stalls for node-2: says it did not finish within the bound" has "could not read the log of node-2 to check for the postgres connection limit (docker logs did not finish within 3s)"
check "docker logs stalls for node-2: the gate returns within the bound (${ms} ms; the stub sleeps 30 s)" test "${ms}" -lt 15000
gate_case gate_nocontainer PASS; touch "${FAKE}/nocontainer.5"
gate
check "a started node with no container: exit 2, its log is unreadable" has "could not read the log of node-5 to check for the postgres connection limit (no container)"
gate_case gate_big PASS; head -c 300 /dev/zero | tr '\0' x > "${FAKE}/nodelog.4"
OUT=$( ( LOG_READ_MAX_BYTES=200; pg_limit_gate ) 2>&1; echo "rc=$?" )
check "a log over LOG_READ_MAX_BYTES (200 here): exit 2, not read as a whole log" has "could not read the log of node-4 to check for the postgres connection limit (the log is over 200 bytes)"
gate_case gate_psql_unread PASS; mkdir "${LOG_DIR}/psql-errors.log"
gate
check "psql-errors.log there but unreadable: exit 2" has "could not read ${LOG_DIR}/psql-errors.log to check for the postgres connection limit (grep failed)"
gate_case gate_unstarted PASS; STARTED[13]=0; touch "${FAKE}/nodelog.13.fail"
gate
check "a node that was never started is not read: rc=0" has "rc=0"
gate_case gate_hit_unread PASS; echo "FATAL:  sorry, too many clients already" > "${FAKE}/nodelog.2"; touch "${FAKE}/nodelog.9.fail"
gate
check "a hit in one log and another log unreadable: exit 2" has "rc=2"
# Node-7, the one started, logged a hit and its copy cannot be written. Up to
# 8b065d3753 the read gave 0 for the empty copy, and the gate passed.
gate_case gate_unwritten PASS; STARTED=(); STARTED[7]=1; echo "FATAL:  sorry, too many clients already" > "${FAKE}/nodelog.7"
OUT=$(unwritable read_node_log 7 "${LOG_DIR}/copy.log" 2> /dev/null; echo "rc=$?")
check "node-7's log holds a hit, its copy cannot be written: the read fails (rc=1) and says why" \
    test "${OUT}" = "could not write the copy to ${LOG_DIR}/copy.log"$'\n'"rc=1"
gate_then() { pg_limit_gate; echo "gate returned $? PG_GATE_PASSED=${PG_GATE_PASSED}"; }
OUT=$(unwritable gate_then 2>&1; echo "rc=$?")
echo "${OUT}" | grep -E 'VERDICT|gate returned|^rc=' | cut -c1-220 | sed 's/^/    | /'
check "the same in the gate: exit 2, the verdict is ERROR and says the copy could not be written" \
    bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "VERDICT ERROR: could not run: could not read the log of node-7 to check for the postgres connection limit (could not write the copy to $2); the result was PASS" <<< "$1"' \
    _ "${OUT}" "${LOG_DIR}/pg-gate.tmp"
check "the same in the gate: it does not pass" bash -c '! grep -q "PG_GATE_PASSED=1" <<< "$1"' _ "${OUT}"
gate
check "the copy written: the gate finds the hit (exit 2)" has "postgres connection limit hit (1 'too many clients' lines; node-7 )"
# At the cap head stops reading: sed and docker, still writing 1 MiB, die of SIGPIPE
gate_case gate_big_pipe PASS; yes 'a log line' 2> /dev/null | head -c 1048576 > "${FAKE}/nodelog.4"
OUT=$( ( LOG_READ_MAX_BYTES=200; pg_limit_gate ) 2>&1; echo "rc=$?" )
check "a 1 MiB log over LOG_READ_MAX_BYTES (200 here): still read as over it, not as a failed sed or docker" \
    has "could not read the log of node-4 to check for the postgres connection limit (the log is over 200 bytes)"

echo "== grep_logs: a node log it cannot read whole fails the read and is named, within the bound"
gl_case() { gate_case "$1" PASS; printf 'x below the quorum of 7\n' > "${FAKE}/nodelog.3"; printf 'y below the quorum of 7\n' > "${FAKE}/nodelog.9"; }
gl() { local t0; t0=$(date +%s%N); OUT=$(grep_logs "below the quorum" 2> "${LOG_DIR}/gl.err"; echo "rc=$?"); ERR=$(cat "${LOG_DIR}/gl.err"); ms=$(( ($(date +%s%N) - t0) / 1000000 )); }
gl_case gl_read; gl
check "every log read: rc=0, each matching line once with its node" test "${OUT}" = $'node-3: x below the quorum of 7\nnode-9: y below the quorum of 7\nrc=0'
gl_case gl_fail; touch "${FAKE}/nodelog.5.fail"; gl
check "node-5's docker logs fails: rc=1, the lines of the logs read still given" test "${OUT}" = $'node-3: x below the quorum of 7\nnode-9: y below the quorum of 7\nrc=1'
check "node-5's docker logs fails: stderr names node-5" grep -q "WARN: node-5: docker logs failed (exit 1), its log not read whole" <<< "${ERR}"
gl_case gl_hang; echo 30 > "${FAKE}/nodelog.9.hang"; gl
check "node-9's docker logs stalls: rc=1, stderr names node-9 and the bound" \
    bash -c 'grep -q "^rc=1$" <<< "$1" && grep -q "WARN: node-9: docker logs did not answer within 3s, its log not read whole" <<< "$2"' _ "${OUT}" "${ERR}"
check "node-9's docker logs stalls: returns within the bound (${ms} ms; the stub sleeps 30 s)" test "${ms}" -lt 15000
# The display-only reads (`grep_logs ... | head -N`): head stops reading, and
# grep_logs drains the rest so that docker is not cut off. Up to 74a076ea48 docker
# died of SIGPIPE then, a WARN on a healthy run, and up to b4ccfffd3f still where
# SIGPIPE is ignored (run this file under `trap '' PIPE` to see that case)
glh() { OUT=$(grep_logs "$1" 2> "${LOG_DIR}/gl.err" | head -1; echo "rc=${PIPESTATUS[0]}"); ERR=$(cat "${LOG_DIR}/gl.err"); }
big_log() { yes "z below the quorum of 7" 2> /dev/null | head -c 1048576 > "${FAKE}/nodelog.$1"; }
gl_case gl_head; big_log 3
OUT=$(bdocker logs --since 0 cid3 | head -1 > /dev/null; echo "${PIPESTATUS[0]}")
# SIGPIPE as this shell got it (Linux: SigIgn of /proc/<pid>/status, bit 13 - 1)
sigpipe=$(awk '/^SigIgn:/ { print $2 }' "/proc/$$/status" 2> /dev/null)
sigpipe=$( (( 0x${sigpipe:-0} & 0x1000 )) && echo ignored || echo default)
check "(the fake docker logs of a 1 MiB log, cut off by head -1, exits 141 as docker does, SIGPIPE ${sigpipe} here: exit ${OUT})" test "${OUT}" = 141
glh "below the quorum"
check "| head -1 on a 1 MiB log of matching lines: the first line, rc=0" test "${OUT}" = $'node-3: z below the quorum of 7\nrc=0'
check "| head -1 on a 1 MiB log of matching lines: no WARN" test -z "${ERR}"
gl_case gl_head_fail; big_log 3; touch "${FAKE}/nodelog.5.fail"; glh "below the quorum"
check "| head -1, node-5's docker logs fails: rc=1, stderr names node-5 and only node-5" \
    bash -c 'grep -q "^rc=1$" <<< "$1" && [ "$2" = "[qdrill] WARN: node-5: docker logs failed (exit 1), its log not read whole" ]' _ "${OUT}" "${ERR}"
gl_case gl_head_hang; big_log 3; echo 30 > "${FAKE}/nodelog.9.hang"; glh "below the quorum"
check "| head -1, node-9's docker logs stalls after head stopped reading: a timeout, not a SIGPIPE (rc=1, named with the bound)" \
    bash -c 'grep -q "^rc=1$" <<< "$1" && [ "$2" = "[qdrill] WARN: node-9: docker logs did not answer within 3s, its log not read whole" ]' _ "${OUT}" "${ERR}"
# The counting callers (scenario_floor, listed-below-q) read through tee and wc, which
# read to the end: docker is never cut off there, and a failed read fails the count
count() { OUT=$(lines=$(grep_logs "$1" 2> "${LOG_DIR}/gl.err" | tee -a "${STEP_LOG}" | wc -l) || echo "log_read_error"; echo "lines=${lines}"); ERR=$(cat "${LOG_DIR}/gl.err"); }
gl_case gl_count; big_log 3; count "below the quorum"
check "a count over a 1 MiB log: every matching line, no error" test "${OUT}" = "lines=$(( $(grep -c "below the quorum" "${FAKE}/nodelog.3") + 1 ))"
gl_case gl_count_fail; big_log 3; touch "${FAKE}/nodelog.5.fail"; count "below the quorum"
check "a count, node-5's docker logs fails: log_read_error" grep -q "^log_read_error$" <<< "${OUT}"
gl_case gl_count_hang; echo 30 > "${FAKE}/nodelog.9.hang"; count "below the quorum"
check "a count, node-9's docker logs stalls: log_read_error, named with the bound" \
    bash -c 'grep -q "^log_read_error$" <<< "$1" && grep -q "WARN: node-9: docker logs did not answer within 3s" <<< "$2"' _ "${OUT}" "${ERR}"
# docker cut off inside grep_logs, by a grep that stops reading, is lines missing
gl_case gl_count_grep; big_log 3; count "("
check "a count whose grep refuses the pattern: docker, cut off by it, is a failed read (log_read_error, node-3 named)" \
    bash -c 'grep -q "^log_read_error$" <<< "$1" && grep -q "WARN: node-3: docker logs failed (exit 141), its log not read whole" <<< "$2"' _ "${OUT}" "${ERR}"
# A short log can be in the pipe before grep stops: docker exits 0 then, and the
# status of grep (2) or of the sed it cut off is what says lines are missing
gl_case gl_count_grep_short; count "("
check "a count whose grep refuses the pattern, on short logs: a failed read too (log_read_error, node-3 and node-9 named)" \
    bash -c 'grep -q "^log_read_error$" <<< "$1" && grep -q "WARN: node-3: " <<< "$2" && grep -q "WARN: node-9: " <<< "$2"' _ "${OUT}" "${ERR}"

echo "== stop_mid_round: no round start seen (a read that fails or stalls, or none in time) is ERROR, exit 2, and no node is stopped"
for f in stop_mid_round round_start_error; do source <(fn_src "${f}"); done
source <(grep -E '^event\(\) ' "${RUN_SH}")
# run.sh's value with CONSENSUS_TIME unset, whatever the caller exports; the checks below use it
ROUND_START_WAIT_S=$(bash -c 'unset CONSENSUS_TIME; source <(grep -E "^ROUND_START_WAIT_S=" "$1"); echo "${ROUND_START_WAIT_S:-unset}"' _ "${RUN_SH}")
check "run.sh waits up to 60 s for a round start" test "${ROUND_START_WAIT_S}" = 60
check "run.sh waits 3 rounds (180 s) for a round start when CONSENSUS_TIME=60" \
    bash -c 'CONSENSUS_TIME=60; source <(grep -E "^ROUND_START_WAIT_S=" "$1"); test "${ROUND_START_WAIT_S:-unset}" = 180' _ "${RUN_SH}"
smr_case() { # $1 name: 13 nodes up, node-1 (the watcher) at head 25 and its log $2
    gate_case "$1" PASS; UP=(); for i in $(seq 1 13); do UP[i]=1; done
    EVENTS="${LOG_DIR}/events.log"; : > "${EVENTS}"; : > "${FAKE_DOCKER_LOG}"; printf "$2" > "${FAKE}/nodelog.1"
}
smr() { # stop_mid_round 7 1 in a subshell: OUT (its output, then rc=), ms it took
    local t0; t0=$(date +%s%N)
    OUT=$( ( stop_mid_round 7 1; echo "returned, STOP_HEIGHT=${STOP_HEIGHT}" ) 2>&1; echo "rc=$?" )
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
}
stopped7() { grep -q " stop -t 0 node-7$" "${FAKE_DOCKER_LOG}"; }
smr_error() { # $1 why: ERROR and exit 2 saying it, the verdict ERROR, node-7 not stopped
    grep -q "^rc=2$" <<< "${OUT}" &&
        has "ERROR: stop node-7: no round start seen on node-1 ($1); node-7 not stopped" &&
        has "VERDICT ERROR: phases fine stop node-7: round start unseen on node-1 ($1)$" &&
        grep -q "round start not seen on node-1 ($1): node-7 not stopped" "${EVENTS}" && ! stopped7
}
smr_case smr_seen 'We are forging block 25\n\e[32m[INFO] We are forging block 26\e[0m\nWe are forging block 27\n'
smr
check "a round past head 25 starts on node-1: node-7 is stopped, STOP_HEIGHT=25" \
    bash -c 'grep -q "^returned, STOP_HEIGHT=25$" <<< "$1" && grep -q "^rc=0$" <<< "$1" && grep -q " stop -t 0 node-7$" "$2"' _ "${OUT}" "${FAKE_DOCKER_LOG}"
check "and the event names the first round start past 25" grep -q "^[0-9:]* round start seen on node-1: We are forging block 26$" "${EVENTS}"
smr_case smr_fail 'We are forging block 26\n'; touch "${FAKE}/nodelog.1.fail"; smr
echo "${OUT}" | grep -E 'ERROR|^rc=' | cut -c1-220 | sed 's/^/    | /'
check "node-1's docker logs fails: ERROR, exit 2, node-7 not stopped" smr_error "docker logs failed (exit 1)"
smr_case smr_hang 'We are forging block 26\n'; echo 30 > "${FAKE}/nodelog.1.hang"; smr
check "node-1's docker logs stalls: ERROR naming the bound, exit 2, node-7 not stopped" smr_error "docker logs did not answer within 3s"
check "node-1's docker logs stalls: within the bound (${ms} ms; the stub sleeps 30 s)" test "${ms}" -lt 15000
smr_case smr_nocontainer 'We are forging block 26\n'; touch "${FAKE}/nocontainer.1"; smr
check "node-1 has no container: ERROR, exit 2, node-7 not stopped" smr_error "no container"
smr_case smr_none 'We are forging block 24\nWe are forging block 25\n'; ROUND_START_WAIT_S=2; smr; ROUND_START_WAIT_S=60
check "no round past 25 within ROUND_START_WAIT_S (2 s here): ERROR, exit 2, node-7 not stopped" smr_error "no round past 25 started within 2s"
# SECONDS counts whole seconds of the clock: a 2 s deadline comes 1 to 2 s on
check "and it waited for the deadline, not past it (${ms} ms)" bash -c '[ "$1" -ge 1000 ] && [ "$1" -lt 10000 ]' _ "${ms}"

echo "== teardown backstop: an exit 0 or 1 the gate did not clear is exit 2 when a node log cannot be collected"
teardown_rc() { # $1 the status run.sh exits with, $2 unwritable (as above): OUT, the status after teardown, and ms it took
    local t0; t0=$(date +%s%N)
    OUT=$( ( STARTED_STACK=1; SIDECARS=(); [ "${2:-}" = unwritable ] && { trap '' XFSZ; ulimit -f 0; }; (exit "$1"); teardown ) 2>&1; echo "rc=$?" )
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
}
for st in 0 1; do
    gate_case td_unread PASS; touch "${FAKE}/nodelog.2.fail"
    teardown_rc "${st}"
    echo "${OUT}" | grep -E 'ABORT|^rc=' | cut -c1-220 | sed 's/^/    | /'
    check "exit ${st}, node-2's log cannot be collected: exit 2" has "rc=2"
    check "exit ${st}, node-2's log cannot be collected: says why" \
        has "ABORT: could not run: could not read node-2 (docker logs failed (exit 1): Error response from daemon: stub: cannot read the log of cid2) to check for the postgres connection limit (exit ${st} replaced by 2)"
done
gate_case td_hang PASS; echo 30 > "${FAKE}/nodelog.4.hang"
teardown_rc 0
check "exit 0, node-4's log read stalls: exit 2, within the bound (${ms} ms; the stub sleeps 30 s)" bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "node-4 (docker logs did not finish within 3s)" <<< "$1" && [ "$2" -lt 15000 ]' _ "${OUT}" "${ms}"
gate_case td_cleared PASS; PG_GATE_PASSED=1; touch "${FAKE}/nodelog.2.fail"
teardown_rc 0
check "exit 0 after the gate cleared every log: a failed collection leaves it 0" has "rc=0"
check "and is still named, with why" has "WARN: logs not collected whole: node-2 (docker logs failed (exit 1): "
gate_case td_hit FAIL; printf 'FATAL:  sorry, too many clients already\n' > "${FAKE}/nodelog.7"
teardown_rc 1
check "exit 1 with a hit in the collected node-7 log: exit 2, as before" has "postgres connection limit hit (exit 1 replaced by 2"
check "and node-7.log holds the collected log" grep -q "too many clients" "${LOG_DIR}/node-7.log"
gate_case td_clean PASS; echo "clean" > "${FAKE}/nodelog.1"
teardown_rc 0
check "exit 0, every log collected and clean: exit 0" has "rc=0"
for st in 0 1; do
    gate_case td_unwritten FAIL; STARTED=(); STARTED[7]=1; echo "FATAL:  sorry, too many clients already" > "${FAKE}/nodelog.7"
    teardown_rc "${st}" unwritable
    echo "${OUT}" | grep -E 'ABORT|^rc=' | cut -c1-220 | sed 's/^/    | /'
    check "exit ${st}, the gate not passed, node-7's log holds a hit and its copy cannot be written: exit 2, saying why" \
        bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "ABORT: could not run: could not read node-7 (could not write the copy to $2) to check for the postgres connection limit (exit $3 replaced by 2)" <<< "$1"' \
        _ "${OUT}" "${LOG_DIR}/node-7.log" "${st}"
done
gate_case td_psql_kept FAIL; DB_TIMEOUT_S=3; FAKE_DB=toomany unwritable psql_node 3 "SELECT 1" > /dev/null 2>&1
teardown_rc 1
check "exit 1, psql errors psql_node could not write to psql-errors.log: exit 2, naming the file that keeps them" \
    has "could not read psql-errors.log (psql errors not written to it, kept in psql-err\.[A-Za-z0-9]*) to check for the postgres connection limit (exit 1 replaced by 2)"

echo "== teardown backstop after the verdict: an exit it replaces by 2 makes verdict.json and results.tsv ERROR too"
for f in results_row rewrite_verdict; do source <(fn_src "${f}"); done
source <(grep -E '^RESULTS_LOCK_WAIT_S=' "${RUN_SH}")
# The end of run.sh as it runs: the EXIT trap, pg_limit_gate, the real
# write_verdict, exit 0 on PASS or 1, then teardown. $3 late: node-6 logs a hit
# after the verdict is written; unwritable: so does node-6, and verdict.json is
# not JSON and results.tsv is gone by then. results.tsv holds an earlier run's
# row first. OUT: stdout then rc=; ERR: stderr.
end_case() { # $1 name, $2 the result before the gate, $3 late, unwritable or none
    gate_case "$1" "$2"; echo "clean" > "${FAKE}/nodelog.1"
    RUNS_DIR="${WORK}/$1/runs"; mkdir -p "${RUNS_DIR}"
    printf 'run\tscenario\tbinding\tN\tshardSize\tq\tcode\tdetail\tresult\nearlier\tfloor\ton\t4\t10\t7\timage\tfine\tPASS\n' > "${RUNS_DIR}/results.tsv"
    OUT=$( (
        for f in write_verdict verdict_json; do source <(fn_src "${f}"); done; source <(grep -E '^step\(\) ' "${RUN_SH}")
        RUN_ID="stub-$1"; SCENARIO=drop-n10s10; BINDING=on; SHARD=10; Q=7; CODE=image; IMAGE=stub; FORK_SET=devnet; EXCLUDED_FORKS='{}'
        PHASES="${LOG_DIR}/phases.tsv"; EVENTS="${LOG_DIR}/events.log"; : > "${PHASES}"; STARTED_STACK=1; SIDECARS=()
        trap teardown EXIT
        pg_limit_gate
        write_verdict
        [ "$3" != none ] && printf 'FATAL:  sorry, too many clients already\n' > "${FAKE}/nodelog.6"
        [ "$3" = unwritable ] && { echo "not json" > "${LOG_DIR}/verdict.json"; rm "${RUNS_DIR}/results.tsv"; }
        [ "${RESULT}" = PASS ] && exit 0
        exit 1
    ) 2> "${LOG_DIR}/stderr"; echo "rc=$?" )
    ERR=$(cat "${LOG_DIR}/stderr")
}
verdict_is() { jq -e --arg r "$1" --arg d "$2" '.result == $r and .detail == $d' "${LOG_DIR}/verdict.json" > /dev/null; }
tsv_is() { # $1 run, $2 detail, $3 result: results.tsv is the header, the earlier run's row, then that run's row
    printf 'run\tscenario\tbinding\tN\tshardSize\tq\tcode\tdetail\tresult\nearlier\tfloor\ton\t4\t10\t7\timage\tfine\tPASS\n%s\tdrop-n10s10\ton\t13\t10\t7\timage\t%s\t%s\n' \
        "$1" "$2" "$3" | cmp -s - "${RUNS_DIR}/results.tsv"
}
for verdict in PASS FAIL; do
    st=$([ "${verdict}" = PASS ] && echo 0 || echo 1)
    why="could not run: postgres connection limit hit (in the logs collected at teardown: node-6.log); the result was ${verdict}"
    end_case td_late "${verdict}" late
    echo "${OUT}" | grep -E 'RESULT|ABORT|^rc=' | cut -c1-220 | sed 's/^/    | /'
    check "gate passed, ${verdict} written, then a late hit: exit 2" has "rc=2"
    check "gate passed, ${verdict} written, then a late hit: says exit ${st} was replaced" has "postgres connection limit hit (exit ${st} replaced by 2"
    check "gate passed, ${verdict} written, then a late hit: verdict.json says ERROR, why, and what the result was" verdict_is ERROR "${why}"
    check "gate passed, ${verdict} written, then a late hit: its results.tsv row says ERROR and why, the earlier row is kept, none is added" \
        tsv_is stub-td_late "${why}" ERROR
    check "gate passed, ${verdict} written, then a late hit: run.log says RESULT ERROR" grep -q "RESULT ERROR: drop-n10s10 .*${why}" "${LOG_DIR}/05-verdict.log"
    check "gate passed, ${verdict} written, then a late hit: nothing on stderr" test -z "${ERR}"
done
end_case td_end_clean PASS none
check "gate passed, PASS written, no late hit: exit 0" has "rc=0"
check "gate passed, PASS written, no late hit: verdict.json keeps PASS" verdict_is PASS "phases fine"
check "gate passed, PASS written, no late hit: its results.tsv row keeps PASS" tsv_is stub-td_end_clean "phases fine" PASS
end_case td_unwritable PASS unwritable
echo "${ERR}" | cut -c1-220 | sed 's/^/    | /'
check "a late hit, and neither record can be rewritten: still exit 2" has "rc=2"
check "and stderr says verdict.json still says PASS" grep -q "could not rewrite ${LOG_DIR}/verdict.json: it still says PASS, the exit is 2" <<< "${ERR}"
check "and stderr says results.tsv could not be rewritten" grep -q "could not rewrite ${RUNS_DIR}/results.tsv (it could not be read or the copy written): the row of stub-td_unwritable still says PASS, the exit is 2" <<< "${ERR}"
# Neither copy of the rewrite can be written (unwritable): no record is replaced
# by what was written of its copy. gawk exits 0 then; mawk, 2.
gate_case td_copies_unwritten PASS; RUNS_DIR="${WORK}/td_copies_unwritten/runs"; mkdir -p "${RUNS_DIR}"
printf 'run\tscenario\tbinding\tN\tshardSize\tq\tcode\tdetail\tresult\nearlier\tfloor\ton\t4\t10\t7\timage\tfine\tPASS\nstub-copies\tdrop-n10s10\ton\t13\t10\t7\timage\tphases fine\tPASS\n' > "${RUNS_DIR}/results.tsv"
echo '{"result":"PASS","detail":"phases fine"}' > "${LOG_DIR}/verdict.json"
cp "${RUNS_DIR}/results.tsv" "${WORK}/results.before"; cp "${LOG_DIR}/verdict.json" "${WORK}/verdict.before"
ERR=$( ( RUN_ID=stub-copies; SCENARIO=drop-n10s10; BINDING=on; SHARD=10; Q=7; CODE=image; unwritable rewrite_verdict "could not run: stub" ) 2>&1 > /dev/null; echo "rc=$?")
echo "${ERR}" | grep -E 'ERROR|^rc=' | cut -c1-220 | sed 's/^/    | /'
check "rewrite_verdict, neither copy can be written: rc=1, verdict.json as it was, and stderr says it still says PASS" \
    bash -c 'grep -q "^rc=1$" <<< "$1" && cmp -s "$2" "$3" && grep -q "could not rewrite $2: it still says PASS, the exit is 2" <<< "$1"' \
    _ "${ERR}" "${LOG_DIR}/verdict.json" "${WORK}/verdict.before"
check "rewrite_verdict, neither copy can be written: results.tsv as it was, every row kept, and stderr says so" \
    bash -c 'cmp -s "$2" "$3" && grep -q "could not rewrite $2 (.*): the row of stub-copies still says PASS, the exit is 2" <<< "$1"' \
    _ "${ERR}" "${RUNS_DIR}/results.tsv" "${WORK}/results.before"
check "rewrite_verdict, neither copy can be written: the empty copy of results.tsv is removed" \
    test -z "$(compgen -G "${RUNS_DIR}/results.tsv.tmp*")"

echo "== results.tsv is shared: the append and the rewrite each hold the lock next to it, and without it fail and say so"
check "run.sh waits up to 30 s for the lock" test "${RESULTS_LOCK_WAIT_S:-unset}" = 30
TSV_HEAD=$'run\tscenario\tbinding\tN\tshardSize\tq\tcode\tdetail\tresult\nearlier\tfloor\ton\t4\t10\t7\timage\tfine\tPASS'
lock_case() { # results.tsv: the header, an earlier run's row and stub-lock's PASS row
    gate_case "$1" PASS; RUNS_DIR="${WORK}/$1/runs"; mkdir -p "${RUNS_DIR}"
    printf '%s\nstub-lock\tdrop-n10s10\ton\t13\t10\t7\timage\tphases fine\tPASS\n' "${TSV_HEAD}" > "${RUNS_DIR}/results.tsv"
    echo '{"result":"PASS","detail":"phases fine"}' > "${LOG_DIR}/verdict.json"
    cp "${RUNS_DIR}/results.tsv" "${WORK}/results.before"
}
# Another run holds the lock (a process that took it, then sleeps) until release_lock
hold_lock() {
    ( exec 8>> "${RUNS_DIR}/results.tsv.lock"; flock 8; exec sleep 600 ) & HOLDER=$!
    while flock -n "${RUNS_DIR}/results.tsv.lock" true; do sleep 0.05; done
}
release_lock() { kill "${HOLDER}"; wait "${HOLDER}" 2> /dev/null; }
rewrite() { # rewrite_verdict of stub-lock, waiting $1 s for the lock: ERR (stderr, then rc=)
    ERR=$( ( RUN_ID=stub-lock; SCENARIO=drop-n10s10; BINDING=on; SHARD=10; Q=7; CODE=image; RESULTS_LOCK_WAIT_S=$1
        rewrite_verdict "could not run: stub" ) 2>&1 > /dev/null; echo "rc=$?")
}
append() { # the real write_verdict of stub-append, waiting $1 s for the lock, after the commands $2 (if any): ERR
    ERR=$( ( for f in write_verdict verdict_json; do source <(fn_src "${f}"); done; source <(grep -E '^step\(\) ' "${RUN_SH}")
        RUN_ID=stub-append; SCENARIO=drop-n10s10; BINDING=on; SHARD=10; Q=7; CODE=image; IMAGE=stub; FORK_SET=devnet; EXCLUDED_FORKS='{}'
        PHASES="${LOG_DIR}/phases.tsv"; EVENTS="${LOG_DIR}/events.log"; : > "${PHASES}"; RESULTS_LOCK_WAIT_S=$1
        eval "${2:-}"
        write_verdict ) 2>&1 > /dev/null; echo "rc=$?")
}
results_said() { grep -o 'RESULT [A-Z]*' "${LOG_DIR}/05-verdict.log" | tr '\n' ' '; }
row() { awk -F'\t' -v r="$1" '$1 == r { print $9 }' "${RUNS_DIR}/results.tsv"; }
# The run holding the lock has its copy next to results.tsv: results.tsv.tmp.other,
# or results.tsv.tmp, the name every run used up to b4ccfffd3f
lock_case lock_rewrite; hold_lock
echo "run other's copy" > "${RUNS_DIR}/results.tsv.tmp.other"; echo "a shared copy" > "${RUNS_DIR}/results.tsv.tmp"
rewrite 1; release_lock
check "rewrite_verdict, the lock held by another run: rc=1, results.tsv as it was" \
    bash -c 'grep -q "^rc=1$" <<< "$1" && cmp -s "$2" "$3"' _ "${ERR}" "${RUNS_DIR}/results.tsv" "${WORK}/results.before"
check "and stderr says it got no lock" \
    grep -q "could not rewrite ${RUNS_DIR}/results.tsv (no lock on ${RUNS_DIR}/results.tsv.lock within 1s): the row of stub-lock still says PASS, the exit is 2" <<< "${ERR}"
check "and the copies of the run holding the lock are left alone" \
    test "$(cat "${RUNS_DIR}/results.tsv.tmp.other" "${RUNS_DIR}/results.tsv.tmp" 2>&1 | tr '\n' '|')" = "run other's copy|a shared copy|"
rewrite 1
check "the lock free: rc=0, the row says ERROR, the earlier one PASS, no row added" \
    test "$(tail -1 <<< "${ERR}") $(row stub-lock) $(row earlier) $(wc -l < "${RUNS_DIR}/results.tsv")" = "rc=0 ERROR PASS 3"
check "the lock free: its own copy (results.tsv.tmp.stub-lock) is gone, the others' are left" \
    test "$(cd "${RUNS_DIR}" && ls results.tsv.tmp* | tr '\n' ' ')" = "results.tsv.tmp results.tsv.tmp.other "
# Every line of rewrite_verdict that names its copy lies between the flock and the
# end of the block the lock is held for
rv=$(fn_src rewrite_verdict)
lock_from=$(grep -n 'flock -w' <<< "${rv}" | head -1 | cut -d: -f1)
lock_to=$(grep -n '^    } 9>> ' <<< "${rv}" | head -1 | cut -d: -f1)
tmp_lines=$(grep -n '"${tmp}"' <<< "${rv}" | cut -d: -f1 | tr '\n' ' ')
outside=$(for l in ${tmp_lines}; do [ "${l}" -gt "${lock_from:-0}" ] && [ "${l}" -lt "${lock_to:-0}" ] || echo "${l}"; done)
check "rewrite_verdict makes, renames and removes its copy only under the lock (lines ${tmp_lines}in ${lock_from:-?}..${lock_to:-?})" \
    test -n "${tmp_lines}" -a -n "${lock_from}" -a -n "${lock_to}" -a -z "${outside}"
# Up to b4ccfffd3f a run whose row could not be added still exited 0 on a PASS.
# verdict.json is written first, PASS, then rewritten as ERROR
lock_case lock_append; hold_lock; append 1; release_lock
check "write_verdict, the lock held by another run: exit 2, no row added, and stderr says why" \
    bash -c 'grep -q "^rc=2$" <<< "$3" && cmp -s "$1" "$2" && grep -q "ERROR: the row of stub-append could not be added to $1 (no lock on $1.lock within 1s): the verdict is ERROR, the exit is 2" <<< "$3"' \
    _ "${RUNS_DIR}/results.tsv" "${WORK}/results.before" "${ERR}"
check "write_verdict, the lock held by another run: verdict.json, written as PASS first, says ERROR, why, and what the result was" \
    verdict_is ERROR "could not record the verdict: no row added to ${RUNS_DIR}/results.tsv (no lock on ${RUNS_DIR}/results.tsv.lock within 1s); the result was PASS (phases fine)"
check "write_verdict, the lock held by another run: the run log says RESULT PASS, then RESULT ERROR" \
    bash -c 'test "$1" = "RESULT PASS RESULT ERROR " && grep -q "RESULT ERROR: drop-n10s10 .*could not record the verdict: " "$2"' _ "$(results_said)" "${LOG_DIR}/05-verdict.log"
append 1
check "the lock free: rc=0, the row is added after the others, verdict.json says PASS" \
    test "$(tail -1 <<< "${ERR}") $(tail -1 "${RUNS_DIR}/results.tsv" | cut -f1,9) $(wc -l < "${RUNS_DIR}/results.tsv") $(jq -r .result "${LOG_DIR}/verdict.json")" = $'rc=0 stub-append\tPASS 4 PASS'
lock_case lock_append_unwritable; rm "${RUNS_DIR}/results.tsv"; mkdir "${RUNS_DIR}/results.tsv"; append 1
check "write_verdict, results.tsv cannot be written (a directory here): exit 2, and stderr says a write failed" \
    bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "ERROR: the row of stub-append could not be added to $2 (a write to it failed): the verdict is ERROR, the exit is 2" <<< "$1"' \
    _ "${ERR}" "${RUNS_DIR}/results.tsv"
check "write_verdict, results.tsv cannot be written: verdict.json says ERROR and why" \
    verdict_is ERROR "could not record the verdict: no row added to ${RUNS_DIR}/results.tsv (a write to it failed); the result was PASS (phases fine)"
# Where the append starts (flock, here a function that copies verdict.json and
# results.tsv as they are, then kills the run as a crash would): verdict.json
# already holds the result and results.tsv no row of the run. Up to f025ae13ed
# the row came first, and a crash there left a PASS row with no verdict.json
lock_case lock_order; rm "${LOG_DIR}/verdict.json"
append 1 'flock() { cp "${LOG_DIR}/verdict.json" "${WORK}/lock_order/verdict.at-lock"; cp "${RUNS_DIR}/results.tsv" "${WORK}/lock_order/results.at-lock"; kill -KILL "${BASHPID}"; }'
check "write_verdict, as it takes the lock: verdict.json is there and says PASS, results.tsv has no row of the run" \
    bash -c 'jq -e ".run == \"stub-append\" and .result == \"PASS\" and .detail == \"phases fine\"" "$1" > /dev/null && cmp -s "$2" "$3"' \
    _ "${WORK}/lock_order/verdict.at-lock" "${WORK}/lock_order/results.at-lock" "${WORK}/results.before"
check "write_verdict, killed there: verdict.json says PASS, results.tsv as it was, no copy of verdict.json left" \
    bash -c 'grep -q "^rc=137$" <<< "$1" && jq -e ".result == \"PASS\"" "$2" > /dev/null && [ ! -e "$2.tmp" ] && cmp -s "$3" "$4"' \
    _ "${ERR}" "${LOG_DIR}/verdict.json" "${RUNS_DIR}/results.tsv" "${WORK}/results.before"
# Killed between writing verdict.json's copy and the mv: no verdict.json, no row
lock_case lock_crash_mv; rm "${LOG_DIR}/verdict.json"
append 1 'mv() { kill -KILL "${BASHPID}"; }'
check "write_verdict, killed before verdict.json's mv: no verdict.json, results.tsv as it was" \
    bash -c 'grep -q "^rc=137$" <<< "$1" && [ ! -e "$2" ] && cmp -s "$3" "$4"' _ "${ERR}" "${LOG_DIR}/verdict.json" "${RUNS_DIR}/results.tsv" "${WORK}/results.before"
# No row, and verdict.json cannot be rewritten (its copy is a directory by then)
lock_case lock_no_rewrite
append 1 'flock() { mkdir "${LOG_DIR}/verdict.json.tmp"; return 1; }'
check "write_verdict, no row and verdict.json not rewritten: exit 2, results.tsv as it was, verdict.json still PASS, and stderr says so" \
    bash -c 'grep -q "^rc=2$" <<< "$1" && cmp -s "$2" "$3" && jq -e ".result == \"PASS\"" "$4" > /dev/null && grep -q "ERROR: could not rewrite $4: it still says PASS, the exit is 2" <<< "$1"' \
    _ "${ERR}" "${RUNS_DIR}/results.tsv" "${WORK}/results.before" "${LOG_DIR}/verdict.json"
# verdict.json cannot be written (its copy is a directory): no PASS row; the row
# says ERROR
lock_case lock_verdict_unwritable; rm "${LOG_DIR}/verdict.json"; mkdir "${LOG_DIR}/verdict.json.tmp"; append 1
check "write_verdict, verdict.json cannot be written: exit 2, no verdict.json, and stderr says so" \
    bash -c 'grep -q "^rc=2$" <<< "$1" && [ ! -e "$2" ] && grep -q "ERROR: could not write $2: the verdict is ERROR, the exit is 2" <<< "$1"' _ "${ERR}" "${LOG_DIR}/verdict.json"
check "write_verdict, verdict.json cannot be written: the row says ERROR, why and what the result was, after the others; the run log RESULT ERROR" \
    bash -c 'cmp -s <(head -3 "$1") "$2" && test "$(tail -n +4 "$1" | cut -f1,8,9)" = "$3" && test "$4" = "RESULT ERROR "' \
    _ "${RUNS_DIR}/results.tsv" "${WORK}/results.before" \
    "$(printf 'stub-append\tcould not record the verdict: %s not written; the result was PASS (phases fine)\tERROR' "${LOG_DIR}/verdict.json")" "$(results_said)"
# Eight runs end at once, each rewriting its own row: one copy-and-replace at a
# time, so none puts back a row another one changed
lock_case lock_many
for p in $(seq 1 8); do printf 'stub-p%s\tdrop-n10s10\ton\t13\t10\t7\timage\tphases fine\tPASS\n' "${p}" >> "${RUNS_DIR}/results.tsv"; done
for p in $(seq 1 8); do
    ( LOG_DIR="${WORK}/lock_many/p${p}"; STEP_LOG="${LOG_DIR}/step.log"; mkdir -p "${LOG_DIR}"; echo '{"result":"PASS"}' > "${LOG_DIR}/verdict.json"
      RUN_ID="stub-p${p}"; SCENARIO=drop-n10s10; BINDING=on; SHARD=10; Q=7; CODE=image
      rewrite_verdict "could not run: stub ${p}" ) > /dev/null 2>&1 &
done
wait
check "eight rewrites at once: every row of the eight says ERROR, the other two PASS, none lost or added" \
    test "$(awk -F'\t' '$1 ~ /^stub-p/ && $9 == "ERROR"' "${RUNS_DIR}/results.tsv" | wc -l) $(row earlier) $(row stub-lock) $(wc -l < "${RUNS_DIR}/results.tsv")" = "8 PASS PASS 11"

echo "== the postgres container lookup is bounded: one that stalls, fails or finds nothing fails the read, or the preflight's try, and says why"
# A function of this shell in a fresh bash under an outside guard of $1 s, so a
# lookup that is not bounded ends the case (rc=124, the guard's) and not the
# suite. OUT: its output, then rc=; ms: what it took. The bound is
# LOG_READ_TIMEOUT_S: 3 s, as set above, unless a case sets it.
guarded() { # $1 the guard in s, $2.. the command
    local g="$1" t0; shift
    { declare -f; declare -p DB_TIMEOUT_S PG_LIMITS LOG_READ_TIMEOUT_S N HERE RUN_DIR PROJECT LOG_DIR STEP_LOG; } > "${WORK}/guarded.sh"
    t0=$(date +%s%N)
    OUT=$(timeout -k 1 "${g}" bash -c 'set -uo pipefail; source "$1"; shift; "$@"' _ "${WORK}/guarded.sh" "$@" 2>&1; echo "rc=$?")
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
}
pg_case() { new_case "$1" 25 25 25 25; : > "${FAKE_DOCKER_LOG}"; } # N=4
lookups() { grep -c ' ps -q postgres$' "${FAKE_DOCKER_LOG}"; }
psql_runs() { grep -c '^exec ' "${FAKE_DOCKER_LOG}"; }
pg_case pgps_hang
FAKE_PGPS=hang guarded 20 psql_node 3 "SELECT 1"
echo "${OUT}" | tail -2 | cut -c1-220 | sed 's/^/    | /'
check "psql_node, the lookup stalls: rc=1, within the bound (${ms} ms; the stub sleeps 60 s)" bash -c 'grep -q "^rc=1$" <<< "$1" && [ "$2" -lt 10000 ]' _ "${OUT}" "${ms}"
check "psql_node, the lookup stalls: says so" has "psql node3_db: docker compose ps -q postgres did not answer within 3s"
check "psql_node, the lookup stalls: no psql is run" test "$(psql_runs)" = 0
pg_case pgps_fail
FAKE_PGPS=fail guarded 20 psql_node 3 "SELECT 1"
check "psql_node, the lookup fails: rc=1, and says so" bash -c 'grep -q "^rc=1$" <<< "$1" && grep -q "psql node3_db: docker compose ps -q postgres failed (exit 1)" <<< "$1"' _ "${OUT}"
check "psql_node, the lookup fails: no psql is run" test "$(psql_runs)" = 0
pg_case pgps_empty
FAKE_PGPS=empty guarded 20 psql_node 3 "SELECT 1"
check "psql_node, no running postgres: rc=1, and says so" bash -c 'grep -q "^rc=1$" <<< "$1" && grep -q "psql node3_db: no running postgres container" <<< "$1"' _ "${OUT}"
check "psql_node, no running postgres: no psql is run with an empty container" test "$(psql_runs)" = 0

# The preflight as run.sh runs it (its top-level line), N=4 (need 60). Its 2 s
# pause between tries is a no-op here: the cases are about each try's bound.
eval "preflight_line() { sleep() { :; }; $(grep -m1 '^pg_limit_preflight || exit 2$' "${RUN_SH}"); }"
pg_case pre_hang
FAKE_PGPS=hang LOG_READ_TIMEOUT_S=0.2 guarded 45 preflight_line
echo "${OUT}" | tail -2 | cut -c1-220 | sed 's/^/    | /'
check "preflight, the lookup stalls on every try: exit 2" has "^rc=2$"
check "preflight, the lookup stalls on every try: says why" \
    has "ABORT: could not read max_connections from postgres (45 tries; last: docker compose ps -q postgres did not answer within 0.2s)"
# The ABORT line counts the tries. The fake docker's log does not: at 0.2 s,
# timeout can end a lookup before the fake docker has run its first line, the
# one that logs the call. So the log only shows that lookups reached it, and the
# time that each try waited out its bound and none the stub's sleep
check "preflight, the lookup stalls on every try: 45 tries of at least the bound each, none of the stub's sleep (${ms} ms, 45 x 0.2 s = 9 s; the stub sleeps 60 s each)" \
    bash -c '[ "$1" -ge 9000 ] && [ "$1" -lt 30000 ]' _ "${ms}"
check "preflight, the lookup stalls on every try: the lookups reached the fake docker ($(lookups) of the 45 logged)" test "$(lookups)" -ge 1
check "preflight, the lookup stalls on every try: no psql is run" test "$(psql_runs)" = 0
pg_case pre_empty
FAKE_PGPS=empty guarded 20 preflight_line
check "preflight, no running postgres on any try: exit 2, and says why" \
    bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "could not read max_connections from postgres (45 tries; last: no running postgres container)" <<< "$1"' _ "${OUT}"
check "preflight, no running postgres on any try: no psql is run with an empty container" test "$(psql_runs)" = 0
pg_case pre_once
FAKE_PGPS=hang-once guarded 20 preflight_line
check "preflight, the first lookup stalls: the next try reads max_connections (rc=0)" \
    bash -c 'grep -q "^rc=0$" <<< "$1" && grep -q "postgres max_connections 100 (4 nodes need 60)" <<< "$1"' _ "${OUT}"
# The lookup that stalls is the first to get past the fake docker's first lines
# (hang-once): a try later if timeout ended one before them. That one and the one
# that answered are always logged
check "preflight, the first lookup stalls: two lookups or more, the stalled one ended at the bound ($(lookups); ${ms} ms; the stub sleeps 60 s)" \
    bash -c '[ "$1" -ge 2 ] && [ "$2" -lt 10000 ]' _ "$(lookups)" "${ms}"
check "preflight, the first lookup stalls: psql runs in the container the lookup gave" \
    grep -q '^exec .* fakepg psql -U demosuser -d postgres -tAc SHOW max_connections$' "${FAKE_DOCKER_LOG}"

# The wiring: the gate sits before the verdict is written, the preflight before the first node starts,
# and a teardown backstop covers the exits that skip the gate
check "pg_limit_gate runs right before the final write_verdict" test "$(grep -B1 '^write_verdict$' "${RUN_SH}" | head -1)" = pg_limit_gate
pg_up=$(grep -n '^dc up -d postgres' "${RUN_SH}" | head -1 | cut -d: -f1)
pg_pre=$(grep -n '^pg_limit_preflight || exit 2$' "${RUN_SH}" | head -1 | cut -d: -f1)
first_node=$(grep -n '^    start_node "${i}" || ' "${RUN_SH}" | head -1 | cut -d: -f1)
check "pg_limit_preflight runs after postgres starts and before the first node (lines ${pg_up:-?} < ${pg_pre:-?} < ${first_node:-?})" \
    test -n "${pg_up}" -a -n "${pg_pre}" -a -n "${first_node}" -a "${pg_up:-0}" -lt "${pg_pre:-0}" -a "${pg_pre:-0}" -lt "${first_node:-0}"
migrate=$(grep -n 'migration:run -d ' "${RUN_SH}" | head -1 | cut -d: -f1)
check "the image path's migration runs after the preflight and before the first node (lines ${pg_pre:-?} < ${migrate:-?} < ${first_node:-?})" \
    test -n "${migrate}" -a "${pg_pre:-0}" -lt "${migrate:-0}" -a "${migrate:-0}" -lt "${first_node:-0}"
check "the teardown replaces exit 0/1 by 2 when the collected logs hold the error" grep -q 'exit ${rc} replaced by 2' "${RUN_SH}"

# Run order: bash reads run.sh top down, so a function must be defined above the
# first top-level call that reaches it. Everything above sources regions of run.sh, so a function defined below its
# first top-level call (bash reads top down) passes there and fails in a real
# run. This runs the real file for halt-n13s10 up to the first node start, with
# docker and bun replaced and the host-load probes (nproc, vmstat) made benign.
# The stub docker answers the image and container checks, `compose up -d
# postgres`, `compose ps -q postgres` and SHOW max_connections (STUB_MAXCONN);
# at `compose up -d node-1` it records the start and stops run.sh with SIGTERM
# (exit 130 via run.sh's trap), so nothing waits for a node that is not there.
# STUB_START=image makes the image look like a release image (no run-devnet, an
# ENTRYPOINT and a CMD), so run.sh takes the image path and its migration step:
# `compose exec postgres pg_isready` and one `compose run ... migration:run` per
# node, which fails for node STUB_MIGRATE_FAIL. `docker info` answers the
# logging driver STUB_LOGDRIVER (json-file), or fails as a daemon error for fail.
mkdir -p "${WORK}/runbin"
cat > "${WORK}/runbin/docker" <<'STUBDOCKER'
#!/usr/bin/env bash
echo "$*" >> "${STUB_LOG}"
case "$1" in
    image)
        case "$*" in
            *"{{.Id}}"*) echo sha256:0123456789abcdef0123456789abcdef ;;
            *Entrypoint*) [ "${STUB_START}" = image ] && echo '["/usr/local/bin/docker-entrypoint.sh"]' || echo null ;;
            *Cmd*) [ "${STUB_START}" = image ] && echo '["bun","run","start"]' || echo null ;;
        esac ;;
    run)
        # the image's user, read with `--entrypoint id IMAGE -u|-g`; the
        # run-devnet probe finds it unless STUB_START=image; every other
        # throwaway container (exec and gossip checks) succeeds
        case "$*" in *"testing/devnet/run-devnet ]"*) [ "${STUB_START}" = image ] && exit 1 ;; esac
        case "${@: -1}" in -u | -g) echo 1000 ;; esac ;;
    exec)
        case "$*" in *"SHOW max_connections"*) echo "${STUB_MAXCONN}" ;; esac ;;
    info)
        [ "${STUB_LOGDRIVER}" = fail ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
        echo "${STUB_LOGDRIVER}" ;;
    compose)
        case "$*" in
            *"ps -q postgres"*) echo fakepg ;;
            *"up -d node-"*) kill -TERM "${PPID}"; exit 1 ;;
            *" node-${STUB_MIGRATE_FAIL:-none} "*migration:run*) echo "QueryFailedError: stub" >&2; exit 1 ;;
        esac ;;
esac
exit 0
STUBDOCKER
cat > "${WORK}/runbin/bun" <<'STUBBUN'
#!/usr/bin/env bash
printf 'MNEMONIC:stub stub stub\nPUBKEY:0xAB%s\n' "$RANDOM"
STUBBUN
printf '#!/usr/bin/env bash\necho 4096\n' > "${WORK}/runbin/nproc"
printf '#!/usr/bin/env bash\nfor i in 1 2 3 4 5; do echo "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"; done\n' > "${WORK}/runbin/vmstat"
chmod +x "${WORK}/runbin/docker" "${WORK}/runbin/bun" "${WORK}/runbin/nproc" "${WORK}/runbin/vmstat"
# The generic form of the same check, for every top-level call: a function must
# be defined, along with every function its body calls, on a line before the
# first top-level call that reaches it. Reads the script twice (definitions, then
# calls); a call is the first word of a command (after ; | & ( ) { } `, if, do ...).
# Prints one line per violation, then the number of top-level calls checked.
order_violations() { # $1 a bash script
    awk '
    function firstcmds(line, out,    s, n, i, k, w, m) {
        gsub(/[;|&(){}`]/, "\n", line)
        n = split(line, s, "\n"); m = 0
        for (i = 1; i <= n; i++) {
            w = s[i]
            while (match(w, /^[ \t]*(if|then|else|elif|do|while|until|!)[ \t]+/)) w = substr(w, RLENGTH + 1)
            sub(/^[ \t]+/, "", w)
            if (match(w, /^[A-Za-z_][A-Za-z0-9_]*([ \t]|$)/)) { k = substr(w, 1, RLENGTH); sub(/[ \t]+$/, "", k); out[++m] = k }
        }
        return m
    }
    function reach(f,    n, i, parts) {
        if (f in seen) return
        seen[f] = 1
        n = split(bc[f], parts, " ")
        for (i = 1; i <= n; i++) if (parts[i] in def) reach(parts[i])
    }
    FNR == NR { if (match($0, /^[A-Za-z_][A-Za-z0-9_]*\(\) *\{/)) { name = $0; sub(/\(\).*/, "", name); def[name] = FNR }; next }
    {
        line = $0; fn = ""
        if (match(line, /^[A-Za-z_][A-Za-z0-9_]*\(\) *\{/)) {
            fn = line; sub(/\(\).*/, "", fn)
            body = line; sub(/^[^{]*\{/, "", body)
            if (line !~ /\}[ \t]*$/) infn = fn
        } else if (infn != "") { fn = infn; body = line; if (line ~ /^\}/) infn = "" }
        if (fn != "") {
            sub(/^[ \t]*#.*/, "", body)
            n = firstcmds(body, c)
            for (i = 1; i <= n; i++) if (c[i] in def) bc[fn] = bc[fn] " " c[i]
        } else if (line !~ /^[ \t]*#/) {
            n = firstcmds(line, c)
            for (i = 1; i <= n; i++) if (c[i] in def) { tl++; tline[tl] = FNR; tfn[tl] = c[i] }
        }
    }
    END {
        for (t = 1; t <= tl; t++) {
            delete seen; reach(tfn[t])
            for (g in seen) if (def[g] > tline[t]) printf "line %d calls %s, which needs %s, defined at line %d\n", tline[t], tfn[t], g, def[g]
        }
        printf "top-level calls checked: %d\n", tl
    }' "$1" "$1"
}
echo "== every function reached from a top-level call of run.sh is defined before that call"
ORDER=$(order_violations "${RUN_SH}")
echo "${ORDER}" | sed 's/^/    | /'
check "no top-level call of run.sh reaches a function defined below it" bash -c '! grep -q "defined at line" <<< "$1"' _ "${ORDER}"
check "the check saw the top-level calls (at least 10)" test "$(sed -n 's/^top-level calls checked: //p' <<< "${ORDER}")" -ge 10

echo "== boot_failure_line: the node's own refusal line for the abort of a node that never served"
boot_failure_of() { # $1 the node's log, as docker logs prints it (the fake docker's nodelog.1)
    ( new_case boot 25; printf '%s\n' "$1" > "${FAKE}/nodelog.1"; boot_failure_line 1 )
}
REFUSED=$'[INFO] [GENESIS] Looking for the genesis block...\n\e[31m[ERROR] [GENESIS] Refusing to boot: identityCarryover is active at genesis but no snapshot was found\e[0m\n[ERROR] unrelated error\n'
check "a genesis refusal is found, without colour codes, even with a later error line" \
    test "$(boot_failure_of "${REFUSED}")" = "[ERROR] [GENESIS] Refusing to boot: identityCarryover is active at genesis but no snapshot was found"
check "with no refusal the last error line is given" \
    test "$(boot_failure_of $'[INFO] up\n[ERROR] connect ECONNREFUSED\n[INFO] retrying')" = "[ERROR] connect ECONNREFUSED"
check "a log with neither gives nothing, and rc 0" \
    bash -c '[ -z "$1" ]' _ "$(boot_failure_of $'[INFO] up\n[INFO] bye')"

echo "== the bring-up abort of a node that never served: an unreadable log is named, within the bound, and the run still exits 2"
# run.sh's own line, for node-1 with start_node failing
BOOT_ABORT=$(grep -m1 '^    start_node "${i}" || ' "${RUN_SH}")
boot_abort() { # OUT, and ms it took
    local t0; t0=$(date +%s%N)
    OUT=$( ( i=1; start_node() { return 1; }; eval "${BOOT_ABORT}" ) 2>&1; echo "rc=$?" )
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
}
new_case boot_unread 25; touch "${FAKE}/nodelog.1.fail"
boot_abort
echo "${OUT}" | tail -3 | cut -c1-220 | sed 's/^/    | /'
check "docker logs fails: the abort says the log is unreadable, with docker's words" \
    has "node-1 log: unreadable (docker logs failed (exit 1): Error response from daemon: stub: cannot read the log of cid1)"
check "docker logs fails: exit 2" has "rc=2"
new_case boot_hang 25; echo 30 > "${FAKE}/nodelog.1.hang"
boot_abort
echo "${OUT}" | tail -3 | cut -c1-220 | sed 's/^/    | /'
check "docker logs stalls: the abort says the log is unreadable, not read within the bound" has "node-1 log: unreadable (docker logs did not finish within 3s)"
check "docker logs stalls: exit 2" has "rc=2"
check "docker logs stalls: returns within the bound (${ms} ms; the stub sleeps 30 s)" test "${ms}" -lt 15000
new_case boot_refused 25; printf '%s\n' "${REFUSED}" > "${FAKE}/nodelog.1"
boot_abort
check "a readable log: the abort gives the refusal line, and exit 2" \
    bash -c 'grep -q "^\[qdrill\] node-1 log: \[ERROR\] \[GENESIS\] Refusing to boot: identityCarryover" <<< "$1" && grep -q "^rc=2$" <<< "$1"' _ "${OUT}"
check "the boot read takes the log's last BOOT_LOG_LINES lines (2000)" grep -q "^logs --tail 2000 cid1$" "${FAKE_DOCKER_LOG}"

echo "== a recovery or ride that reaches the target only after its wait: no t_converged, and the judge gets the heads read inside it"
# The real drill_recover and scenario_ride. heads_once answers below the target
# while the wait runs (the caller's local `deadline`) and at the target once it
# is over: nodes that got there late. SLOW_READ is a read that starts inside
# the wait and returns the target after it.
for f in drill_recover scenario_ride; do source <(fn_src "${f}"); done
source <(grep -E '^(kv_json|now_ms)\(\) ' "${RUN_SH}")
heads_once() {
    local i h="${LATE_HEAD}"
    if [ "${SLOW_READ}" = 1 ]; then while [ "${SECONDS}" -lt "${deadline}" ]; do sleep 0.2; done
    elif [ "${SECONDS}" -lt "${deadline}" ]; then h="${EARLY_HEAD}"; fi
    for i in "$@"; do printf '%s %s\n' "${i}" "${h}"; done | kv_json
}
dc() { :; }
event() { :; }
phase_row() { :; }
block_rows() { echo '[]'; }
round_times() { echo "- -"; }
drill_stop() { :; }
drill_judge() { :; }
json_is() { jq -e "$@" > /dev/null; }
VICTIMS=(3); VICTIM_SERVICES=(node-3); SURVIVORS=(1 2); STOPS=1; PRE_HEIGHT=8; RECOVERY_BLOCKS=3; RIDE_BLOCKS=3
# name, recovery heads in and after the wait (target 12), ride's (target 11), timeout, slow read, t_converged
for spec in "late 10 12 9 11 2 0 unset" "slow-read 12 12 11 11 2 1 unset" "in-time 12 12 11 11 30 0 set"; do
    set -- ${spec}
    new_case "recover-$1" 9 9 9; EARLY_HEAD=$2; LATE_HEAD=$3; RECOVERY_TIMEOUT=$6; SLOW_READ=$7; T_FIRST=""; T_CONV=""; RECOVERY_JSON=null
    drill_recover 9 > /dev/null
    check "P5, $1: t_converged is $8" test "$([ -n "${T_CONV}" ] && echo set || echo unset)" = "$8"
    check "P5, $1: the judge gets the heads of the last read in the wait (all at $2): ${RECOVERY_JSON:0:40}..." \
        json_is --argjson h "$2" '[.heads[]] == [$h, $h, $h]' <<< "${RECOVERY_JSON}"

    new_case "ride-$1" 8 8 8; EARLY_HEAD=$4; LATE_HEAD=$5; RIDE_TIMEOUT=$6; PHASES="${LOG_DIR}/phases.tsv"; T_FIRST=""; T_CONV=""; RIDE_JSON=null
    scenario_ride > /dev/null
    check "ride, $1: t_converged is $8, and the judge gets the heads of the last read in the wait (all at $4)" \
        bash -c '[ "$1" = "$2" ] && jq -e --argjson h "$3" "[.heads[]] == [\$h, \$h]" <<< "$4" > /dev/null' \
        _ "$([ -n "${T_CONV}" ] && echo set || echo unset)" "$8" "$4" "${RIDE_JSON}"
done

echo "== run.sh executed from the top (stub docker and bun): the preflight is defined where the call runs"
run_from_top() { # $1 what max_connections the stub postgres reports, $2 start path (run-devnet), $3 node whose migration fails
    STUB_LOG="${WORK}/run-top.docker.log"; : > "${STUB_LOG}"
    STUB_LOG="${STUB_LOG}" STUB_MAXCONN="$1" STUB_START="${2:-run-devnet}" STUB_MIGRATE_FAIL="${3:-none}" STUB_LOGDRIVER="${STUB_LOGDRIVER:-json-file}" \
        PATH="${WORK}/runbin:${PATH}" RUNS_DIR="${WORK}/runs" \
        NODE_EST_MB=1 HEADROOM_MB=0 MIN_DISK_GB=0 \
        timeout 120 bash "${RUN_SH}" halt-n13s10 stubtop > "${WORK}/run-top.out" 2>&1
    echo "rc=$?" >> "${WORK}/run-top.out"
}
started_node() { grep -q 'compose .* up -d node-1' "${WORK}/run-top.docker.log"; }
out_has() { grep -q -- "$1" "${WORK}/run-top.out"; }

run_from_top 280
sed 's/^/    | /' "${WORK}/run-top.out" | tail -6 | cut -c1-200
check "max_connections 280: no 'command not found'" bash -c '! grep -q "command not found" "$1"' _ "${WORK}/run-top.out"
check "max_connections 280: run.sh reached the preflight and read max_connections" grep -q 'SHOW max_connections' "${WORK}/run-top.docker.log"
check "max_connections 280: the preflight passed (13 nodes need 150)" out_has 'postgres max_connections 280 (13 nodes need 150)'
check "max_connections 280: run.sh went on to start node-1" started_node
check "max_connections 280: and stopped there by the stub's SIGTERM (rc=130)" out_has '^rc=130$'
check "max_connections 280: the forks line has identityCarryover off and says why it is excluded" \
    out_has 'forks (launch): .*identityCarryover@null.*; excluded: identityCarryover (needs a genesis snapshot; the drills use the legacy genesis path)$'
check "max_connections 280: networkGovernance is off (null in the template) and not in the excluded list" \
    out_has 'forks (launch): .*networkGovernance@null.*; excluded: identityCarryover ([^)]*)$'
check "max_connections 280: the run log names the docker logging driver, once" \
    test "$(grep -c 'docker logging driver: ' "${WORK}/run-top.out")" = 1 -a "$(grep -c 'docker logging driver: json-file$' "${WORK}/run-top.out")" = 1

STUB_LOGDRIVER=fail run_from_top 100
sed 's/^/    | /' "${WORK}/run-top.out" | tail -5 | cut -c1-200
check "docker info fails: the driver is unknown, and the run goes on (to the preflight)" \
    bash -c 'grep -q "docker logging driver: unknown$" "$1" && grep -q "postgres max_connections is 100" "$1"' _ "${WORK}/run-top.out"
check "max_connections 100: no 'command not found'" bash -c '! grep -q "command not found" "$1"' _ "${WORK}/run-top.out"
check "max_connections 100: exit 2 with the could-not-run message" out_has 'ABORT: could not run: postgres max_connections is 100, 13 nodes need 150'
check "max_connections 100: rc=2" out_has '^rc=2$'
check "max_connections 100: no node was started" bash -c '! grep -q "compose .* up -d node-" "$1"' _ "${WORK}/run-top.docker.log"

echo "== run.sh executed from the top on the image path: preflight, then one migration per node database, then node-1"
migrations() { grep -c 'compose .* run --rm --no-deps -T --entrypoint bun node-[0-9]* -r tsconfig-paths/register ./node_modules/typeorm/cli.js migration:run' "${WORK}/run-top.docker.log"; }
first_line() { grep -n -- "$1" "${WORK}/run-top.docker.log" | head -1 | cut -d: -f1; }
STUB_LOGDRIVER=local run_from_top 280 image
sed 's/^/    | /' "${WORK}/run-top.out" | tail -4 | cut -c1-200
check "image path: the local logging driver is named, not refused" out_has 'docker logging driver: local$'
check "image path: no 'command not found'" bash -c '! grep -q "command not found" "$1"' _ "${WORK}/run-top.out"
check "image path: run.sh took the image start path" out_has 'start=image'
check "image path: the preflight passed" out_has 'postgres max_connections 280 (13 nodes need 150)'
check "image path: one migration per node database (13)" test "$(migrations)" = 13
check "image path: and says so" out_has 'schema migrated on the 13 node databases'
order="$(first_line 'SHOW max_connections') $(first_line 'pg_isready') $(first_line 'migration:run') $(first_line 'up -d node-1')"
check "image path: SHOW max_connections < pg_isready < migrations < up -d node-1 (docker log lines ${order})" \
    bash -c 'set -- $1; [ $# = 4 ] && [ "$1" -lt "$2" ] && [ "$2" -lt "$3" ] && [ "$3" -lt "$4" ]' _ "${order}"
check "image path: stopped at node-1 by the stub's SIGTERM (rc=130)" out_has '^rc=130$'

run_from_top 280 image 3
sed 's/^/    | /' "${WORK}/run-top.out" | tail -3 | cut -c1-200
check "image path, node3_db migration fails: ABORT names it" out_has 'ABORT: migration:run failed on node3_db'
check "image path, node3_db migration fails: rc=2, after 3 migrations" bash -c 'grep -q "^rc=2$" "$1" && [ "$2" = 3 ]' _ "${WORK}/run-top.out" "$(migrations)"
check "image path, node3_db migration fails: no node was started" bash -c '! grep -q "compose .* up -d node-" "$1"' _ "${WORK}/run-top.docker.log"

run_from_top 100 image
check "image path, max_connections 100: exit 2 before any migration" bash -c 'grep -q "^rc=2$" "$1" && [ "$2" = 0 ]' _ "${WORK}/run-top.out" "$(migrations)"

echo "== --binding off: the launch cases still refuse it, before any docker call"
for sc in halt-n10s10 halt-n13s10 ride-n13s10; do
    : > "${WORK}/run-top.docker.log"
    OUT=$(STUB_LOG="${WORK}/run-top.docker.log" PATH="${WORK}/runbin:${PATH}" RUNS_DIR="${WORK}/runs" \
        timeout 60 bash "${RUN_SH}" --binding off "${sc}" refused 2>&1; echo "rc=$?")
    check "${sc} --binding off: exit 2, says why, no docker call" \
        bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "runs the launch fork set, which activates committeeBinding: --binding off does not apply" <<< "$1" && [ ! -s "$2" ]' \
        _ "${OUT}" "${WORK}/run-top.docker.log"
done

echo "== CONSENSUS_TIME that is not a whole number of seconds: exit 2 before any docker call"
for ct in 10s 08 10.5 0 -5; do
    : > "${WORK}/run-top.docker.log"
    OUT=$(STUB_LOG="${WORK}/run-top.docker.log" PATH="${WORK}/runbin:${PATH}" RUNS_DIR="${WORK}/runs" CONSENSUS_TIME="${ct}" \
        timeout 60 bash "${RUN_SH}" floor badtime 2>&1; echo "rc=$?")
    check "CONSENSUS_TIME='${ct}': exit 2, says why, no docker call" \
        bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "CONSENSUS_TIME must be a whole number of seconds" <<< "$1" && [ ! -s "$2" ]' \
        _ "${OUT}" "${WORK}/run-top.docker.log"
done

echo "== two runs started in the same second with the same options: a run dir and a compose project each"
# The run id's time is one fixed second (a stub date); each run stops at node-1 (the stub's SIGTERM)
mkdir -p "${WORK}/datebin"
REAL_DATE=$(command -v date); export REAL_DATE
cat > "${WORK}/datebin/date" <<'STUBDATE'
#!/usr/bin/env bash
[ "$*" = "-u +%Y%m%dT%H%M%SZ" ] && { echo 20261106T000000Z; exit 0; }
exec "${REAL_DATE}" "$@"
STUBDATE
chmod +x "${WORK}/datebin/date"
same_second() {
    STUB_LOG="${WORK}/same.docker.log" STUB_MAXCONN=280 STUB_START=run-devnet STUB_LOGDRIVER=json-file \
        PATH="${WORK}/datebin:${WORK}/runbin:${PATH}" RUNS_DIR="${WORK}/same-runs" NODE_EST_MB=1 HEADROOM_MB=0 MIN_DISK_GB=0 \
        timeout 120 bash "${RUN_SH}" floor same > /dev/null 2>&1
}
: > "${WORK}/same.docker.log"
same_second; same_second
check "two run dirs, the second with the suffix -2" test "$(ls "${WORK}/same-runs" | tr '\n' ' ')" = "20261106T000000Z-floor-on-same 20261106T000000Z-floor-on-same-2 "
check "both mode 700" test "$(stat -c %a "${WORK}/same-runs/20261106T000000Z-floor-on-same" "${WORK}/same-runs/20261106T000000Z-floor-on-same-2" | tr '\n' ' ')" = "700 700 "
for sfx in "" -2; do
    check "the run${sfx:- without a suffix} starts node-1 with its own compose file and the project named after its dir" \
        test "$(grep -c -- "^compose -f ${WORK}/same-runs/20261106T000000Z-floor-on-same${sfx}/compose.yml -p qdrill-20261106t000000z-floor-on-same${sfx} up -d node-1$" "${WORK}/same.docker.log")" = 1
done

# ── run.sh executed whole, against a stub chain ─────────────────────────
# Past node-1: bring-up, the scenario and the verdict, with docker, bun and
# sleep replaced (every sleep takes 20 ms; the stub's stalls use the real one).
# The stub docker keeps the containers started (up.<n>, created.<n> in
# STUB_STATE) and a head that grows one block every STUB_TICK_MS (300) while at
# least STUB_MIN_LIVE (1) nodes run (STUB_STATE/chain: the head at the last
# start or stop and the time of it in ms). It answers what run.sh asks: the
# preflight's image and container checks, compose up/start/stop/ps, curl through
# docker exec (serving, heads, blocks with hash 0xb<n> and a peerlist of the
# STUB_N nodes), psql through docker exec (heads, block content, peerlist
# length, block rows with 7 signatures, max_connections), inspect (restart
# count 0, LogConfig.Config from STUB_LOGCONF, default null), stats, and node
# logs with a round start past the head, a quorum refusal and a fallback line.
# STUB_STALL makes calls stall (the real sleep, 300 s): logs:<n> node n's docker
# logs, restart every RestartCount inspect, head:<n> node n's head reads once a
# node was stopped. STUB_PSQL_KILL=<n>:<text> kills (SIGKILL, nothing on stderr)
# node n's psql whose SQL holds text. With STUB_LATE_HIT=<n>, node n logs "too
# many clients" once results.tsv (STUB_RESULTS) has a row. bun answers the
# identity helper, and the judge with a pass.
mkdir -p "${WORK}/fullbin"
REAL_SLEEP=$(command -v sleep); export REAL_SLEEP
cp "${WORK}/runbin/nproc" "${WORK}/runbin/vmstat" "${WORK}/fullbin/"
printf '#!/usr/bin/env bash\nexec "${REAL_SLEEP}" 0.02\n' > "${WORK}/fullbin/sleep"
cat > "${WORK}/fullbin/bun" <<'FULLBUN'
#!/usr/bin/env bash
case "$1" in
    *judgeHaltDrill.ts)
        jq -e . "$2" > /dev/null || { echo "stub judge: $2 is not JSON" >&2; exit 2; }
        # STUB_JUDGE=refuse: the real judge's refusal of a genesis without commitLock at 0
        if [ "${STUB_JUDGE:-}" = refuse ]; then
            printf 'malformed drill input:\n  - forks.commitLock: the drill needs commitLock active at block 0, got null\n' >&2; exit 2
        fi
        [ "$3" = --out ] && echo '{"pass":true,"summary":"stub judge pass"}' > "$4"
        echo "PASS: stub judge"; exit 0 ;;
esac
printf 'MNEMONIC:stub stub stub\nPUBKEY:0xAB%s%s\n' "$$" "${RANDOM}"
FULLBUN
cat > "${WORK}/fullbin/docker" <<'FULLDOCKER'
#!/usr/bin/env bash
echo "$*" >> "${STUB_LOG}"
S="${STUB_STATE}"
now_ms() { date +%s%3N; }
head_now() {
    local base since
    read -r base since < "${S}/chain"
    if [ "$(compgen -G "${S}/up.*" | wc -l)" -ge "${STUB_MIN_LIVE:-1}" ]; then
        echo $((base + ($(now_ms) - since) / ${STUB_TICK_MS:-300}))
    else
        echo "${base}"
    fi
}
# A start (+) or stop (-) of the nodes given: the head so far is carried over
event() {
    local op="$1" h n; shift
    exec 9>> "${S}/lock"; flock 9
    h=$(head_now)
    for n in "$@"; do
        if [ "${op}" = + ]; then touch "${S}/up.${n}" "${S}/created.${n}"; else rm -f "${S}/up.${n}"; touch "${S}/stopped"; fi
    done
    echo "${h} $(now_ms)" > "${S}/chain.tmp" && mv "${S}/chain.tmp" "${S}/chain"
}
stalls() { case " ${STUB_STALL:-} " in *" $1 "*) exec "${REAL_SLEEP}" 300 ;; esac; }
peerlist() { local i; for i in $(seq 1 "${STUB_N}"); do printf '"0xp%s"\n' "${i}"; done | paste -sd, -; }
case "$1" in
    image)
        case "$*" in
            *"{{.Id}}"*) echo sha256:0123456789abcdef0123456789abcdef ;;
            *Entrypoint* | *Cmd*) echo null ;;
        esac ;;
    run) case "${@: -1}" in -u | -g) echo 1000 ;; esac ;;
    info) echo json-file ;;
    compose)
        shift 5 # compose -f FILE -p PROJECT
        case "$1" in
            up | start)
                nodes=(); for s in "$@"; do case "${s}" in node-*) nodes+=("${s#node-}") ;; esac; done
                [ "${#nodes[@]}" -gt 0 ] && event + "${nodes[@]}" ;;
            stop) shift 3; event - "${@#node-}" ;; # stop -t 0 node-..
            ps)
                f=up; [ "$2" = -aq ] && f=created
                case "${3:-}" in
                    postgres) echo fakepg ;;
                    node-*) [ -e "${S}/${f}.${3#node-}" ] && echo "c${3#node-}" ;;
                    "") echo fakepg; for u in $(compgen -G "${S}/up.*"); do echo "c${u##*.}"; done ;;
                esac ;;
        esac ;;
    exec)
        shift
        while [ "${1:0:1}" = - ]; do if [ "$1" = -e ]; then shift 2; else shift; fi; done
        c="$1"; shift
        case "$1" in
            curl)
                n=${c#c}; [ -e "${S}/up.${n}" ] || exit 1
                case "$*" in
                    *getLastBlockNumber*) [ -e "${S}/stopped" ] && stalls "head:${n}"; printf '{"result":200,"response":%s}' "$(head_now)" ;;
                    *getBlockByNumber*)
                        b=$(sed 's/.*"blockNumber":\([0-9]*\).*/\1/' <<< "$*")
                        [ "${b}" -le "$(head_now)" ] || { echo '{"result":404}'; exit 0; }
                        printf '{"result":200,"response":{"number":%s,"hash":"0xb%s","content":{"timestamp":%s,"peerlist":[%s]}}}' \
                            "${b}" "${b}" $((1700000000 + 10 * b)) "$(peerlist)" ;;
                    *) echo "Hello from the stub" ;;
                esac ;;
            cat) echo "anon 104857600" ;;
            psql)
                n=$(sed 's/.* -d node\([0-9]*\)_db .*/\1/' <<< "$*")
                case "${STUB_PSQL_KILL:-}" in "${n}:"*) case "$*" in *"${STUB_PSQL_KILL#*:}"*) kill -KILL $$ ;; esac ;; esac
                case "$*" in
                    *"SHOW max_connections"*) echo "${STUB_MAXCONN:-1000}" ;;
                    *" -f -") cat > /dev/null; touch "${S}/rewritten.${n}" ;;
                    *"max(number)"*) head_now ;;
                    *"SELECT content FROM"*) printf '{"peerlist":[%s],"timestamp":1}\n' "$(peerlist)" ;;
                    *json_array_length*) if [ -e "${S}/rewritten.${n}" ]; then echo 6; else echo "${STUB_N}"; fi ;;
                    *BETWEEN*)
                        read -r from to < <(sed 's/.*BETWEEN \([0-9]*\) AND \([0-9]*\).*/\1 \2/' <<< "$*")
                        h=$(head_now); [ "${to}" -gt "${h}" ] && to="${h}"
                        for b in $(seq "${from}" "${to}"); do echo "${b}|0xb${b}|7"; done ;;
                esac ;;
        esac ;;
    inspect)
        case "$*" in
            *RestartCount*) stalls restart; echo 0 ;;
            *LogConfig*) echo "${STUB_LOGCONF:-null}" ;;
            *) echo "/qdrill-${@: -1}" ;;
        esac ;;
    stats) shift 4; for c in "$@"; do echo "${c} 100MiB / 1.8GiB 1.00%"; done ;;
    logs)
        n=${@: -1}; n=${n#c}; stalls "logs:${n}"
        printf '[INFO] node-%s up\n\e[32m[INFO] We are forging block %s\e[0m\n' "${n}" $(($(head_now) + 1))
        printf '[WARN] Shard of 4 is below the quorum of 7\n[INFO] drawing the committee from all 10 staked validators\n'
        if [ "${STUB_LATE_HIT:-}" = "${n}" ] && [ -s "${STUB_RESULTS}" ] && [ "$(wc -l < "${STUB_RESULTS}")" -ge 2 ]; then
            echo "FATAL:  sorry, too many clients already"
        fi ;;
esac
exit 0
FULLDOCKER
chmod +x "${WORK}/fullbin/"*
full_run() { # $1 label, $2.. run.sh's options and scenario; STUB_* from the caller. FULL, RD (the run dir), ms
    local label="$1" t0; shift
    FULL="${WORK}/full-${label}"; rm -rf "${FULL}"; mkdir -p "${FULL}/state" "${FULL}/runs"; echo "0 0" > "${FULL}/state/chain"
    t0=$(date +%s%N)
    STUB_STATE="${FULL}/state" STUB_LOG="${FULL}/docker.log" STUB_RESULTS="${FULL}/runs/results.tsv" PATH="${WORK}/fullbin:${PATH}" RUNS_DIR="${FULL}/runs" \
        QDRILL_TEST_LOG_READ_TIMEOUT_S=3 NODE_EST_MB=1 HEADROOM_MB=0 MIN_DISK_GB=0 GENESIS_DELAY=-1000 \
        CONSENSUS_TIME=1 STALL_WINDOW=3 timeout 240 bash "${RUN_SH}" "$@" "${label}" > "${FULL}/out" 2>&1
    echo "rc=$?" >> "${FULL}/out"
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
    RD=$(compgen -G "${FULL}/runs/*-${label}" | head -1)
    tail -3 "${FULL}/out" | cut -c1-200 | sed 's/^/    | /'
}
fout() { grep -q -- "$1" "${FULL}/out"; }
exited() { grep -qE "^rc=($1)$" "${FULL}/out"; } # $1 a regex of exit statuses
result_of() { jq -r .result "${RD}/logs/verdict.json" 2>/dev/null; }
row_of() { awk -F'\t' -v r="${RD##*/}" '$1 == r { print $9 }' "${FULL}/runs/results.tsv" 2>/dev/null; }
# verdict.json and this run's row of results.tsv both say $1, and the detail holds $2 (if given)
recorded() { [ "$(result_of)" = "$1" ] && [ "$(row_of)" = "$1" ] && jq -e --arg d "${2:-}" '.detail | contains($d)' "${RD}/logs/verdict.json" > /dev/null; }

echo "== drop-n7s10 --binding off, whole: stops node-7 mid-round, waits out the stall, restarts it, writes the verdict"
# Whether the chain stalls in time is up to the host's speed: PASS or FAIL both reach the verdict
STUB_N=7 STUB_MIN_LIVE=7 STUB_TICK_MS=1000 STUB_LOGCONF='{"max-file":"3","max-size":"10m"}' full_run drop-off --binding off drop-n7s10
check "drop-n7s10 --binding off: no 'command not found'" eval '! fout "command not found"'
check "drop-n7s10 --binding off: a verdict (PASS or FAIL: $(result_of)), exit 0 or 1, and its row in results.tsv" \
    bash -c 'case "$1" in PASS | FAIL) [ "$1" = "$2" ] ;; *) false ;; esac' _ "$(result_of)" "$(row_of)"
check "drop-n7s10 --binding off: exit 0 for a PASS, 1 for a FAIL" exited "$([ "$(result_of)" = PASS ] && echo 0 || echo 1)"
check "drop-n7s10 --binding off: the genesis has committeeBinding and commitLock off, quorumParity at 0" \
    jq -e '.forks.committeeBinding.activationHeight == null and .forks.commitLock.activationHeight == null and .forks.quorumParity.activationHeight == 0' "${RD}/inputs/genesis.json"
check "drop-n7s10 --binding off: the run log names the node containers' log rotation" fout 'node log rotation: max-size 10m, max-file 3$'
check "drop-n7s10 --binding off: the bring-up snapshot has the stats and anonymous memory of the 8 containers" \
    test "$(grep -c ' 100MiB / 1.8GiB ' "${RD}/logs/03-bringup.log")" = 8 -a "$(grep -c ' anon 100 MiB$' "${RD}/logs/03-bringup.log")" = 8
check "drop-n7s10 --binding off: stop_mid_round saw the round start in node-1's log" grep -q 'round start seen on node-1: We are forging block [0-9]' "${RD}/logs/events.log"
check "drop-n7s10 --binding off: the phases all-up, down-1 and restarted were judged" \
    test "$(cut -f1 "${RD}/phases.tsv" | tail -n +2 | tr '\n' ' ')" = "all-up down-1 restarted "

echo "== fallback, whole: the peerlist rewrite goes to the postgres container pg_cid looked up"
STUB_N=10 STUB_MIN_LIVE=7 full_run fallback-on fallback
check "fallback: exit 0, and verdict.json and results.tsv say PASS" eval 'exited 0 && recorded PASS'
check "fallback: every node database rewritten through the container the lookup gave (10)" \
    test "$(grep -c '^exec -i -e PGCONNECT_TIMEOUT=10 -e PGOPTIONS=-c statement_timeout=20000 fakepg psql -U demosuser -d node[0-9]*_db -v ON_ERROR_STOP=1 -q -f -$' "${FULL}/docker.log")" = 10
check "fallback: the fallback lines of all 10 node logs counted" fout 'fallback log lines: 10$'
check "fallback: no rotation options set on the containers: said so" fout 'node log rotation: max-size/max-file none set$'

echo "== ride-n13s10, whole: restart counts of the 10 survivors before and after, the judge's pass"
STUB_N=13 STUB_MIN_LIVE=1 STUB_LOGCONF='{"max-size":"20m"}' full_run ride ride-n13s10
check "ride-n13s10: exit 0, and verdict.json and results.tsv say PASS" eval 'exited 0 && recorded PASS'
check "ride-n13s10: the judge got restart counts of the 10 survivors, before and after" \
    jq -e '(.restartCounts.before | length) == 10 and (.restartCounts.after | length) == 10' "${RD}/drill-input.json"
check "ride-n13s10: one rotation option set: the other is named as none set" fout 'node log rotation: max-size 20m, max-file none set$'
STUB_N=13 STUB_MIN_LIVE=1 STUB_JUDGE=refuse full_run ride-refused ride-n13s10
check "ride-n13s10, the judge refuses the fork set (exit 2): ERROR, exit 2, and the detail names the fork" \
    eval 'exited 2 && recorded ERROR "(exit 2); forks.commitLock: the drill needs commitLock active at block 0, got null"'

echo "== a stalled docker call fails the run closed, within the bound, never as a pass"
# Each stalled call sleeps 300 s: a run that waited one out would take over 300 s
STUB_N=4 STUB_MIN_LIVE=99 STUB_STALL=logs:2 full_run floor-stall --binding off floor
check "floor, node-2's docker logs stalls: exit 2 (the other logs' refusals would have made a pass)" exited 2
check "floor, node-2's docker logs stalls: the WARN names node-2 and the bound" fout 'WARN: node-2: docker logs did not answer within 3s, its log not read whole'
check "floor, node-2's docker logs stalls: verdict.json and results.tsv say ERROR, node log unreadable" recorded ERROR 'floor: node log unreadable'
check "floor, node-2's docker logs stalls: within the bound (${ms} ms)" test "${ms}" -lt 120000
STUB_N=13 STUB_MIN_LIVE=1 STUB_STALL=restart full_run ride-stall ride-n13s10
check "ride-n13s10, the restart count inspect stalls: exit 2, ABORT, no verdict" \
    eval 'exited 2 && fout "ABORT: cannot read the survivors. restart counts" && [ ! -e "${RD}/logs/verdict.json" ]'
check "ride-n13s10, the restart count inspect stalls: within the bound (${ms} ms)" test "${ms}" -lt 120000
STUB_N=7 STUB_MIN_LIVE=7 STUB_TICK_MS=1000 STUB_STALL=head:1 full_run drop-stall drop-n7s10
check "drop-n7s10, node-1's head reads stall after the stop: exit 2" exited 2
check "drop-n7s10, node-1's head reads stall after the stop: ERROR, node-1 unread" fout 'ERROR: down-1: a running node does not answer its head (heads n1=? '
check "drop-n7s10, node-1's head reads stall after the stop: verdict.json and results.tsv say ERROR" recorded ERROR 'down-1: node unreadable'
check "drop-n7s10, node-1's head reads stall after the stop: within the bound (${ms} ms)" test "${ms}" -lt 120000
# Up to b4ccfffd3f stop_mid_round stopped node-7 anyway, and the drill could pass
STUB_N=7 STUB_MIN_LIVE=7 STUB_TICK_MS=1000 STUB_STALL=logs:1 full_run drop-unseen drop-n7s10
check "drop-n7s10, node-1's docker logs stalls as stop_mid_round waits for a round start: exit 2, ERROR saying so" \
    eval 'exited 2 && fout "ERROR: stop node-7: no round start seen on node-1 (docker logs did not answer within 3s); node-7 not stopped"'
check "drop-n7s10, node-1's docker logs stalls as stop_mid_round waits: verdict.json and results.tsv say ERROR" \
    recorded ERROR 'stop node-7: round start unseen on node-1 (docker logs did not answer within 3s)'
check "drop-n7s10, node-1's docker logs stalls as stop_mid_round waits: node-7 is never stopped" bash -c '! grep -q " stop -t 0 node-7$" "$1"' _ "${FULL}/docker.log"
check "drop-n7s10, node-1's docker logs stalls as stop_mid_round waits: within the bound (${ms} ms)" test "${ms}" -lt 120000

echo "== floor --binding off, whole, a connection-limit hit logged after the verdict: the row is rewritten under the lock"
STUB_N=4 STUB_MIN_LIVE=99 STUB_LATE_HIT=2 full_run floor-late --binding off floor
check "floor, late hit: exit 0 replaced by 2" eval 'exited 2 && fout "postgres connection limit hit (exit 0 replaced by 2"'
check "floor, late hit: verdict.json and results.tsv say ERROR, and that the result was PASS" \
    recorded ERROR 'could not run: postgres connection limit hit (in the logs collected at teardown: node-2.log); the result was PASS'
check "floor, late hit: one row, and the lock file next to results.tsv" \
    test "$(wc -l < "${FULL}/runs/results.tsv") $([ -e "${FULL}/runs/results.tsv.lock" ] && echo lock)" = "2 lock"

echo "== fallback, whole, node-3's head read from its database killed with nothing on stderr: none given, still exit 2"
STUB_N=10 STUB_MIN_LIVE=7 STUB_PSQL_KILL='3:max(number)' full_run fallback-killed fallback
check "fallback, psql killed: says the error text was none given, with the exit status" fout 'psql node3_db: exit 137, error text: none given ('
check "fallback, psql killed: not that its errors could not be written" eval '! fout "could not be written"'
check "fallback, psql killed: exit 2, the gate's ERROR naming the kept file, the result it replaced" \
    eval 'exited 2 && recorded ERROR "(psql errors not written to it, kept in ${RD}/logs/psql-err." && recorded ERROR "; the result was PASS"'

echo "== flock missing: run.sh does not start, and says why"
# PATH: the stubs and links to every command of /usr/bin and /bin but flock
mkdir -p "${WORK}/noflock"
cp -s /usr/bin/* /bin/* "${WORK}/noflock/" 2> /dev/null
rm -f "${WORK}/noflock/flock"
: > "${WORK}/noflock.docker.log"
OUT=$(STUB_LOG="${WORK}/noflock.docker.log" STUB_MAXCONN=280 STUB_START=run-devnet STUB_LOGDRIVER=json-file \
    PATH="${WORK}/runbin:${WORK}/noflock" RUNS_DIR="${WORK}/noflock-runs" NODE_EST_MB=1 HEADROOM_MB=0 MIN_DISK_GB=0 \
    timeout 60 bash "${RUN_SH}" floor noflock 2>&1; echo "rc=$?")
check "(no flock on that PATH)" env PATH="${WORK}/runbin:${WORK}/noflock" bash -c '! command -v flock > /dev/null'
check "flock missing: exit 2 with an ABORT that names it" \
    bash -c 'grep -q "^rc=2$" <<< "$1" && grep -q "ABORT: flock (util-linux) is not installed" <<< "$1"' _ "${OUT}"
check "flock missing: no container started" bash -c '! grep -q "^compose " "$1"' _ "${WORK}/noflock.docker.log"

echo
if [ "${fails}" = 0 ]; then echo "lockstep stub tests: all passed"; else echo "lockstep stub tests: ${fails} FAILED"; exit 1; fi
