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

echo
if [ "${fails}" = 0 ]; then echo "lockstep stub tests: all passed"; else echo "lockstep stub tests: ${fails} FAILED"; exit 1; fi
