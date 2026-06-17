#!/usr/bin/env bash
# l2ps-create-subnet.sh — create an L2PS subnet on the local node host.
#
# An L2PS subnet is three files under `data/l2ps/<UID>/`:
#   - config.json     subnet config (uid, known_rpcs, key paths)
#   - private_key.txt 32-byte AES-256 key, hex-encoded
#   - iv.txt          16-byte IV, hex-encoded
# The node loads them at boot. There is no on-chain registration.
#
# This script generates fresh key material, writes the three files
# directly into the running node container, and restarts the container
# so the new subnet is loaded.
#
# Usage:
#   ./scripts/l2ps-create-subnet.sh <UID> [options]
#
# Required:
#   <UID>              Subnet identifier (1-64 chars of [a-zA-Z0-9_.-])
#
# Optional:
#   --rpc <url>        RPC URL to add to known_rpcs. Repeat for multiple.
#                      Defaults to http://127.0.0.1:53550 if none given.
#   --container <name> Container name (default: demos-node-devnet;
#                      use demos-node for mainnet/testnet stacks).
#   --no-restart       Skip the `docker restart` step.
#   --force            Overwrite an existing subnet directory.
#   --yes              Skip the confirmation prompt.
#   -h, --help         Show this help.
#
# Examples:
#   ./scripts/l2ps-create-subnet.sh dev_l2ps_001 \
#       --rpc http://node2.demos.sh:53650 \
#       --rpc http://node3.demos.sh:53650
#
# Security: private_key.txt is long-lived secret material. Treat the
# subnet directory like any other key store.

set -euo pipefail

UID_VAL=""
RPCS=()
CONTAINER="demos-node-devnet"
DO_RESTART=1
FORCE=0
YES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rpc)
            [[ $# -ge 2 ]] || { echo "error: --rpc requires a value" >&2; exit 2; }
            RPCS+=("$2"); shift 2 ;;
        --container)
            [[ $# -ge 2 ]] || { echo "error: --container requires a value" >&2; exit 2; }
            CONTAINER="$2"; shift 2 ;;
        --no-restart) DO_RESTART=0; shift ;;
        --force) FORCE=1; shift ;;
        --yes|-y) YES=1; shift ;;
        -h|--help)
            sed -n '2,36p' "$0"
            exit 0 ;;
        --*)
            echo "error: unknown flag: $1" >&2; exit 2 ;;
        *)
            if [[ -z "$UID_VAL" ]]; then
                UID_VAL="$1"; shift
            else
                echo "error: unexpected positional argument: $1" >&2; exit 2
            fi ;;
    esac
done

if [[ -z "$UID_VAL" ]]; then
    echo "error: <UID> is required (see --help)" >&2
    exit 2
fi
if ! [[ "$UID_VAL" =~ ^[a-zA-Z0-9_.-]{1,64}$ ]]; then
    echo "error: <UID> must be 1-64 chars of [a-zA-Z0-9_.-], got '${UID_VAL}'" >&2
    exit 2
fi
if [[ ${#RPCS[@]} -eq 0 ]]; then
    RPCS=("http://127.0.0.1:53550")
fi
if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker not found on PATH" >&2
    exit 2
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "error: container '${CONTAINER}' is not running" >&2
    echo "hint:  pass --container <name> if the node uses a different name" >&2
    exit 2
fi

DIR="data/l2ps/${UID_VAL}"

# Refuse to overwrite unless --force; never silently destroy an existing
# subnet's key material.
if docker exec "$CONTAINER" test -d "$DIR" >/dev/null 2>&1; then
    if [[ "$FORCE" -ne 1 ]]; then
        echo "error: ${DIR} already exists in ${CONTAINER}" >&2
        echo "hint:  pass --force to overwrite (destroys the existing key)" >&2
        exit 2
    fi
fi

# Pretty-print the plan.
echo "Creating L2PS subnet:"
echo "  uid:        ${UID_VAL}"
echo "  container:  ${CONTAINER}"
echo "  path:       ${DIR}"
echo "  known_rpcs:"
printf '    %s\n' "${RPCS[@]}"
echo "  restart:    $([[ $DO_RESTART -eq 1 ]] && echo yes || echo no)"

if [[ "$YES" -ne 1 ]]; then
    read -r -p "Proceed? Type 'create' to confirm: " confirm
    if [[ "$confirm" != "create" ]]; then
        echo "aborted."
        exit 1
    fi
fi

# Generate key material with openssl rand — uses the same kernel CSPRNG
# the node would use. Hex-encoded so the files are diff-able and match
# the existing fixtures (testnet_l2ps_001 / acd_demo_001).
KEY_HEX="$(openssl rand -hex 32)"
IV_HEX="$(openssl rand -hex 16)"

# Build the known_rpcs JSON array using jq if available, else fall back
# to manual quoting. jq is preferable because it handles edge cases
# (special chars in URLs) correctly.
if command -v jq >/dev/null 2>&1; then
    RPCS_JSON="$(printf '%s\n' "${RPCS[@]}" | jq -R . | jq -s -c .)"
else
    # Manual fallback. Each RPC URL is wrapped in double quotes; URLs
    # containing double quotes will produce broken JSON, but that is
    # an extreme edge case.
    RPCS_JSON='['
    for i in "${!RPCS[@]}"; do
        [[ $i -gt 0 ]] && RPCS_JSON+=','
        RPCS_JSON+="\"${RPCS[$i]}\""
    done
    RPCS_JSON+=']'
fi

CONFIG_JSON=$(cat <<EOF
{
    "uid": "${UID_VAL}",
    "enabled": true,
    "config": {
        "created_at_block": 0,
        "known_rpcs": ${RPCS_JSON}
    },
    "keys": {
        "private_key_path": "data/l2ps/${UID_VAL}/private_key.txt",
        "iv_path": "data/l2ps/${UID_VAL}/iv.txt"
    }
}
EOF
)

# The container runs as a non-root user (typically `demos`) whose home
# does not own `data/`, so the user can't `mkdir` under it. Detect the
# owner of an existing data-owned path (the node's identity file is a
# reliable anchor) and run the writes as root + chown back so the node
# user can still read its own files at boot.
OWNER="$(docker exec "$CONTAINER" sh -c 'stat -c %U .demos_identity 2>/dev/null || stat -c %U .' || echo demos)"
OWNER="${OWNER:-demos}"

echo "[1/3] writing subnet files into ${CONTAINER}:${DIR} (owner=${OWNER})..."
docker exec -u root "$CONTAINER" mkdir -p "$DIR"
docker exec -u root -i "$CONTAINER" sh -c "cat > ${DIR}/private_key.txt" <<< "$KEY_HEX"
docker exec -u root -i "$CONTAINER" sh -c "cat > ${DIR}/iv.txt" <<< "$IV_HEX"
docker exec -u root -i "$CONTAINER" sh -c "cat > ${DIR}/config.json" <<< "$CONFIG_JSON"
docker exec -u root "$CONTAINER" chown -R "${OWNER}:${OWNER}" "$DIR"
docker exec -u root "$CONTAINER" chmod 600 "${DIR}/private_key.txt" "${DIR}/iv.txt"

echo "[2/3] verifying files..."
docker exec "$CONTAINER" ls -la "$DIR"

if [[ "$DO_RESTART" -eq 1 ]]; then
    echo "[3/3] restarting ${CONTAINER} so the node picks up the new subnet..."
    docker restart "$CONTAINER" >/dev/null
    echo "      restarted. Boot takes ~15-30s; check status with:"
else
    echo "[3/3] skipped restart (--no-restart). Restart when ready:"
    echo "        docker restart ${CONTAINER}"
fi

echo
echo "Verify the subnet is loaded once the container is healthy:"
echo
echo "  curl -s -X POST -H 'Content-Type: application/json' \\"
echo "    -d '{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getL2PSMempoolInfo\",\"data\":{\"l2psUid\":\"${UID_VAL}\"},\"muid\":\"x\"}]}' \\"
echo "    http://localhost:53650/"
echo
echo "A 200 with transactionCount=0 means the subnet loaded successfully."
