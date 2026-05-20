#!/bin/bash
# Bring up the companion node alongside the primary stack.
# Pre-seeds .demos_identity into demos_companion_state and pre-seeds the
# peerlist so companion connects to the primary node on boot.
#
# Idempotent: re-running after the companion is up is a no-op (volumes
# already populated; docker compose up reconciles).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f .test-identity/companion.mnemonic ]]; then
    echo "missing .test-identity/companion.mnemonic — run:" >&2
    echo "  bun scripts/gen-test-identity.ts --name companion" >&2
    exit 1
fi

if [[ ! -f .test-identity/pubkey ]]; then
    echo "missing .test-identity/pubkey (host pubkey) — primary node identity not set" >&2
    exit 1
fi

HOST_PUBKEY="$(cat .test-identity/pubkey)"
COMPANION_PUBKEY="$(cat .test-identity/companion.pubkey)"

echo "+ host pubkey:      $HOST_PUBKEY"
echo "+ companion pubkey: $COMPANION_PUBKEY"

# Create the volumes so we can pre-seed them before companion boots.
docker volume create demos_companion_state >/dev/null
docker volume create demos_companion_data  >/dev/null
docker volume create demos_companion_logs  >/dev/null

# Pre-seed companion identity. The container expects /app/state/.demos_identity
# (entrypoint symlinks it into /app/.demos_identity).
docker run --rm \
    -v demos_companion_state:/state \
    -v "$REPO_ROOT/.test-identity":/src:ro \
    alpine sh -c "
        cp /src/companion.mnemonic /state/.demos_identity &&
        chmod 600 /state/.demos_identity &&
        chown 1000:1000 /state /state/.demos_identity
    "

# Pre-seed peerlist on BOTH sides so initial peerBootstrap succeeds even
# if one node is unreachable at the exact moment the other reads.
# Format: { "0xPUBKEY": "http://host:port" }
COMPANION_PEERLIST=$(printf '{"%s":"http://demos-node:53550"}' "$HOST_PUBKEY")
HOST_PEERLIST=$(printf '{"%s":"http://companion:53560"}' "$COMPANION_PUBKEY")

# Write the companion's peerlist into its state volume.
echo "$COMPANION_PEERLIST" | docker run --rm -i \
    -v demos_companion_state:/state \
    alpine sh -c "cat > /state/demos_peerlist.json && chown 1000:1000 /state/demos_peerlist.json"

# Write the host's peerlist into demos_node_state so the running primary
# learns about the companion. Requires restart of demos-node to pick up.
echo "$HOST_PEERLIST" | docker run --rm -i \
    -v demos_node_state:/state \
    alpine sh -c "cat > /state/demos_peerlist.json && chown 1000:1000 /state/demos_peerlist.json"

echo "+ peerlists seeded"

# Bring up the companion alongside the primary stack.
docker compose \
    -f docker-compose.yml \
    -f testing/multinode/docker-compose.companion.yml \
    up -d companion-db-init companion

echo "+ companion-up complete"
echo "+ check status: docker compose ps"
echo "+ host RPC:      http://localhost:53550"
echo "+ companion RPC: http://localhost:53560"
echo
echo "Note: demos-node must be restarted to re-read its peerlist:"
echo "  docker restart demos-node"
