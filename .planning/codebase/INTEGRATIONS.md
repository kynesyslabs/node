# External Integrations

**Analysis Date:** 2026-02-22

## Environment-Configured Integrations (high signal)

**Social / Web2 identity**
- Twitter/X
  - Env: `TWITTER_USERNAME`, `TWITTER_PASSWORD`, `TWITTER_EMAIL` (`.env.example`)
  - Code: `src/libs/identity/tools/twitter.ts`, `src/libs/abstraction/web2/twitter.ts`
- Discord
  - Env: `DISCORD_API_URL`, `DISCORD_BOT_TOKEN` (`.env.example`)
  - Code: `src/libs/identity/tools/discord.ts`, `src/libs/abstraction/web2/discord.ts`
- GitHub
  - Env: `GITHUB_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (`.env.example`, `env.example`)
  - SDK: `@octokit/core` (present in deps)
  - Code: `src/libs/identity/tools/github.ts`, `src/libs/abstraction/web2/github.ts`

**Bridge aggregation / cross-chain**
- Rubic
  - Env: `RUBIC_API_REFERRER_ADDRESS`, `RUBIC_API_INTEGRATOR_ADDRESS` (`env.example`)
  - Code: `src/features/bridges/rubic.ts`, `src/features/bridges/bridgeUtils.ts`, `src/libs/network/manageBridge.ts`

**Third-party API providers**
- RapidAPI
  - Env: `RAPID_API_KEY`, `RAPID_API_HOST` (`env.example`)
  - Code: search under `src/libs/identity/tools/` and `src/libs/abstraction/web2/` for consumers

**Chain data providers**
- Etherscan
  - Env: `ETHERSCAN_API_KEY` (`env.example`)
- Helius (Solana RPC / API)
  - Env: `HELIUS_API_KEY` (`env.example`)

## Datastores

**PostgreSQL (primary)**
- TypeORM DataSource: `src/model/datasource.ts`
- Env (read at runtime): `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`
- Local bootstrap scripts/dirs: `postgres/`, `start_db`, `postgres_5332/` (if present for local runs)

**SQLite (secondary / tooling)**
- `ormconfig.json` points at `./data/chain.db`

## Node-to-Node / Protocol Integrations

**HTTP RPC**
- Bun-based RPC server: `src/libs/network/server_rpc.ts` + `src/libs/network/bunServer.ts`

**OmniProtocol**
- TCP peer protocol and server lifecycle: `src/libs/omniprotocol/`
- Env: `OMNI_ENABLED`, `OMNI_PORT`, TLS options (`.env.example`)

**Instant Messaging / Signaling**
- Signaling server: `src/features/InstantMessagingProtocol/signalingServer/`
- Env: `SIGNALING_SERVER_PORT` (`env.example`)

## MCP (Model Context Protocol)

**Feature**
- MCP server implementation: `src/features/mcp/MCPServer.ts`
- Entry: `src/features/mcp/index.ts`

**Enablement**
- Env: `MCP_ENABLED`, `MCP_SERVER_PORT` (`env.example`)

## Metrics / Monitoring

**Node metrics endpoint**
- Env: `METRICS_ENABLED`, `METRICS_PORT`, `METRICS_HOST` (`.env.example`)
- Code: `src/features/metrics/`

**Monitoring stack**
- Docker Compose: `monitoring/`

## TLSNotary

**Enablement**
- Env: `TLSNOTARY_ENABLED`, `TLSNOTARY_PORT`, `TLSNOTARY_SIGNING_KEY`, proxy limits (`.env.example`)
- Code: `src/features/tlsnotary/` and `tlsnotary/` (external tooling)

## Time / Networking Utilities

- NTP client: `ntp-client` used by `src/libs/utils/calibrateTime.ts`

## Core SDK dependency (@kynesyslabs/demosdk)

- Version: `^2.10.2` (from `package.json`)
- Used throughout for types and crypto helpers:
  - `@kynesyslabs/demosdk/types`
  - `@kynesyslabs/demosdk/encryption`
  - `@kynesyslabs/demosdk` (bridge-related types/helpers)

