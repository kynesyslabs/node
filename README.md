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

## Installation

Docker Compose is now the recommended way to run a Demos node. For full installation instructions — both the Docker path and the bare-metal `./run` path — see [INSTALL.md](INSTALL.md). The guide covers:

- Docker Compose quickstart (recommended)
- Bare-metal install with Bun + Postgres (alternative)
- Node configuration and key generation
- Network peer configuration
- Troubleshooting common issues

## Quick Start (Docker)

```bash
git clone https://github.com/kynesyslabs/node.git && cd node
cp .env.example .env  # defaults are fine; edit only if you want to override
docker compose up
```

Once the stack is healthy: RPC at http://localhost:53550 (try `curl http://localhost:53550/info`) and Grafana at http://localhost:3000 (default `admin` / `demos`).

### Reverse-proxy mode (Caddy)

Bring up the same stack behind Caddy on a single TLS endpoint:

```bash
./run --docker --proxy            # equivalent to scripts/docker-run --proxy
./run --docker --proxy --no-monitor   # drop Grafana/Prom
./run --docker --proxy -d         # detach
./run --docker down               # teardown (proxy or not)
```

`./run --docker [...]` forwards to `scripts/docker-run`. Plain
`./run` (no flag) keeps using the bare-metal launcher unchanged.

`--proxy` merges `docker-compose.proxy.yml` so only ports 80 + 443
(Caddy) and 53551 (OmniProtocol, custom TLS) remain published.
Requires `PROXY_DOMAIN` + `ACME_EMAIL` in `.env`. See
[docs/runbooks/proxy-setup.md](docs/runbooks/proxy-setup.md).

See [INSTALL.md](INSTALL.md) for profiles, env vars, volumes, upgrades, and troubleshooting.

## Publishing the Image

The compose file uses `${IMAGE_NAME}:${IMAGE_TAG}` (default `demos-node:local`) for the node service, so the same compose can either build locally or pull from a registry by switching `.env`.

**Build and tag for a registry:**

```bash
# Pick your registry coordinates
export IMAGE_NAME=ghcr.io/kynesyslabs/node     # or docker.io/<user>/demos-node, etc.
export IMAGE_TAG=v0.9.8                         # or git sha, or 'latest'

docker build -t "$IMAGE_NAME:$IMAGE_TAG" .
docker push "$IMAGE_NAME:$IMAGE_TAG"
```

**Multi-arch (recommended for public registries):**

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "$IMAGE_NAME:$IMAGE_TAG" \
  --push .
```

**Pull on a target host** — write `IMAGE_NAME` and `IMAGE_TAG` into that host's `.env`, then:

```bash
docker compose pull node
docker compose up -d
```

For private registries, run `docker login <registry>` first.

## Advanced / Bare-Metal Run

If you'd rather run the node directly on the host (no Docker for the node itself), the legacy `./run` shell script is still supported. It installs Bun, runs Postgres in a sidecar container, and starts the node natively — useful for development, debugging, and TUI-based operation.

See [INSTALL.md → Track 2: Bare metal with `./run`](INSTALL.md) for the full walkthrough.

## Terminal User Interface (TUI)

By default, the node runs with an interactive TUI that provides:

- **Categorized log tabs**: View logs filtered by category (Core, Network, Chain, Consensus, etc.)
- **Real-time node status**: Block height, peer count, sync status in the header
- **Keyboard navigation**: Switch tabs with number keys (0-9), scroll with arrow keys or j/k

### TUI Controls

| Key             | Action                 |
| --------------- | ---------------------- |
| `0-9`, `-`, `=` | Switch to tab          |
| `↑/↓` or `j/k`  | Scroll logs            |
| `PgUp/PgDn`     | Page scroll            |
| `Home/End`      | Jump to top/bottom     |
| `A`             | Toggle auto-scroll     |
| `C`             | Clear current tab logs |
| `H` or `?`      | Show help              |
| `Q`             | Quit node              |

### Legacy Mode (for developers)

For debugging and development, you can disable the TUI and use traditional scrolling log output:

```bash
./run -t           # Short form
./run --no-tui     # Long form
```

This provides linear console output that can be easily piped, searched with grep, or redirected to files.

## Monitoring

Prometheus + Grafana are part of the unified compose (default profile). Once `docker compose up` is healthy, Grafana is at http://localhost:3000 (`admin` / `demos`) with pre-provisioned dashboards. Configuration knobs (`GRAFANA_ADMIN_PASSWORD`, `PROMETHEUS_RETENTION`, etc.) live in `.env` — see [INSTALL.md → Track 1](INSTALL.md) for the full list.

Available node-side metrics (scraped at `node:9090/metrics`):

| Metric                              | Description             |
| ----------------------------------- | ----------------------- |
| `demos_block_height`                | Current block height    |
| `demos_seconds_since_last_block`    | Time since last block   |
| `demos_peer_online_count`           | Connected peers         |
| `demos_system_cpu_usage_percent`    | CPU utilization         |
| `demos_system_memory_usage_percent` | Memory utilization      |
| `demos_service_docker_container_up` | Container health status |

For dashboard internals and customization, see [monitoring/README.md](monitoring/README.md).

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

For the docker-compose path see [INSTALL.md → Network Exposure](INSTALL.md#network-exposure) — that section has the canonical inbound/outbound rules and a `ufw` example for VPS deployments.

For the bare-metal `./run` path:

### Required Ports (bare metal)

| Port        | Protocol | Description                    |
| ----------- | -------- | ------------------------------ |
| 53550       | TCP      | Node RPC API                   |
| 53551       | TCP      | OmniProtocol P2P communication |
| 7047        | TCP      | TLSNotary server (FFI/docker)  |
| 55000-60000 | TCP      | WebSocket proxy for TLSNotary FFI mode |

### Optional Ports (bare metal)

| Port | Protocol | Description                                       |
| ---- | -------- | ------------------------------------------------- |
| 9090 | TCP      | Metrics endpoint (monitoring)                     |
| 9091 | TCP      | Prometheus server (monitoring stack)              |
| 3000 | TCP      | Grafana dashboard (monitoring stack)              |
| 5332 | TCP      | PostgreSQL (local only, do not expose externally) |

**Firewall example (ufw):**

```bash
# Required
sudo ufw allow 53550/tcp        # Node RPC
sudo ufw allow 53551/tcp        # OmniProtocol
sudo ufw allow 7047/tcp         # TLSNotary
sudo ufw allow 55000:60000/tcp  # TLSNotary WS proxy (FFI mode)
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
| ------ | -------- | --------- |
| node-1 | 53551    | 53561     |
| node-2 | 53552    | 53562     |
| node-3 | 53553    | 53563     |
| node-4 | 53554    | 53564     |

For detailed devnet documentation, see [testing/devnet/README.md](testing/devnet/README.md).

## Developer's Guide

This is the official implementation maintained by KyneSys Labs. The codebase follows TypeScript best practices with comprehensive error handling and type safety.

### Tooling Overview

| Tool | Purpose | Command |
|------|---------|---------|
| **Bun** | Runtime & package manager | `bun install`, `bun run <script>` |
| **Trunk** | Linting & formatting (owns ESLint + Prettier) | `bun check`, `bun fmt` |
| **TypeScript** | Type checking | `bun type-check` |
| **Jest** | Testing | `bun test:chains` |

### Quick Commands

```bash
# Install dependencies
bun install

# Linting & formatting (Trunk-managed)
bun check                    # Run all linters
bun fmt                      # Auto-format code
bun lint                     # ESLint only
bun lint:fix                 # ESLint with auto-fix

# Type checking
bun type-check               # Fast check via Bun
bun type-check-ts            # Full tsc --noEmit

# Development
bun start:bun                # Start node with Bun runtime
bun dev                      # Start with hot reload

# Dependency management
bun upgrade_sdk              # Update @kynesyslabs/demosdk
bun upgrade_deps             # Interactive dependency update
```

### Code Style

- **Trunk owns linting**: ESLint and Prettier are managed by Trunk, not npm packages
- **Run `bun check` before committing**: Catches style issues early
- **Double quotes, no semicolons**: Per `.prettierrc` and `.eslintrc.cjs`
- **camelCase** for variables/functions, **PascalCase** for types/classes

### Project Structure Tips

```
src/
├── features/          # Feature modules (MCP, metrics, multichain, etc.)
├── libs/              # Core libraries (blockchain, consensus, crypto, network)
├── model/             # TypeORM entities and database
├── utilities/         # CLI tools, TUI, helpers
└── index.ts           # Entry point
```

### Common Patterns

- **Logging**: Use `CategorizedLogger` instead of `console.log` in `src/` (ESLint warns)
- **Imports**: Prefer `@/` path aliases over deep relative imports
- **SDK**: Import from `@kynesyslabs/demosdk`, check `demosdk-refs` MCP for docs
- **Database**: TypeORM with `synchronize: true` is intentional for dev

### Issue Tracking

This project uses [Mycelium](https://github.com/tcsenpai/mycelium) (`myc`) for task and epic management.

## Support

For technical support and community discussions, visit [demos.sh](https://demos.sh).

## License

This project is licensed under the [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) License - see the [LICENSE](LICENSE.md) file for details.

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
