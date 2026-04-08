# Architecture

**Analysis Date:** 2026-02-22

## Pattern Overview

**Overall**
- Single-process “node” application (RPC + consensus + storage + optional features in one runtime)
- Event-loop-driven main loop that periodically syncs, checks consensus time, and runs consensus
- Heavy use of shared singleton/global state for cross-module coordination

**Primary entry point**
- `src/index.ts`

**Primary loop**
- `src/utilities/mainLoop.ts`

## Core Subsystems (by directory)

**Networking / RPC**
- RPC server setup and request routing:
  - `src/libs/network/server_rpc.ts`
  - `src/libs/network/bunServer.ts`
- Endpoint handlers and per-method routines live under `src/libs/network/` (e.g. `manage*` modules)
- Rate limiting middleware exists: `src/libs/network/middleware/rateLimiter` (review for actual enforcement)

**Blockchain primitives**
- Chain/block/tx/mempool + routines:
  - `src/libs/blockchain/`
  - Validation routines (high impact): `src/libs/blockchain/routines/validateTransaction.ts`

**GCR (Global Change Registry)**
- Account/state mutation subsystem:
  - Legacy-ish: `src/libs/blockchain/gcr/gcr.ts`
  - v2 entities and helpers: `src/model/entities/GCRv2/`, `src/libs/blockchain/gcr/` (plus ZK-related integrations)

**Consensus**
- PoRBFT v2 implementation:
  - `src/libs/consensus/v2/PoRBFT.ts`
  - Supporting routines: `src/libs/consensus/v2/routines/`
- Triggered from `src/utilities/mainLoop.ts` via `consensusRoutine()`

**Peers**
- Peer model/manager + discovery/gossip:
  - `src/libs/peer/`
  - Common routines: `src/libs/peer/routines/`

**OmniProtocol (TCP)**
- Alternative peer messaging transport / protocol stack:
  - `src/libs/omniprotocol/`
  - Startup integration: `src/libs/omniprotocol/integration/startup`

**Storage layer**
- TypeORM entities + migrations:
  - Entities: `src/model/entities/`
  - DataSource: `src/model/datasource.ts`
  - Migrations: `src/migrations/`

## Feature Modules

Feature modules live under `src/features/` and are enabled/configured via env vars or code paths in `src/index.ts`.

Notable features:
- MCP server: `src/features/mcp/`
- Metrics: `src/features/metrics/`
- TLSNotary: `src/features/tlsnotary/`
- Multichain: `src/features/multichain/`
- ZK identity/proofs: `src/features/zk/`
- Instant Messaging signaling: `src/features/InstantMessagingProtocol/`
- FHE: `src/features/fhe/FHE.ts`

## Cross-cutting Concerns

**Configuration**
- Loaded via `dotenv` in `src/index.ts`
- Example env files: `.env.example`, `env.example`

**Logging / TUI**
- Central logger and TUI manager: `src/utilities/logger`, `src/utilities/tui/`

**Shared state**
- Global state container: `src/utilities/sharedState`
- Used broadly for run flags, ports, consensus timing, etc.

