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
# NODE_COUNT mirrors generate-identities.sh. Ports default to the existing
# odd-numbered sequence (53551, 53553, ...), while NODE<N>_PORT can override
# any member. This keeps the POC topology extensible without another case arm.
NODE_COUNT="${NODE_COUNT:-4}"

get_port() {
	local index="$1"
	local variable="NODE${index}_PORT"
	local default_port=$((53549 + (2 * index)))
	echo "${!variable:-${default_port}}"
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
