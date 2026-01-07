# Demos IPFS Integration

IPFS (InterPlanetary File System) integration for Demos Network nodes.

## Overview

This directory contains Docker Compose configuration for running a Kubo (Go-IPFS) node alongside Demos nodes. The IPFS node is **automatically started** by the `./run` script (like PostgreSQL) and is accessed through the Demos RPC layer.

## Network Requirements for Node Operators

### Required Ports (Firewall/Router Configuration)

Node operators **MUST** open the following ports for proper network operation:

| Port | Protocol | Purpose | Required |
|------|----------|---------|----------|
| **53550** | TCP | Demos RPC (main node API) | Yes |
| **53551** | TCP | OmniProtocol (Demos P2P communications) | Yes |
| **7047** | TCP | TLSNotary Service | Yes |
| **4001** | TCP + UDP | IPFS Swarm (P2P peer discovery) | Yes |
| **5001** | TCP | IPFS API (localhost only, no firewall needed) | No |
| **55000-60000** | TCP | TLSNotary WebSocket proxies | Yes |

### Quick Firewall Setup

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 53550/tcp       # Demos RPC
sudo ufw allow 53551/tcp       # OmniProtocol P2P
sudo ufw allow 7047/tcp        # TLSNotary Service
sudo ufw allow 4001/tcp        # IPFS Swarm TCP
sudo ufw allow 4001/udp        # IPFS Swarm QUIC
sudo ufw allow 55000:60000/tcp # TLSNotary WebSockets

# firewalld (RHEL/CentOS/Fedora)
sudo firewall-cmd --permanent --add-port=53550/tcp
sudo firewall-cmd --permanent --add-port=53551/tcp
sudo firewall-cmd --permanent --add-port=7047/tcp
sudo firewall-cmd --permanent --add-port=4001/tcp
sudo firewall-cmd --permanent --add-port=4001/udp
sudo firewall-cmd --permanent --add-port=55000-60000/tcp
sudo firewall-cmd --reload

# iptables
sudo iptables -A INPUT -p tcp --dport 53550 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 53551 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 7047 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 4001 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 4001 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 55000:60000 -j ACCEPT
```

### Router Port Forwarding

If running behind NAT, forward these ports to your node's internal IP:
- **53550 TCP** -> Node IP (Demos RPC)
- **53551 TCP** -> Node IP (OmniProtocol P2P)
- **7047 TCP** -> Node IP (TLSNotary)
- **4001 TCP+UDP** -> Node IP (IPFS Swarm)
- **55000-60000 TCP** -> Node IP (TLSNotary WebSockets)

## Automatic Startup

IPFS is started and stopped automatically by the `./run` script:

```bash
# Standard node startup (includes IPFS)
./run

# With custom port (IPFS API will be PORT + 1000)
./run -p 53551  # Node on 53551, IPFS API on 54551

# Clean start (resets IPFS data too)
./run -c true
```

### Internal Port Assignment

| Component | Default Port | Custom Port Example |
|-----------|--------------|---------------------|
| Demos Node | 53550 | 53551 |
| IPFS API | 54550 | 54551 |
| PostgreSQL | 5332 | 5333 |

The IPFS API port is calculated as `NODE_PORT + 1000`.

## Manual Startup (Development Only)

For development or debugging, you can start IPFS manually:

```bash
# Start IPFS node manually
./ipfs/start_ipfs          # Default port 53550
./ipfs/start_ipfs 53551    # Custom port 53551

# Stop IPFS node manually
./ipfs/stop_ipfs           # Default port 53550
./ipfs/stop_ipfs 53551     # Custom port 53551

# View logs
docker logs -f ipfs_53550
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       External Network                               │
│                                                                      │
│    Client ──────────────► Demos RPC (:53550)                        │
│                              │                                       │
│    P2P Peers ◄─────────────► OmniProtocol (:53551)                  │
│                              │                                       │
│    IPFS Peers ◄────────────► IPFS Swarm (:4001 TCP/UDP)            │
│                              │                                       │
│    TLSNotary ◄─────────────► TLSN Service (:7047)                  │
│                              │                                       │
│    TLSNotary WS ◄──────────► TLSN WebSockets (:55000-60000)        │
│                              │                                       │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
┌──────────────────────────────┼───────────────────────────────────────┐
│                         localhost                                     │
│                              │                                       │
│                              ▼                                       │
│    ┌─────────────────────────────────────────────┐                  │
│    │           Demos Node                         │                  │
│    │                                              │                  │
│    │   IPFSManager ──────► IPFS API (:54550)    │                  │
│    │                              │               │                  │
│    └──────────────────────────────┼───────────────┘                  │
│                                   │                                  │
│                                   ▼                                  │
│    ┌─────────────────────────────────────────────┐                  │
│    │           ipfs_53550 (Kubo)                  │                  │
│    │                                              │                  │
│    │   • HTTP API: :54550 (localhost only)       │                  │
│    │   • Swarm: :4001 (public, P2P discovery)    │                  │
│    │   • Data: ./data_53550/ipfs                  │                  │
│    └─────────────────────────────────────────────┘                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `53550` | Node port (IPFS uses PORT + 1000) |
| `IPFS_API_PORT` | `54550` | IPFS API port (auto-calculated) |

### Data Storage

IPFS data is stored in `ipfs_{PORT}/data_{PORT}/ipfs/` to support multiple node instances.

## Integration with Demos Node

The `IPFSManager` class in `src/features/ipfs/` provides the TypeScript interface:

```typescript
import { createIpfsManager } from "@/features/ipfs"

const ipfs = createIpfsManager({ debug: true })
await ipfs.initialize()

// Health check
const health = await ipfs.healthCheck()
console.log(`Healthy: ${health.healthy}, Peer ID: ${health.peerId}`)

// Get node ID
const peerId = await ipfs.getNodeId()
```

The `IPFS_API_PORT` environment variable is automatically set by the `./run` script.

## Phases

This is **Phase 1** of the IPFS integration. Subsequent phases will add:

- **Phase 2**: Account state schema (ipfs_pins field)
- **Phase 3**: demosCall handlers (gas-free reads)
- **Phase 4**: Transaction types (IPFS_ADD, IPFS_PIN, IPFS_UNPIN)
- **Phase 5**: Tokenomics (pay to pin, earn to host)
- **Phase 6**: SDK integration (sdk.ipfs module)
- **Phase 7**: Streaming for large files
- **Phase 8**: Private network cluster sync
- **Phase 9**: Peer discovery via hello_peer capability exchange

## Troubleshooting

### Container won't start

```bash
# Check logs (use your port)
docker logs ipfs_53550

# Verify image
docker pull ipfs/kubo:v0.26.0

# Check port availability
lsof -i :54550
lsof -i :4001
```

### Health check failing

```bash
# Manual health check (use your port)
docker exec ipfs_53550 ipfs id

# Check if API is responding
curl -s http://127.0.0.1:54550/api/v0/id
```

### IPFS peers not connecting

```bash
# Check swarm port is open
nc -zv your-public-ip 4001

# Check IPFS swarm peers
docker exec ipfs_53550 ipfs swarm peers

# Verify addresses are announced
docker exec ipfs_53550 ipfs id
```

### Reset IPFS data

```bash
# Stop the node first
./run  # then Ctrl+C

# Remove IPFS data for a specific port
rm -rf ipfs_53550/data_53550/

# Restart
./run
```

### Multiple Instances

Each Demos node instance gets its own IPFS container:

```bash
# Terminal 1 - Default instance
./run -p 53550 -d 5332   # IPFS on 54550

# Terminal 2 - Second instance
./run -p 53551 -d 5333   # IPFS on 54551
```

**Note**: Running multiple IPFS instances requires different swarm ports. Configure via IPFS config or use separate hosts.
