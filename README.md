# Demos Network Node

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kynesyslabs/node)

The official node implementation for the Demos Network - a decentralized network enabling secure, cross-chain communication and computation.

## Overview

This repository contains the core node software that allows machines to participate in the Demos Network as validators and service providers. The Demos Network is designed to facilitate secure cross-chain operations, privacy-preserving computations, and decentralized services across multiple blockchain ecosystems.

## The Demos Yellowpaper

Demos is defined by the Yellowpaper publicly available in [its own repository](https://github.com/kynesyslabs/demos_yellowpaper).

## System Requirements

### Minimum Requirements
- 4GB RAM
- 4 CPU cores (2GHz or higher)
- Modern SSD storage
- 200 Mbps internet connection
- Ubuntu 22.04 LTS or compatible Linux distribution

### Recommended Specifications
- 8GB RAM or higher
- 6 CPU cores (2GHz or higher)
- High-performance SSD storage
- 1 Gbps internet connection

### Network Requirements (Firewall/Router)

Node operators **MUST** open the following ports for proper network operation:

| Port | Protocol | Purpose |
|------|----------|---------|
| **53550** | TCP | Demos RPC (main node API) |
| **53551** | TCP | OmniProtocol (Demos P2P communications) |
| **7047** | TCP | TLSNotary Service |
| **4001** | TCP + UDP | IPFS Swarm (P2P peer discovery) |
| **55000-60000** | TCP | TLSNotary WebSocket proxies |

**Note**: Port 5001 (IPFS API) is localhost-only and does not require firewall configuration.

#### Quick Firewall Setup (Ubuntu/Debian)
```bash
sudo ufw allow 53550/tcp       # Demos RPC
sudo ufw allow 53551/tcp       # OmniProtocol P2P
sudo ufw allow 7047/tcp        # TLSNotary Service
sudo ufw allow 4001/tcp        # IPFS Swarm TCP
sudo ufw allow 4001/udp        # IPFS Swarm QUIC
sudo ufw allow 55000:60000/tcp # TLSNotary WebSockets
```

#### Router Port Forwarding (NAT)
If running behind NAT, forward these ports to your node's internal IP:
- **53550 TCP** -> Node IP (Demos RPC)
- **53551 TCP** -> Node IP (OmniProtocol P2P)
- **7047 TCP** -> Node IP (TLSNotary)
- **4001 TCP+UDP** -> Node IP (IPFS Swarm)
- **55000-60000 TCP** -> Node IP (TLSNotary WebSockets)

## Installation

For detailed installation instructions, please refer to [INSTALL.md](INSTALL.md). The installation guide covers:

- System prerequisites and dependencies
- Docker and container setup
- Node configuration and key generation
- Network peer configuration
- Troubleshooting common issues

## Quick Start

1. Install prerequisites (Docker, Bun runtime)
2. Clone this repository
3. Install dependencies with `bun install`
4. Configure your node settings
5. Run `./run` to start the node

For complete step-by-step instructions, see [INSTALL.md](INSTALL.md).

## Terminal User Interface (TUI)

By default, the node runs with an interactive TUI that provides:

- **Categorized log tabs**: View logs filtered by category (Core, Network, Chain, Consensus, etc.)
- **Real-time node status**: Block height, peer count, sync status in the header
- **Keyboard navigation**: Switch tabs with number keys (0-9), scroll with arrow keys or j/k

### TUI Controls

| Key | Action |
|-----|--------|
| `0-9`, `-`, `=` | Switch to tab |
| `↑/↓` or `j/k` | Scroll logs |
| `PgUp/PgDn` | Page scroll |
| `Home/End` | Jump to top/bottom |
| `A` | Toggle auto-scroll |
| `C` | Clear current tab logs |
| `H` or `?` | Show help |
| `Q` | Quit node |

### Legacy Mode (for developers)

For debugging and development, you can disable the TUI and use traditional scrolling log output:

```bash
./run -t           # Short form
./run --no-tui     # Long form
```

This provides linear console output that can be easily piped, searched with grep, or redirected to files.

## Monitoring with Prometheus & Grafana

The node includes a full monitoring stack with Prometheus metrics and pre-built Grafana dashboards.

### Enabling Metrics

Metrics are enabled by default. To configure, add to your `.env` file:

```env
METRICS_ENABLED=true
METRICS_PORT=9090
```

The node will expose metrics at `http://localhost:9090/metrics`.

### Starting the Monitoring Stack

```bash
cd monitoring
docker compose up -d
```

**Access Grafana**: http://localhost:3000
**Default credentials**: admin / demos

### Available Metrics

| Metric | Description |
|--------|-------------|
| `demos_block_height` | Current block height |
| `demos_seconds_since_last_block` | Time since last block |
| `demos_peer_online_count` | Connected peers |
| `demos_system_cpu_usage_percent` | CPU utilization |
| `demos_system_memory_usage_percent` | Memory utilization |
| `demos_service_docker_container_up` | Container health status |

### Configuration

The node and monitoring stack are configurable via environment variables:

**Node metrics (in `.env`):**
| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `true` | Enable/disable metrics endpoint |
| `METRICS_PORT` | `9090` | Node metrics endpoint port |

**Monitoring stack (in `monitoring/.env`):**
| Variable | Default | Description |
|----------|---------|-------------|
| `PROMETHEUS_PORT` | `9091` | Prometheus server port |
| `GRAFANA_PORT` | `3000` | Grafana dashboard port |
| `GRAFANA_ADMIN_PASSWORD` | `demos` | Grafana admin password |
| `PROMETHEUS_RETENTION` | `15d` | Data retention period |

For detailed monitoring documentation, see [monitoring/README.md](monitoring/README.md).

## Technology Stack

- **Runtime**: Bun (required due to performances and advanced native features)
- **Language**: TypeScript with modern ES modules
- **Database**: PostgreSQL with TypeORM
- **Web Framework**: Fastify with RESTful APIs
- **Networking**: Custom P2P protocol implementation
- **Cryptography**: Advanced encryption libraries and post-quantum algorithms

## Configuration

After installation, configure your node by editing:

- `.env`: Core node settings including network endpoints
- `demos_peerlist.json`: Known peer connections for network participation

## Network Ports

The following ports must be open for the node to function properly.

> **Note:** These are the default ports. If you have modified any port settings in your `.env` file or run script flags, make sure to open those custom ports instead.

### Required Ports
| Port | Protocol | Description |
|------|----------|-------------|
| 53550 | TCP | Node RPC API |
| 53551 | TCP/UDP | OmniProtocol P2P communication |
| 7047 | TCP | TLSNotary server |
| 55000-60000 | TCP/UDP | WebSocket proxy for TLSNotary |

### Optional Ports
| Port | Protocol | Description |
|------|----------|-------------|
| 9090 | TCP | Metrics endpoint (monitoring) |
| 9091 | TCP | Prometheus server (monitoring stack) |
| 3000 | TCP | Grafana dashboard (monitoring stack) |
| 5332 | TCP | PostgreSQL (local only, do not expose externally) |

**Firewall example (ufw):**
```bash
# Required
sudo ufw allow 53550/tcp        # Node RPC
sudo ufw allow 53551            # OmniProtocol (TCP+UDP)
sudo ufw allow 7047/tcp         # TLSNotary
sudo ufw allow 55000:60000      # TLSNotary WS proxy (TCP+UDP)
```

## Security

The Demos Network node implements multiple layers of security:

- Cryptographic identity management with public/private key pairs
- Post-quantum cryptographic algorithms for future-proof security
- Secure peer-to-peer communication protocols
- Privacy-preserving computation capabilities

**Important**: Always keep your private key (`.demos_identity` file) secure and never share it publicly.

## Network Participation

Once your node is running, it will:

1. Generate a unique cryptographic identity
2. Connect to other network peers
3. Participate in consensus mechanisms
4. Process cross-chain transactions and computations
5. Contribute to network security and decentralization

## Local Development Network (Devnet)

For local development and testing, you can run a 4-node network using Docker Compose instead of requiring 4 separate VPSes.

### Quick Start

```bash
cd devnet
./scripts/setup.sh           # One-time setup (generates identities + peerlist)
docker-compose up -d         # Start the 4-node network
docker-compose logs -f       # View logs from all nodes
docker-compose down          # Stop the network
```

### Requirements

- Docker and Docker Compose
- BuildKit enabled (recommended): `export DOCKER_BUILDKIT=1`

### Node Ports

| Node   | RPC Port | Omni Port |
|--------|----------|-----------|
| node-1 | 53551    | 53561     |
| node-2 | 53552    | 53562     |
| node-3 | 53553    | 53563     |
| node-4 | 53554    | 53564     |

For detailed devnet documentation, see [devnet/README.md](devnet/README.md).

## Development

This is the official implementation maintained by KyneSys Labs. The codebase follows TypeScript best practices with comprehensive error handling and type safety.

## Support

For technical support and community discussions, visit [demos.sh](https://demos.sh).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

We welcome contributions to the Demos Network node implementation! Before contributing, please read our comprehensive [Contributing Guide](CONTRIBUTING.md) which covers:

- Code style and naming conventions
- Development workflow and best practices  
- AI-assisted development guidelines
- Pull request process and review requirements
- Testing and quality standards

For quick reference, also see:
- [Coding Guidelines](GUIDELINES/CODING.md) - Detailed code style guide
- [AI Development Guidelines](GUIDELINES/VIBES.md) - Essential for AI-assisted development

---

**Demos Network** - Building the future of decentralized, cross-chain computing.
