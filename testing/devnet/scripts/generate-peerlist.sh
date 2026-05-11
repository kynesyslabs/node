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
NODE2_PORT=${NODE2_PORT:-53553}
NODE3_PORT=${NODE3_PORT:-53555}
NODE4_PORT=${NODE4_PORT:-53557}
NODE5_PORT=${NODE5_PORT:-53559}

# NODE_COUNT mirrors generate-identities.sh — use 5 for the rehearsal
# fresh-joiner scenario, 4 for the default 4-node devnet.
NODE_COUNT="${NODE_COUNT:-4}"

# Map index → exposed port for the peerlist body. Add new entries here if
# NODE_COUNT grows beyond 5.
get_port() {
	case "$1" in
		1) echo "${NODE1_PORT}" ;;
		2) echo "${NODE2_PORT}" ;;
		3) echo "${NODE3_PORT}" ;;
		4) echo "${NODE4_PORT}" ;;
		5) echo "${NODE5_PORT}" ;;
		*) echo "❌ Unknown node index $1" >&2 && exit 1 ;;
	esac
}

echo "📋 Generating devnet peerlist (count=${NODE_COUNT})..."

# Check identities exist
for i in $(seq 1 "${NODE_COUNT}"); do
	if [[ ! -f "${IDENTITIES_DIR}/node${i}.pubkey" ]]; then
		echo "❌ Missing identity for node${i}. Run ./scripts/generate-identities.sh (with NODE_COUNT=${NODE_COUNT}) first."
		exit 1
	fi
done

# Build peerlist body line-by-line so adding nodes stays trivial.
PEERLIST_FILE="${DEVNET_DIR}/demos_peerlist.json"
{
	echo "{"
	for i in $(seq 1 "${NODE_COUNT}"); do
		PUBKEY=$(cat "${IDENTITIES_DIR}/node${i}.pubkey")
		PORT=$(get_port "${i}")
		# trailing comma on every line except the last
		if [[ "${i}" -lt "${NODE_COUNT}" ]]; then
			echo "    \"${PUBKEY}\": \"http://node-${i}:${PORT}\","
		else
			echo "    \"${PUBKEY}\": \"http://node-${i}:${PORT}\""
		fi
	done
	echo "}"
} >"${PEERLIST_FILE}"

echo ""
echo "✅ Generated demos_peerlist.json:"
echo ""
cat "${PEERLIST_FILE}"
echo ""
echo ""
echo "Nodes will discover each other via Docker DNS:"
for i in $(seq 1 "${NODE_COUNT}"); do
	PORT=$(get_port "${i}")
	echo "  node-${i} → http://node-${i}:${PORT}"
done
