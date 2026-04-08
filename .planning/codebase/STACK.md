# Technology Stack

**Analysis Date:** 2026-02-22

## Languages

**Primary**
- TypeScript (`devDependencies.typescript`: `^5.9.3`) — most code under `src/`

**Other**
- Shell scripts: `run`, `start_db`, `reset-node`, `install-deps.sh`
- Docker Compose/YAML: `devnet/`, `monitoring/`

## Runtime & Packaging

**Runtime**
- Bun (first-class): `src/libs/network/bunServer.ts` uses `Bun.serve()`
- Node.js is still used for some workflows/scripts (e.g. `tsx`, `ts-node-dev`)

**Module system**
- ESM: `package.json` has `"type": "module"`
- TS module resolution: `tsconfig.json` sets `"moduleResolution": "bundler"`
- Path alias: `tsconfig.json` maps `@/*` → `src/*`

**Package manager**
- Bun is the expected package manager (`bun install`)
- Lockfile present: `bun.lock`

## Web / Networking Frameworks

**HTTP RPC**
- Custom Bun HTTP server/router: `src/libs/network/bunServer.ts`
- RPC request processing: `src/libs/network/server_rpc.ts`

**Fastify (auxiliary)**
- Used for OpenAPI + method listing types/handlers:
  - `src/libs/network/openApiSpec.ts` (`@fastify/swagger`, `@fastify/swagger-ui`)
  - `src/libs/network/methodListing.ts`

**Express (feature module)**
- Used by MCP server implementation: `src/features/mcp/MCPServer.ts`

**Real-time / P2P**
- Socket.IO present (`socket.io`, `socket.io-client`) and used under `src/libs/peer/` and related networking libs (search for usage when modifying peer comms)
- Custom TCP protocol: OmniProtocol under `src/libs/omniprotocol/`

## Data / Storage

**ORM**
- TypeORM (`typeorm`: `^0.3.17`)

**Primary DB**
- PostgreSQL driver: `pg` (`^8.12.0`)
- DataSource config: `src/model/datasource.ts` (reads `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`)

**Secondary / legacy / tooling**
- SQLite config exists: `ormconfig.json` points at `./data/chain.db`
- `sqlite3` dependency present (`^5.1.6`)

## Blockchain / Multichain

**Core SDK**
- `@kynesyslabs/demosdk` (`^2.10.2`) — types + crypto helpers used broadly:
  - Types: `@kynesyslabs/demosdk/types` (e.g. `RPCRequest`, `RPCResponse`)
  - Crypto helpers: `@kynesyslabs/demosdk/encryption` (e.g. `uint8ArrayToHex`)

**EVM**
- `ethers` (`^6.16.0`) (assume v6 semantics) — EVM interactions / resolution routines
- `web3` (`^4.16.0`) — used in bridge integrations

**Solana**
- `@solana/web3.js` (present in deps) — Solana interactions
- `@coral-xyz/anchor` (present in deps) — Anchor program interaction

**Aptos**
- `@aptos-labs/ts-sdk` (present in deps) — Aptos interactions

## Cryptography

**General**
- `node-forge`, `tweetnacl`, `@noble/*`, `bs58`, mnemonic libs (`bip39`, `@scure/bip39`)

**Advanced**
- `node-seal` (FHE): `src/features/fhe/FHE.ts`

## Observability & Ops

**Metrics**
- Prometheus client: `prom-client` (feature: `src/features/metrics/`)
- Monitoring stack configs: `monitoring/` (Grafana + Prometheus)

**Logging / TUI**
- Custom categorized logger + TUI: `src/utilities/logger`, `src/utilities/tui/`

## Tooling / Quality

**Lint / format**
- ESLint: `.eslintrc.cjs` (`eslint`: `^8.57.1`)
- Prettier: `.prettierrc` (`prettier`: `^2.8.0`)
- Dead code: `knip.json` (`knip` script in `package.json`)

**Testing**
- Jest: `jest.config.ts` + `bun run test:chains`
- TypeScript transform: `ts-jest`

