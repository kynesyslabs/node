#!/usr/bin/env bash
# Multi-node L2PS stress test.
#
# Hammers one L2PS subnet across every node of a running devnet in
# parallel, then aggregates per-node throughput and failure counts into
# a single verdict. Fills the gap left by scripts/l2ps-stress-test.ts,
# which only targets a single RPC.
#
# Assumes a devnet is ALREADY running (see testing/devnet/) with the
# target L2PS subnet loaded on every node.
#
# Usage:
#   scripts/l2ps-multinode-stress.sh
#   COUNT=500 L2PS_UID=live_local_001 scripts/l2ps-multinode-stress.sh
#   TARGETS=http://127.0.0.1:53551,http://127.0.0.1:53553 scripts/l2ps-multinode-stress.sh
#
# Env:
#   TARGETS            comma-separated RPC URLs (default: devnet nodes 1-4)
#   L2PS_UID           L2PS subnet uid (default: live_local_001)
#   COUNT              transactions per node (default: 200)
#   DELAY              inter-tx delay ms (default: 50)
#   WALLETS            wallets JSON path (default: data/test-wallets.json,
#                      auto-generated if absent)
#   WALLET_COUNT       wallets to generate if WALLETS is absent (default: 20)
#   FAIL_THRESHOLD_PCT aggregate failure %% that fails the run (default: 5)
#
# Exit: 0 all nodes within threshold · 1 preflight · 2 a node crashed
#       · 3 aggregate failure rate over threshold

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

TARGETS="${TARGETS:-http://127.0.0.1:53551,http://127.0.0.1:53553,http://127.0.0.1:53555,http://127.0.0.1:53557}"
# NB: $UID is a bash builtin (the real user id) — read L2PS_UID instead.
UID_VAL="${L2PS_UID:-live_local_001}"
COUNT="${COUNT:-200}"
DELAY="${DELAY:-50}"
WALLETS="${WALLETS:-data/test-wallets.json}"
WALLET_COUNT="${WALLET_COUNT:-20}"
FAIL_THRESHOLD_PCT="${FAIL_THRESHOLD_PCT:-5}"

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RUN_DIR="./testing/runs/l2ps-multinode-${TS}"
mkdir -p "$RUN_DIR"

C_DIM='\033[0;90m'; C_GRN='\033[0;32m'; C_RED='\033[0;31m'; C_YLW='\033[0;33m'; C_RST='\033[0m'
log()  { printf "${C_DIM}[%s] %s${C_RST}\n" "$(date -u +%H:%M:%S)" "$*"; }
pass() { printf "${C_GRN}✔ %s${C_RST}\n" "$*"; }
fail() { printf "${C_RED}✘ %s${C_RST}\n" "$*"; }
warn() { printf "${C_YLW}⚠ %s${C_RST}\n" "$*"; }

require() { command -v "$1" >/dev/null 2>&1 || { fail "missing tool: $1"; exit 1; }; }
require bunx; require curl

IFS=',' read -ra TARGET_ARR <<< "$TARGETS"
NODE_N=${#TARGET_ARR[@]}
log "targets: ${NODE_N} node(s) · subnet=${UID_VAL} · ${COUNT} tx/node · delay=${DELAY}ms"

# ---------------- preflight: reachability ------------------------------
for t in "${TARGET_ARR[@]}"; do
    if ! curl -sf "${t}/info" >/dev/null 2>&1; then
        fail "node not reachable: ${t} — is the devnet up?"
        exit 1
    fi
done
pass "all ${NODE_N} nodes reachable"

# ---------------- ensure test wallets ----------------------------------
if [[ ! -f "$WALLETS" ]]; then
    log "wallets file ${WALLETS} absent — generating ${WALLET_COUNT}"
    bunx tsx scripts/generate-test-wallets.ts \
        --count "$WALLET_COUNT" --output "$WALLETS" >>"${RUN_DIR}/wallets.log" 2>&1 \
      || { fail "wallet generation failed — see ${RUN_DIR}/wallets.log"; exit 1; }
fi
pass "wallets: ${WALLETS}"

# ---------------- launch per-node stress in parallel -------------------
log "launching ${NODE_N} parallel stress workers"
PIDS=()
declare -A NODE_LOG
i=0
for t in "${TARGET_ARR[@]}"; do
    i=$((i + 1))
    nlog="${RUN_DIR}/node-${i}.log"
    NODE_LOG[$i]="$nlog"
    ( bunx tsx scripts/l2ps-stress-test.ts \
        --node "$t" --uid "$UID_VAL" --count "$COUNT" \
        --delay "$DELAY" --wallets-file "$WALLETS" >"$nlog" 2>&1 ) &
    PIDS+=($!)
    log "  worker ${i} → ${t} (pid $!)"
done

# ---------------- wait + collect exit codes ----------------------------
declare -A NODE_EXIT
i=0
for pid in "${PIDS[@]}"; do
    i=$((i + 1))
    if wait "$pid"; then NODE_EXIT[$i]=0; else NODE_EXIT[$i]=$?; fi
done

# ---------------- aggregate --------------------------------------------
TOTAL_OK=0; TOTAL_FAIL=0; CRASHED=0
echo "" | tee -a "${RUN_DIR}/SUMMARY.txt"
printf "%-6s %-32s %-8s %-8s %-10s\n" "node" "rpc" "ok" "failed" "tps" | tee -a "${RUN_DIR}/SUMMARY.txt"
i=0
for t in "${TARGET_ARR[@]}"; do
    i=$((i + 1))
    nlog="${NODE_LOG[$i]}"
    # l2ps-stress-test.ts only exits non-zero on a catastrophic throw;
    # per-tx success/fail is parsed from its printed summary.
    ok=$(grep -oE 'Successful: [0-9]+' "$nlog" 2>/dev/null | grep -oE '[0-9]+' | head -1)
    fl=$(grep -oE 'Failed: [0-9]+' "$nlog" 2>/dev/null | grep -oE '[0-9]+' | head -1)
    tps=$(grep -oE 'Average TPS: [0-9.]+' "$nlog" 2>/dev/null | grep -oE '[0-9.]+' | head -1)
    ok=${ok:-0}; fl=${fl:-0}; tps=${tps:-0}
    if (( NODE_EXIT[$i] != 0 )); then
        CRASHED=$((CRASHED + 1))
        printf "${C_RED}%-6s %-32s %-8s %-8s %-10s${C_RST}\n" "$i" "$t" "CRASH" "-" "-" | tee -a "${RUN_DIR}/SUMMARY.txt"
    else
        printf "%-6s %-32s %-8s %-8s %-10s\n" "$i" "$t" "$ok" "$fl" "$tps" | tee -a "${RUN_DIR}/SUMMARY.txt"
    fi
    TOTAL_OK=$((TOTAL_OK + ok))
    TOTAL_FAIL=$((TOTAL_FAIL + fl))
done

TOTAL_TX=$((TOTAL_OK + TOTAL_FAIL))
echo "" | tee -a "${RUN_DIR}/SUMMARY.txt"
log "aggregate: ${TOTAL_OK} ok / ${TOTAL_FAIL} failed across ${NODE_N} nodes (${TOTAL_TX} tx)"

if (( CRASHED > 0 )); then
    fail "${CRASHED} node worker(s) crashed — see ${RUN_DIR}/node-*.log"
    exit 2
fi

if (( TOTAL_TX == 0 )); then
    fail "no transactions recorded — check ${RUN_DIR}/node-*.log"
    exit 2
fi

FAIL_PCT=$(( TOTAL_FAIL * 100 / TOTAL_TX ))
if (( FAIL_PCT > FAIL_THRESHOLD_PCT )); then
    fail "aggregate failure rate ${FAIL_PCT}% > threshold ${FAIL_THRESHOLD_PCT}%"
    log "logs: ${RUN_DIR}/"
    exit 3
fi

pass "ALL GREEN — ${TOTAL_OK}/${TOTAL_TX} tx ok (${FAIL_PCT}% fail, threshold ${FAIL_THRESHOLD_PCT}%)"
log "logs: ${RUN_DIR}/"
