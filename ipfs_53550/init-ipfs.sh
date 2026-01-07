#!/bin/sh
# REVIEW: Phase 9 - Initialize IPFS with fixed swarm port 4001
# This script runs before Kubo starts to ensure consistent port configuration
# Uses host networking for direct LAN address announcement

set -e

# Get API port from environment (default 54550 for host networking)
API_PORT="${IPFS_API_PORT:-54550}"

# Initialize IPFS if not already done
if [ ! -f /data/ipfs/config ]; then
    echo "[init-ipfs] Initializing IPFS repository..."
    ipfs init --profile=server
fi

# Configure swarm addresses to use fixed port 4001
echo "[init-ipfs] Configuring swarm addresses to use port 4001..."
ipfs config Addresses.Swarm --json '[
    "/ip4/0.0.0.0/tcp/4001",
    "/ip6/::/tcp/4001",
    "/ip4/0.0.0.0/udp/4001/quic-v1",
    "/ip6/::/udp/4001/quic-v1",
    "/ip4/0.0.0.0/udp/4001/quic-v1/webtransport",
    "/ip6/::/udp/4001/quic-v1/webtransport"
]'

# Configure API to listen on localhost only with dynamic port
# Host networking means we bind directly to host ports
echo "[init-ipfs] Configuring API on port ${API_PORT}..."
ipfs config Addresses.API "/ip4/127.0.0.1/tcp/${API_PORT}"

# REVIEW: Phase 9 - Configure address announcement to include LAN IPs
# The server profile blocks private IP ranges (192.168.x.x, 10.x.x.x, 172.16.x.x) by default
# We WANT to announce these for local peer discovery within the Demos network
# Clear NoAnnounce to allow private/LAN addresses to be announced to peers
echo "[init-ipfs] Clearing NoAnnounce filter (allow LAN address announcement)..."
ipfs config Addresses.NoAnnounce --json '[]'

# Disable local discovery (mDNS) for production - we use Demos peer discovery
echo "[init-ipfs] Disabling mDNS local discovery..."
ipfs config Discovery.MDNS.Enabled --json false

# Enable NAT port mapping (helps with traversal)
echo "[init-ipfs] Enabling NAT port mapping..."
ipfs config Swarm.EnableAutoNATService --json true

echo "[init-ipfs] Configuration complete. Starting IPFS daemon..."
echo "[init-ipfs] API will be available on localhost:${API_PORT}"
echo "[init-ipfs] Swarm will be available on port 4001 (TCP/UDP)"

# Start IPFS daemon (this replaces the container's default CMD)
exec ipfs daemon --migrate=true
