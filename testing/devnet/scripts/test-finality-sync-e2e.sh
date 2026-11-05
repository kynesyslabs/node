#!/usr/bin/env bash
# Finality commitments survive sync and restart (node #1059, #1060).
#
# Runs test-tx-status-e2e.sh with --keep, so the chain holds a failed
# transaction and Storage Program writes under finalityProofs. Then:
#   1. node-5, which is not a validator, joins with an empty database and must
#      sync every block, verifying each commitment, to the same hashes;
#   2. node-2 restarts and must record no new validator set snapshot and keep
#      following the chain.
# The devnet is torn down with its volumes on exit.
#
# Flags:
#   --no-build    Reuse the devnet image from the last build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DEVNET_DIR}/../.." && pwd)"
NODE5_PORT="${NODE5_PORT:-53559}"

PASS_ARGS=(--keep)
for arg in "$@"; do
    case "$arg" in
        --no-build) PASS_ARGS+=(--no-build) ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

cd "${DEVNET_DIR}"
LOG="$(mktemp)"
COMPOSE_FILES=()

cleanup() {
    echo "[finality-sync] tearing devnet down..."
    if [[ ${#COMPOSE_FILES[@]} -gt 0 ]]; then
        docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
    fi
    rm -f "${LOG}"
}
trap cleanup EXIT

if [[ ! -f identities/node5.identity ]]; then
    (cd "${REPO_ROOT}" && bun "${SCRIPT_DIR}/generate-identity-helper.ts") > "${LOG}"
    (umask 077; grep "^MNEMONIC:" "${LOG}" | cut -d: -f2- > identities/node5.identity)
    grep "^PUBKEY:" "${LOG}" | cut -d: -f2- > identities/node5.pubkey
fi

# A failed run still leaves the stack up (--keep), so read its teardown
# command before giving up.
TX_STATUS=0
"${SCRIPT_DIR}/test-tx-status-e2e.sh" "${PASS_ARGS[@]}" | tee "${LOG}" || TX_STATUS=$?

# The kept stack prints its own teardown command; reuse its compose files.
read -r -a COMPOSE_FILES <<< "$(grep -oE 'docker compose .* down -v' "${LOG}" | tail -1 | sed -E 's/^docker compose //; s/ down -v$//' || true)"
if [[ "${TX_STATUS}" -ne 0 ]]; then
    echo "[finality-sync] FAIL test-tx-status-e2e.sh exited with ${TX_STATUS}"
    exit "${TX_STATUS}"
fi
OVERRIDE="$(printf '%s\n' "${COMPOSE_FILES[@]}" | grep genesis-override.yml)"
GENESIS="$(dirname "${OVERRIDE}")/genesis.json"
NODE5_OVERRIDE="$(dirname "${OVERRIDE}")/node5-override.yml"
cat > "${NODE5_OVERRIDE}" <<EOF
services:
  node-5:
    volumes:
      - ${GENESIS}:/app/data/genesis.json:ro
    environment: [GOSSIP_ENABLED=false]
EOF
COMPOSE_FILES+=(-f "${NODE5_OVERRIDE}")

node_call() {
    local url="$1" message="$2" data="$3"
    curl -s -m 5 -X POST "${url}/" -H 'Content-Type: application/json' \
        -d "{\"method\":\"nodeCall\",\"params\":[{\"type\":\"nodeCall\",\"message\":\"${message}\",\"data\":${data}}]}"
}
head_of() {
    local url="$1"
    node_call "${url}" getLastBlockNumber '{}' | grep -oE '"response":[0-9]+' | grep -oE '[0-9]+$' || echo -1
}
hash_at() {
    local url="$1" number="$2"
    node_call "${url}" getBlockByNumber "{\"blockNumber\":${number}}" | grep -oE '"hash":"[0-9a-f]{64}"' | head -1 || true
}
# An unreachable node answers with an empty hash, which must not count as equal.
same_hash_at() {
    local url="$1" number="$2" expected
    expected="$(hash_at "${NODE1}" "${number}")"
    [[ -n "${expected}" && "$(hash_at "${url}" "${number}")" == "${expected}" ]]
}
snapshot_count() {
    local db="$1"
    docker exec demos-devnet-postgres psql -U "${POSTGRES_USER:-demosuser}" -d "${db}" -tAc \
        "SELECT count(*) FROM validator_set_snapshots" 2>/dev/null | tr -d '[:space:]'
}

NODE1="http://localhost:${NODE1_PORT:-53551}"
NODE5="http://localhost:${NODE5_PORT}"
fail() { echo "[finality-sync] FAIL $*"; docker compose "${COMPOSE_FILES[@]}" logs --tail=60 node-5 || true; exit 1; }

# 1. A fresh node syncs the whole chain.
TARGET="$(head_of "${NODE1}")"
echo "[finality-sync] chain at ${TARGET}; starting node-5 with an empty database"
docker compose "${COMPOSE_FILES[@]}" up -d --no-build node-5 >/dev/null
for _ in $(seq 1 180); do
    [[ "$(head_of "${NODE5}")" -ge "${TARGET}" ]] && break
    sleep 2
done
SYNCED="$(head_of "${NODE5}")"
[[ "${SYNCED}" -ge "${TARGET}" ]] || fail "node-5 reached ${SYNCED}, expected ${TARGET}"
for n in $(seq 1 "${TARGET}"); do
    same_hash_at "${NODE5}" "$n" || fail "block $n differs on node-5"
done
echo "[finality-sync] PASS node-5 synced blocks 1..${TARGET} with identical hashes"
# Read whole, not piped: grep -q stops at the first match and, under
# pipefail, the SIGPIPE of docker compose would hide that match.
NODE5_LOGS="$(docker compose "${COMPOSE_FILES[@]}" logs node-5 2>&1 || true)"
if grep -qE "parent_results_root|validator_set_hash|SyncBlockRejected|ValidatorSetHistoryError" <<< "${NODE5_LOGS}"; then
    fail "node-5 logged a commitment rejection"
fi
echo "[finality-sync] PASS node-5 logged no commitment rejection"
S1="$(snapshot_count node1_db)"; S5="$(snapshot_count node5_db)"
[[ -n "${S5}" && "${S5}" == "${S1}" ]] || fail "validator set snapshots: node-1 ${S1}, node-5 ${S5}"
echo "[finality-sync] PASS node-5 holds the same ${S5} validator set snapshot(s) as node-1"

# 2. A validator restarts without recording a new set.
S2_BEFORE="$(snapshot_count node2_db)"
docker restart demos-devnet-node-2 >/dev/null
AFTER="$(( $(head_of "${NODE1}") + 3 ))"
for _ in $(seq 1 120); do
    [[ "$(head_of "http://localhost:${NODE2_PORT:-53553}")" -ge "${AFTER}" ]] && break
    sleep 2
done
[[ "$(head_of "http://localhost:${NODE2_PORT:-53553}")" -ge "${AFTER}" ]] || fail "node-2 did not follow the chain after restart"
same_hash_at "http://localhost:${NODE2_PORT:-53553}" "${AFTER}" || fail "block ${AFTER} differs on node-2"
S2_AFTER="$(snapshot_count node2_db)"
[[ "${S2_AFTER}" == "${S2_BEFORE}" ]] || fail "node-2 snapshots ${S2_BEFORE} -> ${S2_AFTER} across a restart"
echo "[finality-sync] PASS node-2 restarted, followed to ${AFTER} and recorded no new snapshot"
echo "[finality-sync] OK"
