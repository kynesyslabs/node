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
check "retried (3 tries in a 12 s window)" has "3 tries"
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
echo "${OUT}" | tail -1; echo "  elapsed ${ms} ms (13 sequential reads of heads and then hashes would be 26000+)"
check "returns 0" has "rc=0 h=25"
check "finishes in under 5 s" test "${ms}" -lt 5000
check "takes at least 2 s (one head round, one hash round)" test "${ms}" -ge 2000

echo "== database reads (psql_node, block_rows) are bounded; a timed-out read is a failure, not an empty result"
fn_src() { # $1 function name: its definition, from `name() {` to the first line that is `}`
    awk -v a="$1() {" 'index($0, a) == 1 { on = 1 } on { print } on && /^}/ { exit }' "${RUN_SH}"
}
for f in psql_node pg_limit_preflight pg_limit_gate; do source <(fn_src "${f}"); done
source <(grep -E '^(DB_TIMEOUT_S|PG_LIMITS)=' "${RUN_SH}")
source <(region 'block_rows() {' 'phase_row() {')
dc() { echo fakepg; }
mkdir -p "${WORK}/bin"
# docker exec ... psql: FAKE_DB is rows (default), hang, stmt (the server cancels the
# query) or toomany (the server is out of connections); SHOW max_connections
# answers FAKE_MAXCONN (default 100, the postgres default)
cat > "${WORK}/bin/docker" <<'FAKEDOCKER'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_DOCKER_LOG}"
case "$*" in *"SHOW max_connections"*) echo "${FAKE_MAXCONN:-100}"; exit 0 ;; esac
case "${FAKE_DB:-rows}" in
    hang) sleep 30 ;;
    stmt) echo "ERROR:  canceling statement due to statement timeout" >&2; exit 1 ;;
    toomany) echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  sorry, too many clients already' >&2; exit 2 ;;
    *) printf '5|0xb5|7\n6|0xb6|8\n' ;;
esac
FAKEDOCKER
chmod +x "${WORK}/bin/docker"
export FAKE_DOCKER_LOG="${WORK}/docker.log"
PATH="${WORK}/bin:${PATH}"
check "run.sh bounds its database calls at 30 s" test "${DB_TIMEOUT_S}" = 30
new_case dbread 25; DB_TIMEOUT_S=1

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
check "and says which node, and that it got no answer" has "psql node1_db: no answer within 1s"
check "and the block rows message names node-1" has "of node-1 could not be read"
check "within DB_TIMEOUT_S, not 30" test "${ms}" -lt 4000

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
grep_logs() { # the node logs of the fake: nodelog.<node>
    local f
    for f in "${FAKE}"/nodelog.*; do [ -e "${f}" ] || continue; grep -a "$1" "${f}" | sed "s/^/node-${f##*.}: /"; done
}
write_verdict() { echo "VERDICT ${RESULT}: ${DETAIL}"; }
for verdict in PASS FAIL; do
    new_case gate_clean 25; RESULT=${verdict}; DETAIL="phases fine"
    echo "FATAL: nothing wrong" > "${FAKE}/nodelog.1"
    OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
    check "no hit, ${verdict}: the gate lets it through" has "rc=0"
    check "no hit, ${verdict}: and writes nothing" test "$(grep -c VERDICT <<< "${OUT}")" = 0

    new_case gate_nodes 25; RESULT=${verdict}; DETAIL="phases fine"
    printf 'ok line\nerror: sorry, too many clients already\n' > "${FAKE}/nodelog.7"
    printf 'FATAL:  sorry, too many clients already\n' > "${FAKE}/nodelog.11"
    OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
    check "node logs hit, ${verdict}: exit 2" has "rc=2"
    check "node logs hit, ${verdict}: says could not run: postgres connection limit hit" has "ABORT: could not run: postgres connection limit hit (2 'too many clients' lines; node-11 node-7 )"
    check "node logs hit, ${verdict}: the verdict is ERROR and keeps what the result was" has "VERDICT ERROR: could not run: postgres connection limit hit (2 lines in node-11 node-7); the result was ${verdict}"
done

new_case gate_psql 25; DB_TIMEOUT_S=2; RESULT=PASS; DETAIL="phases fine"
OUT=$(FAKE_DB=toomany psql_node 3 "SELECT 1" 2>&1; echo "rc=$?")
check "a psql_node read refused for connections still fails (rc=2) and shows the server's words" has "too many clients already"
check "(psql's own exit code is passed on)" has "rc=2"
check "and is recorded in psql-errors.log, with the database" grep -q "psql node3_db: .*too many clients already" "${LOG_DIR}/psql-errors.log"
OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
check "a harness read that hit the limit, node logs clean: the gate exits 2" has "rc=2"
check "and says so" has "postgres connection limit hit (1 'too many clients' lines; harness psql reads only)"
new_case gate_psql_ok 25; DB_TIMEOUT_S=2; RESULT=PASS; DETAIL="phases fine"
FAKE_DB=stmt psql_node 3 "SELECT 1" > /dev/null 2>&1
OUT=$( ( pg_limit_gate ) 2>&1; echo "rc=$?" )
check "another psql error is not a connection-limit hit" has "rc=0"

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
# node, which fails for node STUB_MIGRATE_FAIL.
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
boot_failure_of() { # $1 the node's log, as docker logs prints it
    ( BOOT_LOG="$1"; dc() { echo cid1; }; docker() { printf '%s\n' "${BOOT_LOG}"; }; boot_failure_line 1 )
}
REFUSED=$'[INFO] [GENESIS] Looking for the genesis block...\n\e[31m[ERROR] [GENESIS] Refusing to boot: identityCarryover is active at genesis but no snapshot was found\e[0m\n[ERROR] unrelated error\n'
check "a genesis refusal is found, without colour codes, even with a later error line" \
    test "$(boot_failure_of "${REFUSED}")" = "[ERROR] [GENESIS] Refusing to boot: identityCarryover is active at genesis but no snapshot was found"
check "with no refusal the last error line is given" \
    test "$(boot_failure_of $'[INFO] up\n[ERROR] connect ECONNREFUSED\n[INFO] retrying')" = "[ERROR] connect ECONNREFUSED"
check "a log with neither gives nothing, and rc 0" \
    bash -c '[ -z "$1" ]' _ "$(boot_failure_of $'[INFO] up\n[INFO] bye')"

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
    STUB_LOG="${STUB_LOG}" STUB_MAXCONN="$1" STUB_START="${2:-run-devnet}" STUB_MIGRATE_FAIL="${3:-none}" \
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

run_from_top 100
sed 's/^/    | /' "${WORK}/run-top.out" | tail -5 | cut -c1-200
check "max_connections 100: no 'command not found'" bash -c '! grep -q "command not found" "$1"' _ "${WORK}/run-top.out"
check "max_connections 100: exit 2 with the could-not-run message" out_has 'ABORT: could not run: postgres max_connections is 100, 13 nodes need 150'
check "max_connections 100: rc=2" out_has '^rc=2$'
check "max_connections 100: no node was started" bash -c '! grep -q "compose .* up -d node-" "$1"' _ "${WORK}/run-top.docker.log"

echo "== run.sh executed from the top on the image path: preflight, then one migration per node database, then node-1"
migrations() { grep -c 'compose .* run --rm --no-deps -T --entrypoint bun node-[0-9]* -r tsconfig-paths/register ./node_modules/typeorm/cli.js migration:run' "${WORK}/run-top.docker.log"; }
first_line() { grep -n -- "$1" "${WORK}/run-top.docker.log" | head -1 | cut -d: -f1; }
run_from_top 280 image
sed 's/^/    | /' "${WORK}/run-top.out" | tail -4 | cut -c1-200
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

echo
if [ "${fails}" = 0 ]; then echo "lockstep stub tests: all passed"; else echo "lockstep stub tests: ${fails} FAILED"; exit 1; fi
