#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$(dirname "${SCRIPT_DIR}")"

echo "🚀 Setting up Demos devnet..."
echo ""

# Check if .env exists
if [[ ! -f "${DEVNET_DIR}/.env" ]]; then
	echo "📋 Creating .env from .env.example..."
	cp "${DEVNET_DIR}/.env.example" "${DEVNET_DIR}/.env"
fi

# Generate identities
echo ""
"${SCRIPT_DIR}/generate-identities.sh"

# Sync the genesis validator set to the freshly-generated identities.
# Without this the genesis validators stay stale and no node's pubkey is in
# the validator set -> NotInShardError -> no consensus.
echo ""
"${SCRIPT_DIR}/generate-genesis.sh"

# Generate peerlist
echo ""
"${SCRIPT_DIR}/generate-peerlist.sh"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "✅ Devnet setup complete!"
echo ""
echo "To start the devnet:"
echo "  cd devnet && docker compose up --build"
echo ""
echo "Or with logs for each node:"
echo "  docker compose up --build -d && docker compose logs -f"
echo ""
echo "Node endpoints:"
echo "  node-1: http://localhost:53551"
echo "  node-2: http://localhost:53553"
echo "  node-3: http://localhost:53555"
echo "  node-4: http://localhost:53557"
echo "═══════════════════════════════════════════════════════════════"
