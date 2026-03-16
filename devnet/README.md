# Demos Network Devnet

Local 4-node development network using Docker Compose. Run a full mesh network locally instead of deploying to 4 VPSes.

## Prerequisites

- Docker & Docker Compose
- Bun (for identity generation)
- Node dependencies installed (`bun install` in parent directory)

## Quick Start

```bash
cd devnet

# 1. Run setup (generates identities + peerlist)
./scripts/setup.sh

# 2. Start the devnet
docker compose up --build
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Network                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  node-1  │──│  node-2  │──│  node-3  │──│  node-4  │    │
│  │  :53551  │  │  :53552  │  │  :53553  │  │  :53554  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │             │             │             │           │
│       └─────────────┴──────┬──────┴─────────────┘           │
│                            │                                 │
│                     ┌──────┴──────┐                         │
│                     │  PostgreSQL │                         │
│                     │  (4 DBs)    │                         │
│                     └─────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

- **PostgreSQL**: Single container with 4 databases (node1_db, node2_db, node3_db, node4_db)
- **Nodes**: 4 containers running the Demos node software
- **Networking**: Full mesh via Docker DNS (`node-1`, `node-2`, etc.)
- **Identity**: Each node has its own cryptographic identity (BIP39 mnemonic)

## Configuration

Copy `.env.example` to `.env` to customize:

```bash
cp .env.example .env
```

### Environment Variables

| Variable            | Default   | Description                      |
| ------------------- | --------- | -------------------------------- |
| `NODE1_PORT`        | 53551     | HTTP RPC port for node 1         |
| `NODE2_PORT`        | 53552     | HTTP RPC port for node 2         |
| `NODE3_PORT`        | 53553     | HTTP RPC port for node 3         |
| `NODE4_PORT`        | 53554     | HTTP RPC port for node 4         |
| `NODE1_OMNI_PORT`   | 53561     | OmniProtocol P2P port for node 1 |
| `POSTGRES_USER`     | demosuser | Postgres username                |
| `POSTGRES_PASSWORD` | demospass | Postgres password                |
| `PERSISTENT`        | 0         | Set to 1 for persistent volumes  |

## Usage

### Start devnet

```bash
docker compose up --build
```

### Start in background

```bash
docker compose up --build -d
docker compose logs -f  # follow logs
```

### Stop devnet

```bash
docker compose down
```

### Stop and remove volumes (clean state)

```bash
docker compose down -v
```

### Rebuild after code changes

```bash
docker compose up --build
```

## Node Endpoints

Once running, nodes are accessible at:

| Node   | HTTP RPC               | OmniProtocol    |
| ------ | ---------------------- | --------------- |
| node-1 | http://localhost:53551 | localhost:53561 |
| node-2 | http://localhost:53552 | localhost:53562 |
| node-3 | http://localhost:53553 | localhost:53563 |
| node-4 | http://localhost:53554 | localhost:53564 |

## Persistence Mode

By default, the devnet runs in **ephemeral mode** - all data is lost when containers stop.

For persistent development:

```bash
# In .env
PERSISTENT=1
```

This creates a `postgres-data` volume that survives restarts.

## Regenerating Identities

To generate new node identities:

```bash
./scripts/generate-identities.sh
./scripts/generate-peerlist.sh
docker compose down -v  # clear old state
docker compose up --build
```

## Observability

### View logs

```bash
./scripts/logs.sh           # All services
./scripts/logs.sh nodes     # All 4 nodes
./scripts/logs.sh node-1    # Specific node
./scripts/logs.sh postgres  # Database only
```

### Attach to container

```bash
./scripts/attach.sh node-1  # Interactive shell in node-1
./scripts/attach.sh postgres # psql client for database
```

### Tmux multi-view (all 4 nodes)

```bash
./scripts/watch-all.sh
```

Opens a tmux session with 4 panes, one per node:

```
┌─────────────┬─────────────┐
│   node-1    │   node-2    │
├─────────────┼─────────────┤
│   node-3    │   node-4    │
└─────────────┴─────────────┘
```

- `Ctrl+B` then `D` to detach
- `tmux attach -t demos-devnet` to reattach

## Troubleshooting

### Nodes can't connect to each other

- Ensure `demos_peerlist.json` was generated after identities
- Check that Docker networking is working: `docker network inspect demos-devnet_demos-network`

### Database connection errors

- Wait for PostgreSQL health check to pass
- Check logs: `docker compose logs postgres`

### Port already in use

- Change ports in `.env` file
- Or stop conflicting services

## Files Structure

```
devnet/
├── docker compose.yml      # Main orchestration
├── Dockerfile              # Node container image
├── entrypoint.sh           # Container startup script
├── .env.example            # Configuration template
├── .env                    # Your local config (gitignored)
├── demos_peerlist.json     # Generated peerlist (gitignored)
├── postgres-init/
│   └── init-databases.sql  # Creates 4 databases
├── scripts/
│   ├── setup.sh            # One-time setup
│   ├── generate-identities.sh
│   ├── generate-identity-helper.ts
│   ├── generate-peerlist.sh
│   ├── logs.sh             # View container logs
│   ├── attach.sh           # Attach to container
│   └── watch-all.sh        # Tmux 4-pane view
└── identities/             # Generated identities (gitignored)
    ├── node1.identity
    ├── node1.pubkey
    └── ...
```
