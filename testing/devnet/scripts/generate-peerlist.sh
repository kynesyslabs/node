#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(dirname "${SCRIPT_DIR}")"
IDENTITIES_DIR="${DEVNET_DIR}/identities"

# Load environment variables
if [[ -f "${DEVNET_DIR}/.env" ]]; then
	source "${DEVNET_DIR}/.env"
fi

# Default ports if not set
NODE1_PORT=${NODE1_PORT:-53551}
NODE2_PORT=${NODE2_PORT:-53552}
NODE3_PORT=${NODE3_PORT:-53553}
NODE4_PORT=${NODE4_PORT:-53554}

echo "📋 Generating devnet peerlist..."

# Check if identities exist
for i in 1 2 3 4; do
	if [[ ! -f "${IDENTITIES_DIR}/node${i}.pubkey" ]]; then
		echo "❌ Missing identity for node${i}. Run ./scripts/generate-identities.sh first."
		exit 1
	fi
done

# Read pubkeys
PUBKEY1=$(cat "${IDENTITIES_DIR}/node1.pubkey")
PUBKEY2=$(cat "${IDENTITIES_DIR}/node2.pubkey")
PUBKEY3=$(cat "${IDENTITIES_DIR}/node3.pubkey")
PUBKEY4=$(cat "${IDENTITIES_DIR}/node4.pubkey")

# Generate peerlist JSON with Docker service names
# Inside Docker network, nodes communicate via service names
cat >"${DEVNET_DIR}/demos_peerlist.json" <<EOF
{
    "${PUBKEY1}": "http://node-1:${NODE1_PORT}",
    "${PUBKEY2}": "http://node-2:${NODE2_PORT}",
    "${PUBKEY3}": "http://node-3:${NODE3_PORT}",
    "${PUBKEY4}": "http://node-4:${NODE4_PORT}"
}
EOF

echo ""
echo "✅ Generated demos_peerlist.json:"
echo ""
cat "${DEVNET_DIR}/demos_peerlist.json"
echo ""
echo ""
echo "Nodes will discover each other via Docker DNS:"
echo "  node-1 → http://node-1:${NODE1_PORT}"
echo "  node-2 → http://node-2:${NODE2_PORT}"
echo "  node-3 → http://node-3:${NODE3_PORT}"
echo "  node-4 → http://node-4:${NODE4_PORT}"
