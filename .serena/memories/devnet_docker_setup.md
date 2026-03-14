# Devnet Docker Compose Setup

## Overview

A Docker Compose setup for running 4 Demos Network nodes locally, replacing the need for 4 VPSes during development.

## Location

`/devnet/` directory in the main repository.

## Key Components

### Files

- `docker-compose.yml` - Orchestrates postgres + 4 nodes
- `Dockerfile` - Bun-based image with native module support
- `run-devnet` - Simplified node runner (no git, bun install, postgres management)
- `postgres-init/init-databases.sql` - Creates node1_db through node4_db
- `scripts/setup.sh` - Full setup automation
- `scripts/generate-identities.sh` - Creates 4 node identities
- `scripts/generate-peerlist.sh` - Creates demos_peerlist.json with Docker hostnames

### Environment Variables for Nodes

Each node requires:

- `PG_HOST` - PostgreSQL hostname (default: postgres)
- `PG_PORT` - PostgreSQL port (default: 5432)
- `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`
- `PORT` - Node RPC port
- `OMNI_PORT` - Omniprotocol port
- `EXPOSED_URL` - Self URL for peer discovery (e.g., `http://node-1:53551`)

### Port Mapping

| Node   | RPC Port | Omni Port |
| ------ | -------- | --------- |
| node-1 | 53551    | 53561     |
| node-2 | 53552    | 53562     |
| node-3 | 53553    | 53563     |
| node-4 | 53554    | 53564     |

## Build Optimization

- Uses BuildKit: `DOCKER_BUILDKIT=1 docker-compose build`
- Layer caching: package.json copied first, deps installed, then rest
- Native modules: `bufferutil`, `utf-8-validate` compiled with build-essential + python3-setuptools

## Related Changes

- `src/model/datasource.ts` - Added env var support for external DB
- `./run` - Added `--external-db` / `-e` flag

## Usage

```bash
cd devnet
./scripts/setup.sh           # One-time setup
docker-compose up -d         # Start network
docker-compose logs -f       # View logs
docker-compose down          # Stop network
```
