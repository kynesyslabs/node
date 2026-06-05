#!/usr/bin/env bash
# Local E2E test for the post-fork native transfer flow.
#
# Spins up the 4-node devnet with the funded-genesis fixture, waits
# for node-1 to answer RPC, runs a transfer-and-poll script using
# node-1's identity → node-2's address, and asserts the receiver
# balance increased by the broadcast amount.
#
# Designed to give a sub-30s feedback loop on changes that affect the
# native send path so we don't have to wipe-and-reboot a remote dev VM
# every iteration.
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
        echo "[devnet-e2e] --keep set; devnet left running."
        echo "[devnet-e2e] Tear down with:"
        echo "    cd testing/devnet && docker compose ${COMPOSE_FILES[*]} down -v"
    else
        echo
        echo "[devnet-e2e] tearing devnet down..."
        docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# 1. Ensure identities + peerlist + .env exist
# -----------------------------------------------------------------------------
if [[ ! -f "${DEVNET_DIR}/.env" ]] || [[ ! -f "${DEVNET_DIR}/identities/node1.identity" ]]; then
    echo "[devnet-e2e] running setup.sh to materialise .env + identities..."
    "${DEVNET_DIR}/scripts/setup.sh"
fi

# -----------------------------------------------------------------------------
# 2. Boot devnet with the funded-genesis fixture
# -----------------------------------------------------------------------------
echo "[devnet-e2e] booting devnet (fixture genesis)..."
# `down -v` first so we never reuse a stale Postgres volume — the
# snapshot/restore preflight will refuse to run against a non-empty DB.
docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
docker compose "${COMPOSE_FILES[@]}" up -d ${BUILD_FLAG} node-1 node-2 postgres tlsnotary

# -----------------------------------------------------------------------------
# 3. Wait for node-1 RPC to answer
# -----------------------------------------------------------------------------
NODE1_PORT="${NODE1_PORT:-53551}"
NODE1_URL="http://localhost:${NODE1_PORT}"
echo "[devnet-e2e] waiting for ${NODE1_URL} to come up..."
for i in $(seq 1 60); do
    if curl -sS -m 2 "${NODE1_URL}/" 2>/dev/null | grep -q "Hello, World"; then
        echo "[devnet-e2e] node-1 RPC live after ${i}s"
        break
    fi
    if [[ "${i}" -eq 60 ]]; then
        echo "[devnet-e2e] ERROR: node-1 RPC never came up; logs:"
        docker compose "${COMPOSE_FILES[@]}" logs --tail=80 node-1
        exit 1
    fi
    sleep 1
done

# -----------------------------------------------------------------------------
# 4. Verify the funded-genesis overlay actually applied
# -----------------------------------------------------------------------------
SENDER_PUBKEY="$(cat "${DEVNET_DIR}/identities/node1.pubkey")"
RECEIVER_PUBKEY="$(cat "${DEVNET_DIR}/identities/node2.pubkey")"
echo "[devnet-e2e] sender   = ${SENDER_PUBKEY}"
echo "[devnet-e2e] receiver = ${RECEIVER_PUBKEY}"

SENDER_INFO="$(
    curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
        -d "{\"method\":\"nodeCall\",\"params\":[{\"type\":\"nodeCall\",\"message\":\"getAddressInfo\",\"data\":{\"address\":\"${SENDER_PUBKEY}\"}}]}" \
        "${NODE1_URL}/"
)"
SENDER_BAL_OS="$(echo "${SENDER_INFO}" | grep -oE '"balance":"[0-9]+"' | head -1 | sed 's/.*"\([0-9]*\)".*/\1/')"
echo "[devnet-e2e] sender pre-balance: ${SENDER_BAL_OS} OS"
if [[ -z "${SENDER_BAL_OS}" ]] || [[ "${SENDER_BAL_OS}" = "0" ]]; then
    echo "[devnet-e2e] ERROR: sender balance is 0 — genesis fixture didn't apply."
    echo "[devnet-e2e]        check that data/genesis.json was overlaid (see fixture compose file)."
    exit 1
fi

# -----------------------------------------------------------------------------
# 5. Run the transfer script (bun) against node-1
# -----------------------------------------------------------------------------
TRANSFER_SCRIPT="${REPO_ROOT}/transfer_10pct.mjs"
if [[ ! -f "${TRANSFER_SCRIPT}" ]]; then
    echo "[devnet-e2e] ERROR: ${TRANSFER_SCRIPT} not found."
    exit 1
fi

# Hand the script the right RPC + identity via env vars so it can target
# the devnet without source edits. The script reads its config from the
# constants at the top of the file, but we can monkeypatch by emitting
# a temporary copy.
TMP_SCRIPT="$(mktemp -t devnet-transfer-XXXXXX).mjs"
trap 'rm -f "${TMP_SCRIPT}"' RETURN
sed \
    -e "s|http://dev.node2.demos.sh:53552|${NODE1_URL}|g" \
    -e "s|/Users/tcsenpai/kynesys/node/.demos_identity_node[0-9]|${DEVNET_DIR}/identities/node1.identity|g" \
    -e "s|/Users/tcsenpai/kynesys/local_vault/incentives_wallet|${DEVNET_DIR}/identities/node1.identity|g" \
    -e "s|0x742e15a60e3a9400c9b890518a1cb0a38f978f77bc69826f559a76e7f44e85b5|${RECEIVER_PUBKEY}|g" \
    "${TRANSFER_SCRIPT}" > "${TMP_SCRIPT}"

echo "[devnet-e2e] running transfer (BROADCAST=1)..."
(cd "${REPO_ROOT}" && BROADCAST=1 bun "${TMP_SCRIPT}")

# -----------------------------------------------------------------------------
# 6. Poll receiver balance for up to 60s
# -----------------------------------------------------------------------------
echo "[devnet-e2e] polling receiver balance..."
RECEIVER_BAL_OS="0"
for i in $(seq 1 30); do
    RECEIVER_INFO="$(
        curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
            -d "{\"method\":\"nodeCall\",\"params\":[{\"type\":\"nodeCall\",\"message\":\"getAddressInfo\",\"data\":{\"address\":\"${RECEIVER_PUBKEY}\"}}]}" \
            "${NODE1_URL}/"
    )"
    RECEIVER_BAL_OS="$(echo "${RECEIVER_INFO}" | grep -oE '"balance":"[0-9]+"' | head -1 | sed 's/.*"\([0-9]*\)".*/\1/')"
    echo "[devnet-e2e]   t=$((i*2))s  receiver balance: ${RECEIVER_BAL_OS} OS"
    if [[ "${RECEIVER_BAL_OS}" -gt 1000000000000000000000000000 ]]; then
        # Receiver started with 1e27 OS (genesis); any increment proves
        # the transfer landed in a block.
        echo "[devnet-e2e] ✅ transfer landed; receiver balance increased above genesis amount."
        exit 0
    fi
    sleep 2
done

echo "[devnet-e2e] ERROR: receiver balance never went above genesis amount."
echo "[devnet-e2e] final balance: ${RECEIVER_BAL_OS}"
echo "[devnet-e2e] last 80 lines from node-1:"
docker compose "${COMPOSE_FILES[@]}" logs --tail=80 node-1
exit 1
