#!/usr/bin/env bash
# Multi-node upgradable-network governance stress test.
#
# Runs repeated propose → vote → tally → activate cycles on a 4-node
# devnet WHILE a background native-tx load hammers the chain, and after
# every round asserts that the proposal's lifecycle status is identical
# on all four nodes. The stress dimensions are:
#   - governance machinery exercised repeatedly (ROUNDS cycles)
#   - every voting window runs under concurrent tx load
#   - strict cross-node consistency check at tally and activation
#
# Concurrent-proposal *conflict* semantics (two proposals on one param
# key) are covered by tests/governance/concurrentProposals.test.ts and
# are out of scope here.
#
# Boots its own devnet (FAST mode shrinks the voting/grace windows so
# many cycles are tractable). Self-cleaning.
#
# Usage:
#   scripts/governance-multinode-stress.sh
#   ROUNDS=5 scripts/governance-multinode-stress.sh
#   KEEP_DEVNET=1 NO_LOAD=1 scripts/governance-multinode-stress.sh
#
# Env:
#   ROUNDS         governance cycles to run (default 3)
#   BASE_FEE       starting networkFee; each round proposes BASE_FEE+round (default 11)
#   CONSENSUS_TIME seconds per block (default 2)
#   NO_LOAD=1      disable the background tx load (governance-only)
#   KEEP_DEVNET=1  leave the devnet up on exit
#
# Exit: 0 all rounds green · 1 setup · 2 staking · 3 a round failed
#       · 4 cross-node divergence

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

ROUNDS="${ROUNDS:-3}"
BASE_FEE="${BASE_FEE:-11}"
COMPOSE_FILE="testing/devnet/docker-compose.yml"
PG_CONTAINER="demos-devnet-postgres"
DB_USER="demosuser"
NODE_DBS=(node1_db node2_db node3_db node4_db)
RPC_PORTS=(53551 53553 53555 53557)
ID_FILES=(.devnet/canon_id1 .devnet/canon_id2 .devnet/canon_id3 .devnet/canon_id4)
RPC1="http://127.0.0.1:53551"
STAKE_AMOUNT="1000000000000000000"
RECIPIENT="${RECIPIENT:-0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c}"

# FAST windows — a stress test wants many cycles, not realistic timing.
export CONSENSUS_TIME="${CONSENSUS_TIME:-2}"
VOTING_WINDOW=10
GRACE_PERIOD=5
EFFECTIVE_OFFSET=18
ROUND_TIMEOUT=$((120 * CONSENSUS_TIME))

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RUN_DIR="./e2e-runs/governance-stress-${TS}"
mkdir -p "${RUN_DIR}"
SUMMARY="${RUN_DIR}/SUMMARY.txt"
LOAD_FLAG="${RUN_DIR}/.load-running"

C_DIM='\033[0;90m'; C_GRN='\033[0;32m'; C_RED='\033[0;31m'; C_YLW='\033[0;33m'; C_RST='\033[0m'
log()  { printf "${C_DIM}[%s] %s${C_RST}\n" "$(date -u +%H:%M:%S)" "$*" | tee -a "${SUMMARY}"; }
pass() { printf "${C_GRN}✔ %s${C_RST}\n" "$*" | tee -a "${SUMMARY}"; }
fail() { printf "${C_RED}✘ %s${C_RST}\n" "$*" | tee -a "${SUMMARY}"; }
warn() { printf "${C_YLW}⚠ %s${C_RST}\n" "$*" | tee -a "${SUMMARY}"; }

require() { command -v "$1" >/dev/null 2>&1 || { fail "missing tool: $1"; exit 1; }; }
require docker; require curl; require jq; require bunx

[[ -f "${ID_FILES[0]}" ]] || { fail "devnet identities missing — run scripts/upgradable-network/gen-identity.ts"; exit 1; }

# ---------------- helpers (lifted from upgradable-network/e2e.sh) -------
rpc_block() { curl -s "${1}/info" 2>/dev/null | jq -r '.peerlist[0].sync.block' 2>/dev/null; }
wait_for_block() {
    local target="$1" timeout="$2" rpc="${3:-$RPC1}" elapsed=0 b=0
    while (( elapsed < timeout )); do
        b="$(rpc_block "$rpc")"
        if [[ "$b" =~ ^[0-9]+$ ]] && (( b >= target )); then echo "$b"; return 0; fi
        sleep 5; elapsed=$((elapsed + 5))
    done
    echo "$b"; return 1
}
psql_n() {
    local n="$1"; shift
    docker exec "${PG_CONTAINER}" psql -U "${DB_USER}" -d "${NODE_DBS[$((n-1))]}" -t -A -c "$*" 2>/dev/null
}
assert_eq_all_nodes() {
    local label="$1" sql="$2" expected="$3" log_file="${RUN_DIR}/$4" ok=1
    {
        echo "QUERY: $sql"; echo "EXPECTED: $expected"; echo
        for n in 1 2 3 4; do
            actual="$(psql_n "$n" "$sql")"
            echo "node-$n: $actual"
            [[ "$actual" == "$expected" ]] || ok=0
        done
    } > "$log_file"
    if (( ok == 1 )); then pass "$label"; return 0; else fail "$label (see $log_file)"; return 1; fi
}

# ---------------- background tx load ------------------------------------
cat > "${RUN_DIR}/_pay.ts" <<'TS'
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { readFileSync } from "fs"
async function main() {
  const [, , mnFile, rpc, recipient] = process.argv
  const d = new Demos()
  await d.connect(rpc)
  await d.connectWallet(readFileSync(mnFile, "utf8").trim())
  const tx = await d.pay(recipient, 1, d)
  await d.confirm(tx)
}
main().catch(e => { console.error("ERR:" + (e as Error).message); process.exit(1) })
TS

load_loop() {
    local sent=0
    while [[ -f "${LOAD_FLAG}" ]]; do
        bunx tsx "${RUN_DIR}/_pay.ts" "${ID_FILES[0]}" "${RPC1}" "${RECIPIENT}" \
            >> "${RUN_DIR}/load.log" 2>&1 && sent=$((sent + 1))
        echo "$sent" > "${RUN_DIR}/.load-count"
        sleep 1
    done
}
LOAD_PID=""
start_load() {
    [[ "${NO_LOAD:-0}" == "1" ]] && { log "  background load disabled (NO_LOAD=1)"; return; }
    touch "${LOAD_FLAG}"; load_loop & LOAD_PID=$!
}
stop_load() {
    [[ -z "${LOAD_PID}" ]] && return
    rm -f "${LOAD_FLAG}"; wait "${LOAD_PID}" 2>/dev/null || true; LOAD_PID=""
}

# ---------------- cleanup -----------------------------------------------
cleanup() {
    local code="$1"
    rm -f "${LOAD_FLAG}"; [[ -n "${LOAD_PID}" ]] && kill "${LOAD_PID}" 2>/dev/null || true
    mv "${RUN_DIR}/constants.ts.orig" src/features/networkUpgrade/constants.ts 2>/dev/null || true
    if [[ "${KEEP_DEVNET:-0}" == "1" ]]; then
        warn "KEEP_DEVNET=1 — devnet left running. docker compose -f ${COMPOSE_FILE} down -v"
    else
        log "tearing down devnet"
        docker compose -f "${COMPOSE_FILE}" down -v >> "${RUN_DIR}/teardown.log" 2>&1 || true
    fi
    log "run artifacts: ${RUN_DIR}/"
    exit "$code"
}
trap 'cleanup ${?:-1}' EXIT

# ---------------- step 0: FAST windows ----------------------------------
log "patching VOTING_WINDOW_BLOCKS=${VOTING_WINDOW} / GRACE_PERIOD_BLOCKS=${GRACE_PERIOD}"
cp src/features/networkUpgrade/constants.ts "${RUN_DIR}/constants.ts.orig"
sed -i "s/^export const VOTING_WINDOW_BLOCKS = 100$/export const VOTING_WINDOW_BLOCKS = ${VOTING_WINDOW}/" src/features/networkUpgrade/constants.ts
sed -i "s/^export const GRACE_PERIOD_BLOCKS = 50$/export const GRACE_PERIOD_BLOCKS = ${GRACE_PERIOD}/" src/features/networkUpgrade/constants.ts

# ---------------- step 1: boot devnet -----------------------------------
log "building + booting 4-node devnet (CONSENSUS_TIME=${CONSENSUS_TIME}s)"
docker compose -f "${COMPOSE_FILE}" build > "${RUN_DIR}/build.log" 2>&1 || { fail "build failed"; exit 1; }
docker compose -f "${COMPOSE_FILE}" down -v > "${RUN_DIR}/down.log" 2>&1 || true
docker compose -f "${COMPOSE_FILE}" up -d > "${RUN_DIR}/up.log" 2>&1 || { fail "compose up failed"; exit 1; }
START_BLOCK="$(wait_for_block 5 120)" || { fail "devnet did not reach block 5 in 120s"; exit 1; }
pass "devnet healthy at block ${START_BLOCK}"

# ---------------- step 2: stake 4 validators ----------------------------
log "staking 4 validators"
pids=()
for n in 1 2 3 4; do
    MNEMONIC_FILE="${ID_FILES[$((n-1))]}" RPC_URL="http://127.0.0.1:${RPC_PORTS[$((n-1))]}" \
        bunx tsx scripts/upgradable-network/cli.ts stake "${STAKE_AMOUNT}" \
        > "${RUN_DIR}/stake-${n}.log" 2>&1 &
    pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
for n in 1 2 3 4; do
    grep -q '"confirmationBlock"' "${RUN_DIR}/stake-${n}.log" \
      || { fail "validator ${n} stake failed (stake-${n}.log)"; exit 2; }
done
for try in {1..24}; do
    all=1
    for n in 1 2 3 4; do [[ "$(psql_n "$n" 'SELECT count(*) FROM validators')" == "4" ]] || all=0; done
    (( all == 1 )) && break; sleep 5
done
assert_eq_all_nodes "4 validators on all nodes" "SELECT count(*) FROM validators" "4" "validators.log" || exit 2

# ---------------- governance cycles under load --------------------------
ROUNDS_OK=0
for (( r=1; r<=ROUNDS; r++ )); do
    FEE=$((BASE_FEE + r - 1))
    log "── round ${r}/${ROUNDS} — propose networkFee=${FEE} ──"

    # propose
    MNEMONIC_FILE="${ID_FILES[0]}" RPC_URL="${RPC1}" \
        bunx tsx scripts/upgradable-network/cli.ts propose networkFee "${FEE}" "${EFFECTIVE_OFFSET}" \
        > "${RUN_DIR}/propose-${r}.log" 2>&1
    PID_VAL="$(grep -oP 'proposalId: \K[a-f0-9-]+' "${RUN_DIR}/propose-${r}.log" | head -1)"
    if [[ -z "$PID_VAL" ]]; then fail "round ${r}: proposalId not extracted (propose-${r}.log)"; exit 3; fi
    log "  proposalId=${PID_VAL}"

    # background load ON for the voting window
    start_load

    # all 4 validators vote yes
    for n in 1 2 3 4; do
        MNEMONIC_FILE="${ID_FILES[$((n-1))]}" RPC_URL="http://127.0.0.1:${RPC_PORTS[$((n-1))]}" \
            bunx tsx scripts/upgradable-network/cli.ts vote "${PID_VAL}" yes \
            > "${RUN_DIR}/vote-${r}-${n}.log" 2>&1
        grep -q '"confirmationBlock"' "${RUN_DIR}/vote-${r}-${n}.log" \
          || { fail "round ${r}: validator ${n} vote failed"; stop_load; exit 3; }
    done
    log "  4/4 votes accepted"

    # wait for tally
    TALLY="$(psql_n 1 "SELECT tally_block FROM network_upgrades WHERE proposal_id='${PID_VAL}'")"
    end_b="$(wait_for_block $((TALLY + 1)) "${ROUND_TIMEOUT}")" \
      || { fail "round ${r}: tally block ${TALLY} not reached (last=${end_b})"; stop_load; exit 3; }
    assert_eq_all_nodes "round ${r}: tally → activating on all nodes" \
        "SELECT status FROM network_upgrades WHERE proposal_id='${PID_VAL}'" \
        "activating" "round-${r}-tally.log" || { stop_load; exit 4; }

    # wait for activation
    EFFECTIVE="$(psql_n 1 "SELECT effective_at_block FROM network_upgrades WHERE proposal_id='${PID_VAL}'")"
    end_b="$(wait_for_block $((EFFECTIVE + 1)) "${ROUND_TIMEOUT}")" \
      || { fail "round ${r}: activation block ${EFFECTIVE} not reached (last=${end_b})"; stop_load; exit 3; }
    assert_eq_all_nodes "round ${r}: activating → active on all nodes" \
        "SELECT status FROM network_upgrades WHERE proposal_id='${PID_VAL}'" \
        "active" "round-${r}-activation.log" || { stop_load; exit 4; }

    stop_load

    # live params reflect the new fee on every node
    fee_ok=1
    for n in 1 2 3 4; do
        live="$(MNEMONIC_FILE=${ID_FILES[0]} RPC_URL="http://127.0.0.1:${RPC_PORTS[$((n-1))]}" \
            bunx tsx scripts/upgradable-network/cli.ts params 2>/dev/null | jq -r '.networkFee')"
        echo "node-${n}: networkFee=${live}" >> "${RUN_DIR}/round-${r}-params.log"
        [[ "$live" == "${FEE}" ]] || fee_ok=0
    done
    if (( fee_ok == 1 )); then
        pass "round ${r}: live networkFee=${FEE} on all 4 nodes"
        ROUNDS_OK=$((ROUNDS_OK + 1))
    else
        fail "round ${r}: live networkFee mismatch (round-${r}-params.log)"
        exit 4
    fi
done

# ---------------- summary -----------------------------------------------
LOAD_TX="$(cat "${RUN_DIR}/.load-count" 2>/dev/null || echo 0)"
{
    echo
    echo "================================================================"
    echo "  GOVERNANCE MULTI-NODE STRESS — ${ROUNDS_OK}/${ROUNDS} rounds passed"
    echo "================================================================"
    echo "  rounds              = ${ROUNDS}"
    echo "  background load tx  = ${LOAD_TX} (NO_LOAD=${NO_LOAD:-0})"
    echo "  voting window       = ${VOTING_WINDOW} blocks"
    echo "  consensus time      = ${CONSENSUS_TIME}s/block"
    echo "  final networkFee    = $((BASE_FEE + ROUNDS - 1))"
    echo "================================================================"
} | tee -a "${SUMMARY}"

if (( ROUNDS_OK == ROUNDS )); then
    pass "ALL GREEN — governance correct + cross-node consistent under load"
    exit 0
fi
fail "${ROUNDS_OK}/${ROUNDS} rounds passed"
exit 3
