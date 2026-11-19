#!/usr/bin/env bash
# Nodes with gossip off must keep up with the chain on their own (node #1107).
#
# Boots the 4-node devnet with GOSSIP_ENABLED=false on every node, then:
#   1. stops node-4 while the other three keep forging, starts it again and
#      requires it level with node-1 within CATCHUP_SECONDS;
#   2. starts node-5, which is not a validator, and requires it to keep
#      following the chain after its initial sync. Outside the committee it
#      gets no block pushes, so only a gossip-independent height source tells
#      it the chain moved on.
# The devnet is torn down with its volumes on exit.
#
# Flags:
#   --keep        Leave the devnet running on exit
#   --no-build    Reuse the devnet image from the last build
#
# Env:
#   OUTAGE_SECONDS   how long node-4 stays down (default 90)
#   CATCHUP_SECONDS  how long it may take to be level again (default 120)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

KEEP=0
BUILD_FLAG="--build"
for arg in "$@"; do
    case "${arg}" in
        --keep) KEEP=1 ;;
        --no-build) BUILD_FLAG="" ;;
        *) echo "unknown flag: ${arg}" >&2; exit 2 ;;
    esac
done
OUTAGE_SECONDS="${OUTAGE_SECONDS:-90}"
CATCHUP_SECONDS="${CATCHUP_SECONDS:-120}"

cd "${DEVNET_DIR}"
if [[ ! -f .env ]] || [[ ! -f identities/node1.identity ]]; then
    "${SCRIPT_DIR}/setup.sh"
fi

# The committee floor is the quorum of a full shard, so the nodes get a
# genesis sized to its validators; all four are needed for a quorum of 3.
RUN_TMP="$(mktemp -d)"
OVERRIDE="${RUN_TMP}/gossip-off.yml"
jq '.properties.shardSize = (.validators | length)' genesis.devnet.json > "${RUN_TMP}/genesis.json"
{
    echo "services:"
    for n in 1 2 3 4 5; do
        echo "  node-${n}:"
        echo "    volumes:"
        echo "      - ${RUN_TMP}/genesis.json:/app/data/genesis.json:ro"
        echo "    environment: [GOSSIP_ENABLED=false]"
    done
} > "${OVERRIDE}"
COMPOSE_FILES=(--profile rehearsal -f docker-compose.yml -f docker-compose.fixture.yml -f "${OVERRIDE}")

cleanup() {
    if [[ "${KEEP}" -eq 1 ]]; then
        echo "[gossip-off] --keep set; tear down with:"
        echo "    cd testing/devnet && docker compose ${COMPOSE_FILES[*]} down -v"
    else
        echo "[gossip-off] tearing devnet down..."
        docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
        rm -rf "${RUN_TMP}"
    fi
}
trap cleanup EXIT

env_value() {
    local name="$1" fallback="$2" value=""
    if [[ -n "${!name+x}" ]]; then printf '%s' "${!name}"; return; fi
    value="$(sed -n "s/^${name}=//p" .env | tail -n 1)"
    value="${value%\"}"; value="${value#\"}"
    printf '%s' "${value:-${fallback}}"
}
NODE1="http://localhost:$(env_value NODE1_PORT 53551)"
NODE4="http://localhost:$(env_value NODE4_PORT 53557)"
NODE5="http://localhost:$(env_value NODE5_PORT 53559)"

head_of() {
    curl -s -m 5 -X POST "$1/" -H 'Content-Type: application/json' \
        -d '{"method":"nodeCall","params":[{"type":"nodeCall","message":"getLastBlockNumber","data":{}}]}' |
        grep -oE '"response":[0-9]+' | grep -oE '[0-9]+$' || echo -1
}
fail() {
    echo "[gossip-off] FAIL $*"
    docker compose "${COMPOSE_FILES[@]}" logs --tail=80 "${WATCHED:-node-4}" || true
    exit 1
}
wait_head() {
    local url="$1" target="$2" seconds="$3"
    for _ in $(seq 1 "$(( seconds / 2 ))"); do
        [[ "$(head_of "${url}")" -ge "${target}" ]] && return 0
        sleep 2
    done
    return 1
}

echo "[gossip-off] booting 4 validators with gossip off..."
docker compose "${COMPOSE_FILES[@]}" down -v >/dev/null 2>&1 || true
docker compose "${COMPOSE_FILES[@]}" up -d ${BUILD_FLAG} postgres tlsnotary node-1 node-2 node-3 node-4
wait_head "${NODE4}" 5 300 || fail "node-4 never reached block 5 (node-1 at $(head_of "${NODE1}"))"
echo "[gossip-off] chain at $(head_of "${NODE1}"); stopping node-4 for ${OUTAGE_SECONDS}s"

docker stop demos-devnet-node-4 >/dev/null
STOPPED_AT="$(head_of "${NODE1}")"
sleep "${OUTAGE_SECONDS}"
MISSED="$(head_of "${NODE1}")"
[[ "${MISSED}" -gt "$(( STOPPED_AT + 2 ))" ]] || fail "the other three did not forge while node-4 was down (${STOPPED_AT} -> ${MISSED})"
echo "[gossip-off] network moved ${STOPPED_AT} -> ${MISSED}; starting node-4"

docker start demos-devnet-node-4 >/dev/null
START="$(date +%s)"
wait_head "${NODE4}" "${MISSED}" "${CATCHUP_SECONDS}" ||
    fail "node-4 at $(head_of "${NODE4}") after ${CATCHUP_SECONDS}s, network at $(head_of "${NODE1}")"
echo "[gossip-off] PASS node-4 reached ${MISSED} $(( $(date +%s) - START ))s after restart"

# Level means it keeps following, not only that it caught up once.
TARGET="$(( $(head_of "${NODE1}") + 3 ))"
wait_head "${NODE4}" "${TARGET}" 120 || fail "node-4 stopped following at $(head_of "${NODE4}"), network at $(head_of "${NODE1}")"
echo "[gossip-off] PASS node-4 follows the chain to ${TARGET}"

if [[ ! -f identities/node5.identity ]]; then
    LOG="$(mktemp)"
    (cd "${DEVNET_DIR}/../.." && bun "${SCRIPT_DIR}/generate-identity-helper.ts") > "${LOG}"
    (umask 077; grep "^MNEMONIC:" "${LOG}" | cut -d: -f2- > identities/node5.identity)
    grep "^PUBKEY:" "${LOG}" | cut -d: -f2- > identities/node5.pubkey
    rm -f "${LOG}"
fi
WATCHED=node-5
docker compose "${COMPOSE_FILES[@]}" up -d --no-build node-5 >/dev/null
SYNC_TO="$(head_of "${NODE1}")"
wait_head "${NODE5}" "${SYNC_TO}" 180 || fail "node-5 synced to $(head_of "${NODE5}"), network at $(head_of "${NODE1}")"
echo "[gossip-off] PASS node-5 synced to ${SYNC_TO}"
TARGET="$(( $(head_of "${NODE1}") + 6 ))"
wait_head "${NODE5}" "${TARGET}" "${CATCHUP_SECONDS}" ||
    fail "node-5 stopped following at $(head_of "${NODE5}"), network at $(head_of "${NODE1}")"
echo "[gossip-off] PASS node-5 (not in the committee) follows the chain to ${TARGET}"
echo "[gossip-off] OK"
