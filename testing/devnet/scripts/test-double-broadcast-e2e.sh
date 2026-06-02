#!/usr/bin/env bash
# Audit-sweep batch C/E e2e test — cross-RPC nonce-replay protection.
#
# Boots the devnet fixture stack (with `nonceEnforcement.
# activationHeight: 0` active from block 0), takes the same signed
# transaction, and broadcasts it through BOTH node-1 AND node-2
# concurrently. Asserts that:
#
#   1. Only ONE transfer is reflected in the receiver's balance
#      (no double-spend).
#   2. The sender's account nonce advances by exactly 1.
#
# This exercises the consensus-time `expectedPrior` reject in
# `GCRNonceRoutines` (PR #886) and the same-node TOCTOU advisory
# lock in `Mempool.addTransaction` (PR #887). Without those, two
# competing broadcasts of the same signed tx through two different
# RPCs would both apply and the receiver would gain 2× the amount.
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

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.fixture.yml)

cleanup() {
    if [[ "${KEEP}" -eq 1 ]]; then
        echo
        echo "[double-broadcast-e2e] --keep set; devnet left running."
        echo "[double-broadcast-e2e] Tear down with:"
        echo "    cd testing/devnet && docker compose ${COMPOSE_FILES[*]} down -v"
    else
        echo
        echo "[double-broadcast-e2e] tearing devnet down..."
        docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# 1. Materialise identities + .env if missing
# -----------------------------------------------------------------------------
if [[ ! -f "${DEVNET_DIR}/.env" ]] || [[ ! -f "${DEVNET_DIR}/identities/node1.identity" ]]; then
    echo "[double-broadcast-e2e] running setup.sh to materialise .env + identities..."
    "${DEVNET_DIR}/scripts/setup.sh"
fi

# -----------------------------------------------------------------------------
# 2. Boot devnet with the funded-genesis fixture
# -----------------------------------------------------------------------------
echo "[double-broadcast-e2e] booting devnet (fixture genesis)..."
# `down -v` first so we never reuse a stale Postgres volume — the
# snapshot/restore preflight refuses to run against a non-empty DB.
docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
docker compose "${COMPOSE_FILES[@]}" up -d ${BUILD_FLAG} node-1 node-2 postgres tlsnotary

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
            echo "[double-broadcast-e2e] ${name} RPC live after ${i}s"
            return 0
        fi
        if [[ "${i}" -eq 60 ]]; then
            echo "[double-broadcast-e2e] ERROR: ${name} RPC never came up; logs:"
            docker compose "${COMPOSE_FILES[@]}" logs --tail=80 "${name}"
            return 1
        fi
        sleep 1
    done
}

echo "[double-broadcast-e2e] waiting for ${NODE1_URL} to come up..."
wait_for_rpc "${NODE1_URL}" "node-1"
echo "[double-broadcast-e2e] waiting for ${NODE2_URL} to come up..."
wait_for_rpc "${NODE2_URL}" "node-2"

# -----------------------------------------------------------------------------
# 4. Verify funded-genesis overlay applied to BOTH nodes
# -----------------------------------------------------------------------------
SENDER_PUBKEY="$(cat "${DEVNET_DIR}/identities/node1.pubkey")"
RECEIVER_PUBKEY="$(cat "${DEVNET_DIR}/identities/node2.pubkey")"
echo "[double-broadcast-e2e] sender   = ${SENDER_PUBKEY}"
echo "[double-broadcast-e2e] receiver = ${RECEIVER_PUBKEY}"

get_balance_os() {
    local url="$1"
    local addr="$2"
    curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
        -d "{\"method\":\"nodeCall\",\"params\":[{\"type\":\"nodeCall\",\"message\":\"getAddressInfo\",\"data\":{\"address\":\"${addr}\"}}]}" \
        "${url}/" \
        | grep -oE '"balance":"[0-9]+"' | head -1 | sed 's/.*"\([0-9]*\)".*/\1/'
}

SENDER_BAL_OS="$(get_balance_os "${NODE1_URL}" "${SENDER_PUBKEY}")"
echo "[double-broadcast-e2e] sender pre-balance on node-1: ${SENDER_BAL_OS} OS"
if [[ -z "${SENDER_BAL_OS}" ]] || [[ "${SENDER_BAL_OS}" = "0" ]]; then
    echo "[double-broadcast-e2e] ERROR: sender balance is 0 — genesis fixture didn't apply."
    exit 1
fi

SENDER_BAL_OS_2="$(get_balance_os "${NODE2_URL}" "${SENDER_PUBKEY}")"
echo "[double-broadcast-e2e] sender pre-balance on node-2: ${SENDER_BAL_OS_2} OS"
if [[ "${SENDER_BAL_OS}" != "${SENDER_BAL_OS_2}" ]]; then
    echo "[double-broadcast-e2e] WARN: nodes disagree on sender balance (likely just sync lag)"
fi

# -----------------------------------------------------------------------------
# 5. Run the dual-broadcast script (bun)
# -----------------------------------------------------------------------------
DOUBLE_SCRIPT="${SCRIPT_DIR}/double_broadcast_replay.mjs"
if [[ ! -f "${DOUBLE_SCRIPT}" ]]; then
    echo "[double-broadcast-e2e] ERROR: ${DOUBLE_SCRIPT} not found."
    exit 1
fi

# Send 10% of sender balance to keep the test reproducible across
# devnet boots. The double_broadcast_replay.mjs script asserts the
# observed receiver delta equals AMOUNT_OS exactly.
AMOUNT_OS="$((SENDER_BAL_OS / 10))"
if [[ "${AMOUNT_OS}" -eq 0 ]]; then
    echo "[double-broadcast-e2e] ERROR: computed AMOUNT_OS=0 (sender balance ${SENDER_BAL_OS} OS is too small for a 10% slice)."
    echo "[double-broadcast-e2e]        a zero-value transfer does not exercise the double-spend path."
    exit 1
fi
echo "[double-broadcast-e2e] transfer amount: ${AMOUNT_OS} OS (10% of sender balance)"

echo "[double-broadcast-e2e] running double-broadcast script..."
NODE1_URL="${NODE1_URL}" \
NODE2_URL="${NODE2_URL}" \
IDENTITY_PATH="${DEVNET_DIR}/identities/node1.identity" \
RECEIVER_PUBKEY="${RECEIVER_PUBKEY}" \
AMOUNT_OS="${AMOUNT_OS}" \
    bun "${DOUBLE_SCRIPT}"

# bun exits 0 on OK, 1 on FAIL — set -e propagates either way.
echo "[double-broadcast-e2e] ✅ nonceEnforcement deduplicated the replay"
exit 0
