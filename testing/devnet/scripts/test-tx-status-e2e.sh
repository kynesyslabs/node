#!/usr/bin/env bash
# Client read calls against a live devnet: a transaction a block keeps but
# does not execute reads as failed, never included (mainnet-launch #18,
# node #1059 section 2).
#
# Boots the devnet fixture stack, signs two transfers with the same nonce
# from node-1's funded identity and lets one block execute one and keep the
# other as failed. tx_status_failed.mjs then checks the SDK wait, the status
# answer on two nodes, the receiver balance and the other read calls. With
# finalityProofs active, storage_root.mjs then writes a Storage Program and
# checks that all four nodes commit the same storage root after each step,
# finality_commitments.mjs rebuilds every block's results root independently,
# and finality_proofs.mjs verifies the transaction, storage and segment proofs
# offline (node:crypto only, ed25519 quorum of 3 of 4).
#
# Flags:
#   --keep        Leave the devnet running on exit (for manual poking)
#   --no-build    Skip --build on `docker compose up` (faster reruns)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DEVNET_DIR}/../.." && pwd)"

KEEP=0
BUILD_FLAG="--build"
for arg in "$@"; do
    case "${arg}" in
        --keep) KEEP=1 ;;
        --no-build) BUILD_FLAG="" ;;
        *) echo "unknown flag: ${arg}"; exit 2 ;;
    esac
done

cd "${DEVNET_DIR}"

# node-5 is in the rehearsal profile; without it `down -v` leaves node-5 behind.
COMPOSE_FILES=(--profile rehearsal -f docker-compose.yml -f docker-compose.fixture.yml)
# An extra compose file, e.g. memory limits on a shared host.
if [[ -n "${COMPOSE_OVERRIDE:-}" ]]; then
    COMPOSE_FILES+=(-f "${COMPOSE_OVERRIDE}")
fi

RUN_TMP="$(mktemp -d)"

cleanup() {
    if [[ "${KEEP}" -eq 1 ]]; then
        echo
        echo "[tx-status-e2e] --keep set; devnet left running."
        echo "[tx-status-e2e] Tear down with:"
        echo "    cd testing/devnet && docker compose ${COMPOSE_FILES[*]} down -v"
    else
        echo
        echo "[tx-status-e2e] tearing devnet down..."
        docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
        rm -rf "${RUN_TMP}"
    fi
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# 1. Materialise identities + .env if missing
# -----------------------------------------------------------------------------
if [[ ! -f "${DEVNET_DIR}/.env" ]] || [[ ! -f "${DEVNET_DIR}/identities/node1.identity" ]]; then
    echo "[tx-status-e2e] running setup.sh to materialise .env + identities..."
    "${DEVNET_DIR}/scripts/setup.sh"
fi

# The committee floor is the quorum of a full shard, so a genesis whose
# shardSize exceeds its validator count never forges a block. The nodes get a
# copy sized to the validators instead. The devnet image does not build the
# gossip sidecar, so gossip is off.
jq '.properties.shardSize = (.validators | length)' genesis.devnet.json > "${RUN_TMP}/genesis.json"
{
    echo "services:"
    for n in 1 2 3 4; do
        echo "  node-${n}:"
        echo "    volumes:"
        echo "      - ${RUN_TMP}/genesis.json:/app/data/genesis.json:ro"
        echo "    environment: [GOSSIP_ENABLED=false]"
    done
} > "${RUN_TMP}/genesis-override.yml"
COMPOSE_FILES+=(-f "${RUN_TMP}/genesis-override.yml")

# -----------------------------------------------------------------------------
# 2. Boot devnet with the funded-genesis fixture
# -----------------------------------------------------------------------------
echo "[tx-status-e2e] booting devnet (fixture genesis)..."
# `down -v` first so we never reuse a stale Postgres volume — the
# snapshot/restore preflight refuses to run against a non-empty DB.
docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
# All four genesis validators are needed for a quorum of 3.
docker compose "${COMPOSE_FILES[@]}" up -d ${BUILD_FLAG} \
    node-1 node-2 node-3 node-4 postgres tlsnotary

# -----------------------------------------------------------------------------
# 3. Wait for BOTH node-1 and node-2 RPCs to answer
# -----------------------------------------------------------------------------
NODE1_PORT="${NODE1_PORT:-53551}"
NODE2_PORT="${NODE2_PORT:-53553}"
NODE1_URL="http://localhost:${NODE1_PORT}"
NODE2_URL="http://localhost:${NODE2_PORT}"

wait_for_rpc() {
    local url="$1"
    local name="$2"
    for i in $(seq 1 60); do
        if curl -sS -m 2 "${url}/" 2>/dev/null | grep -q "Hello, World"; then
            echo "[tx-status-e2e] ${name} RPC live after ${i}s"
            return 0
        fi
        if [[ "${i}" -eq 60 ]]; then
            echo "[tx-status-e2e] ERROR: ${name} RPC never came up; logs:" >&2
            docker compose "${COMPOSE_FILES[@]}" logs --tail=80 "${name}"
            return 1
        fi
        sleep 1
    done
}

echo "[tx-status-e2e] waiting for ${NODE1_URL} to come up..."
wait_for_rpc "${NODE1_URL}" "node-1"
echo "[tx-status-e2e] waiting for ${NODE2_URL} to come up..."
wait_for_rpc "${NODE2_URL}" "node-2"

# -----------------------------------------------------------------------------
# 4. Verify funded-genesis overlay applied to BOTH nodes
# -----------------------------------------------------------------------------
SENDER_PUBKEY="$(cat "${DEVNET_DIR}/identities/node1.pubkey")"
RECEIVER_PUBKEY="$(cat "${DEVNET_DIR}/identities/node2.pubkey")"
echo "[tx-status-e2e] sender   = ${SENDER_PUBKEY}"
echo "[tx-status-e2e] receiver = ${RECEIVER_PUBKEY}"

get_balance_os() {
    local url="$1"
    local addr="$2"
    curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
        -d "{\"method\":\"nodeCall\",\"params\":[{\"type\":\"nodeCall\",\"message\":\"getAddressInfo\",\"data\":{\"address\":\"${addr}\"}}]}" \
        "${url}/" \
        | grep -oE '"balance":"[0-9]+"' | head -1 | sed 's/.*"\([0-9]*\)".*/\1/'
}

# CodeRabbit iter-3: wrap balance probes in `if !` so a curl timeout,
# HTTP error, or empty grep doesn't trip `set -e` mid-substitution and
# kill the harness before the diagnostic block runs.
if ! SENDER_BAL_OS="$(get_balance_os "${NODE1_URL}" "${SENDER_PUBKEY}")"; then
    echo "[tx-status-e2e] ERROR: failed to query sender balance from node-1." >&2
    docker compose "${COMPOSE_FILES[@]}" logs --tail=80 node-1
    exit 1
fi
echo "[tx-status-e2e] sender pre-balance on node-1: ${SENDER_BAL_OS} OS"
if [[ -z "${SENDER_BAL_OS}" ]] || [[ "${SENDER_BAL_OS}" = "0" ]]; then
    echo "[tx-status-e2e] ERROR: sender balance is 0 or empty — genesis fixture didn't apply or response shape changed." >&2
    exit 1
fi

if ! SENDER_BAL_OS_2="$(get_balance_os "${NODE2_URL}" "${SENDER_PUBKEY}")"; then
    echo "[tx-status-e2e] ERROR: failed to query sender balance from node-2." >&2
    docker compose "${COMPOSE_FILES[@]}" logs --tail=80 node-2
    exit 1
fi
echo "[tx-status-e2e] sender pre-balance on node-2: ${SENDER_BAL_OS_2} OS"
if [[ "${SENDER_BAL_OS}" != "${SENDER_BAL_OS_2}" ]]; then
    echo "[tx-status-e2e] WARN: nodes disagree on sender balance (likely just sync lag)"
fi

# A cold start of every validator can take a minute to agree on block 1;
# transfers sent before that wait in the mempool past the SDK's timeout.
last_block() {
    curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
        -d '{"method":"nodeCall","params":[{"type":"nodeCall","message":"getLastBlockNumber","data":{}}]}' \
        "${NODE1_URL}/" | grep -oE '"response":[0-9]+' | grep -oE '[0-9]+$' || true
}
echo "[tx-status-e2e] waiting for the chain to reach block 2..."
for _ in $(seq 1 60); do
    [[ "$(last_block)" -ge 2 ]] 2>/dev/null && break
    sleep 5
done
if ! [[ "$(last_block)" -ge 2 ]] 2>/dev/null; then
    echo "[tx-status-e2e] ERROR: the chain did not reach block 2 within 5 minutes." >&2
    docker compose "${COMPOSE_FILES[@]}" logs --tail=80 node-1
    exit 1
fi
echo "[tx-status-e2e] chain at block $(last_block)"

# -----------------------------------------------------------------------------
# 5. Run the status script (bun)
# -----------------------------------------------------------------------------
STATUS_SCRIPT="${SCRIPT_DIR}/tx_status_failed.mjs"
# Balances exceed 64 bits, so shell arithmetic would overflow.
AMOUNT_OS="$(bun -e 'console.log(String(BigInt(process.argv[1]) / 100n))' "${SENDER_BAL_OS}")"
if [[ "${AMOUNT_OS}" == "0" ]]; then
    echo "[tx-status-e2e] ERROR: sender balance ${SENDER_BAL_OS} OS is too small for the transfers." >&2
    exit 1
fi
echo "[tx-status-e2e] transfer amounts: ${AMOUNT_OS} and twice that, in OS"

NODE1_URL="${NODE1_URL}" \
NODE2_URL="${NODE2_URL}" \
IDENTITY_PATH="${DEVNET_DIR}/identities/node1.identity" \
RECEIVER_PUBKEY="${RECEIVER_PUBKEY}" \
AMOUNT_OS="${AMOUNT_OS}" \
TX_HASHES_OUT="${RUN_TMP}/tx-hashes.json" \
    bun "${STATUS_SCRIPT}"

echo "[tx-status-e2e] failed transaction reported as failed on both nodes"

# -----------------------------------------------------------------------------
# 6. Storage Program state root (only when the fork commits it)
# -----------------------------------------------------------------------------
if [[ "$(jq -r '.forks.finalityProofs.activationHeight // empty' "${RUN_TMP}/genesis.json")" == "0" ]]; then
    NODE3_URL="http://localhost:${NODE3_PORT:-53555}"
    NODE4_URL="http://localhost:${NODE4_PORT:-53557}"
    NODE_URLS="${NODE1_URL},${NODE2_URL},${NODE3_URL},${NODE4_URL}" \
    IDENTITY_PATH="${DEVNET_DIR}/identities/node1.identity" \
    STORAGE_ADDRESS_OUT="${RUN_TMP}/storage.json" \
        bun "${SCRIPT_DIR}/storage_root.mjs"
    echo "[tx-status-e2e] storage root agrees on every node after each write"
    NODE_URLS="${NODE1_URL},${NODE2_URL},${NODE3_URL},${NODE4_URL}" \
        bun "${SCRIPT_DIR}/finality_commitments.mjs"
    echo "[tx-status-e2e] every block's commitments rebuilt by an outside client"
    NODE_URLS="${NODE1_URL},${NODE2_URL},${NODE3_URL},${NODE4_URL}" \
    PROOF_INPUTS_DIR="${RUN_TMP}" \
    SHARD_SIZE="$(jq -r '.properties.shardSize' "${RUN_TMP}/genesis.json")" \
        bun "${SCRIPT_DIR}/finality_proofs.mjs"
    echo "[tx-status-e2e] transaction, storage and segment proofs verified offline"
fi
exit 0
