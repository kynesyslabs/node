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

## Reverse Proxy (Caddy) — `proxy` profile

Local smoke test of Epic 12 without a public domain or ACME. Caddy
fronts node-1 on `localhost:443` using its internal CA (self-signed),
and exercises the same routes the production Caddyfile ships.

### Bring up

```bash
cd testing/devnet

# Boot a minimal proxy stack: postgres + tlsnotary + node-1 + caddy.
docker compose --profile proxy up -d postgres tlsnotary node-1 caddy

# Wait ~30s for node-1 to bootstrap.
docker compose --profile proxy logs -f node-1
```

Caddy lives at `https://localhost/`. The cert is self-signed, so
clients need to skip verification (`curl --insecure`, browser warning,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, etc.).

### Smoke test

```bash
# Devnet skips Grafana / Prometheus — pass SMOKE_NO_MONITORING=1 so
# those checks are SKIP instead of FAIL.
PROXY_DOMAIN=localhost \
CADDY_INSECURE=1 \
SMOKE_NO_MONITORING=1 \
    ../../scripts/smoke-proxy.sh
```

Expected: `PASS=8 FAIL=0 SKIP=4`.

### TLSNotary proxy driver

Partial (Node-side, no WASM):

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 \
NODE_URL=https://localhost \
ALLOW_INSECURE=1 \
EXPECTED_HOST=localhost \
    bun run ../../scripts/test-tlsnotary-proxy.ts
```

Verifies that `requestTLSNproxy` reaches the node handler through
Caddy. Returns PASS-with-caveat — a real DAHR token is needed for the
full WS proxy URL response.

Full (Playwright + WASM notary session):

```bash
# One-time: download the chromium binary playwright needs.
bunx playwright install chromium

# Run the full attest flow through a real browser.
PROXY_URL=https://localhost \
ALLOW_INSECURE=1 \
    bun run ../../scripts/test-tlsnotary-proxy.playwright.ts
```

This driver spins a tiny HTTP server that serves the SDK build + WASM
files, launches headless Chromium, and drives the full
`initTlsn → new TLSNotary → attestQuick` flow through Caddy. Set
`HEADED=1` to watch the browser in real time.

### TLSNotary proxy mode

The Caddyfile imports route snippets keyed by `TLSNOTARY_PROXY_MODE`:

| Mode       | Path                                          | Devnet support |
|------------|-----------------------------------------------|----------------|
| `subpath`  | `https://${PROXY_DOMAIN}/tlsnotary/`          | yes (default)  |
| `direct`   | no proxy route; clients hit host port 7048    | yes            |
| `subdomain`| `https://notary.${PROXY_DOMAIN}/`             | **no** — needs DNS |

Flip via `.env`:

```bash
echo "TLSNOTARY_PROXY_MODE=direct" >> .env
docker compose --profile proxy restart caddy
```

### Teardown

```bash
docker compose --profile proxy down
```

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
