# Devnet Docker Compose Setup

## Overview
Docker Compose setup for running 4 Demos nodes locally.

## Location
`/devnet/` directory

## Key Files
- `docker-compose.yml` - Orchestrates postgres + 4 nodes
- `Dockerfile` - Bun-based image
- `scripts/setup.sh` - Full setup automation
- `scripts/generate-identities.sh` - Creates 4 node identities

## Port Mapping
| Node   | RPC Port | Omni Port | IPFS Container |
|--------|----------|-----------|----------------|
| node-1 | 53551    | 53561     | ipfs-1         |
| node-2 | 53552    | 53562     | ipfs-2         |
| node-3 | 53553    | 53563     | ipfs-3         |
| node-4 | 53554    | 53564     | ipfs-4         |

## Usage
```bash
cd devnet
./scripts/setup.sh           # One-time setup
docker-compose up -d         # Start network
docker-compose down          # Stop network
```