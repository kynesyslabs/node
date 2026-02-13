# Architecture

**Analysis Date:** 2026-01-28

## Pattern Overview

**Overall:** Monolithic node application with event-loop-driven consensus

**Key Characteristics:**
- Single-process blockchain node (RPC + consensus + networking in one binary)
- Singleton-based shared state pattern for cross-module communication
- Layered architecture: Network (RPC) -> Blockchain (Chain/GCR) -> Consensus (PoRBFT) -> Storage (TypeORM/Postgres)
- Feature modules bolted onto the core node as optional services (MCP, TLSNotary, Metrics, OmniProtocol)
- Background main loop drives consensus timing and peer management

## Layers

**Entry / Bootstrap Layer:**
- Purpose: Initialize the node, configure services, start the main loop
- Location: `src/index.ts`
- Contains: Warmup sequence, argument parsing, port allocation, service startup
- Depends on: All other layers
- Used by: Nothing (top-level entry point)

**Network / RPC Layer:**
- Purpose: Handle inbound RPC requests from clients and peers
- Location: `src/libs/network/`
- Contains: Bun HTTP server (`bunServer.ts`), RPC router (`server_rpc.ts`), endpoint handlers (`endpointHandlers.ts`), method-specific managers (`manageConsensusRoutines.ts`, `manageGCRRoutines.ts`, `manageNodeCall.ts`, `manageHelloPeer.ts`, `manageExecution.ts`, `manageBridge.ts`, `manageNativeBridge.ts`, `manageAuth.ts`, `manageLogin.ts`)
- Depends on: Blockchain layer, Consensus layer, SharedState
- Used by: External clients, peer nodes

**Blockchain Layer:**
- Purpose: Chain state management, block/transaction/GCR CRUD operations
- Location: `src/libs/blockchain/`
- Contains: `chain.ts` (static Chain class for DB queries), `block.ts`, `transaction.ts`, `mempool_v2.ts`, GCR subsystem (`gcr/`), sync routines (`routines/Sync.ts`)
- Depends on: Model/Storage layer, Crypto layer
- Used by: Network layer, Consensus layer

**GCR (Global Change Registry) Subsystem:**
- Purpose: Mutable account state derived from immutable blockchain transactions
- Location: `src/libs/blockchain/gcr/`
- Contains: `gcr.ts` (main GCR operations), `handleGCR.ts`, routines in `gcr_routines/` (balance, identity, nonce, TLSNotary, incentive management, signature detection, cross-chain assignment)
- Depends on: Model layer (GCR entities), Crypto layer
- Used by: Blockchain layer, Consensus layer

**Consensus Layer:**
- Purpose: PoRBFT (Proof of Reliability BFT) consensus algorithm
- Location: `src/libs/consensus/v2/`
- Contains: `PoRBFT.ts` (main consensus routine), routines for block creation, mempool merging, peer list merging, shard computation, block hash broadcasting, validator seed generation
- Depends on: Blockchain layer, Peer layer, Communications layer, SharedState
- Used by: Main loop (`src/utilities/mainLoop.ts`)
- Key concept: Secretary-based semaphore system where the first node in a shard coordinates consensus progression

**Peer Layer:**
- Purpose: Peer discovery, management, and health checking
- Location: `src/libs/peer/`
- Contains: `Peer.ts` (peer data model), `PeerManager.ts` (singleton peer registry), routines for bootstrap, gossip, offline detection, broadcasting
- Depends on: Network layer (for hello_peer), SharedState
- Used by: Consensus layer, Main loop, Network layer

**Communications Layer:**
- Purpose: Broadcast messages to peers (block hashes, consensus signals)
- Location: `src/libs/communications/`
- Contains: `broadcastManager.ts`, `transmission.ts`
- Depends on: Peer layer, Network layer
- Used by: Consensus layer

**OmniProtocol Layer:**
- Purpose: Binary TCP protocol for efficient peer-to-peer communication (alternative to HTTP RPC)
- Location: `src/libs/omniprotocol/`
- Contains: TCP server, TLS support, message framing, serialization, protocol handlers (consensus, control, GCR, sync, transaction), rate limiting, connection pooling
- Depends on: Peer layer, Blockchain layer
- Used by: Peer communication (replaces HTTP when enabled)

**Crypto Layer:**
- Purpose: Cryptographic primitives (hashing, signing, key management)
- Location: `src/libs/crypto/`
- Contains: `cryptography.ts`, `hashing.ts`, `forgeUtils.ts`, `rsa.ts`
- Depends on: `@kynesyslabs/demosdk/encryption`, `node-forge`, `tweetnacl`
- Used by: All layers requiring signing/verification

**Identity Layer:**
- Purpose: Node identity management (keypair loading, public IP detection, social identity linking)
- Location: `src/libs/identity/`
- Contains: `identity.ts`, providers for Nomis/Discord/Twitter identity linking
- Depends on: Crypto layer, SharedState
- Used by: Bootstrap, GCR operations

**Model / Storage Layer:**
- Purpose: Database schema and access via TypeORM
- Location: `src/model/`
- Contains: `datasource.ts` (singleton DataSource to PostgreSQL), entities for Blocks, Transactions, Mempool, Consensus, Validators, GCR (v1 and v2), PgpKeyServer
- Depends on: PostgreSQL database, TypeORM
- Used by: Blockchain layer, GCR subsystem

**Utilities Layer:**
- Purpose: Cross-cutting concerns (logging, shared state, diagnostics, TUI)
- Location: `src/utilities/`
- Contains: `sharedState.ts` (global singleton), `logger.ts`, `mainLoop.ts`, `waiter.ts`, `Diagnostic.ts`, `tui/` (terminal UI), `backupAndRestore.ts`
- Depends on: Nothing (foundational)
- Used by: All layers

**Features Layer:**
- Purpose: Optional/pluggable features extending the core node
- Location: `src/features/`
- Contains: See Feature Modules section below
- Depends on: Core layers (Blockchain, Network, SharedState)
- Used by: `src/index.ts` (dynamically imported at startup)

## Feature Modules

**MCP Server** (`src/features/mcp/`):
- Exposes node functionality via Model Context Protocol (SSE transport)
- Tools defined in `tools/demosTools.ts`
- Started optionally via `MCP_ENABLED` env var

**TLSNotary** (`src/features/tlsnotary/`):
- HTTPS attestation service using TLSNotary proofs
- Includes proxy manager, port allocator, token-based access, FFI bridge
- Started optionally via `TLSNOTARY_ENABLED` env var

**Metrics** (`src/features/metrics/`):
- Prometheus-compatible metrics endpoint
- `MetricsServer.ts` (HTTP server on `/metrics`), `MetricsCollector.ts` (data gathering), `MetricsService.ts`
- Started optionally via `METRICS_ENABLED` env var

**Multichain / XM** (`src/features/multichain/`):
- Cross-chain transaction dispatching (`XMDispatcher.ts`)
- Chain-specific adapters: EVM (`evmwares/`), Aptos (`aptoswares/`)
- Transaction executors for balance queries, contract reads/writes, payments

**Web2 Proxy** (`src/features/web2/`):
- HTTP proxy for web2 API requests routed through the node
- DAHR (Decentralized API HTTP Router) and Proxy factories
- Request sanitization and validation

**Bridges** (`src/features/bridges/`):
- Cross-chain bridge support via Rubic SDK integration

**Instant Messaging Protocol** (`src/features/InstantMessagingProtocol/`):
- WebSocket-based signaling server for peer-to-peer messaging
- Socket.io signaling server on separate port

**ActivityPub / Fediverse** (`src/features/activitypub/`):
- Fediverse integration with SQLite-based storage

**FHE (Fully Homomorphic Encryption)** (`src/features/fhe/`):
- Experimental FHE operations using `node-seal`

**ZK (Zero Knowledge)** (`src/features/zk/`):
- Zero-knowledge proof integration (iZKP)

**Incentive** (`src/features/incentive/`):
- Point system and referral tracking

## Data Flow

**Transaction Submission Flow:**
1. Client sends signed RPC request to `server_rpc.ts` (Bun HTTP server)
2. Headers validated (signature + identity) in `validateHeaders()`
3. Request routed by `method` field to appropriate handler in `endpointHandlers.ts`
4. Transaction validated in `src/libs/blockchain/routines/validateTransaction.ts`
5. Valid transaction added to mempool (`mempool_v2.ts`)
6. Transaction broadcast to peers via `broadcastManager.ts`

**Consensus Flow (PoRBFTv2):**
1. `mainLoop.ts` checks `consensusTime.checkConsensusTime()` each cycle (~1s)
2. When consensus time reached and node is synced, calls `consensusRoutine()` in `PoRBFT.ts`
3. Shard computed from validator seed (`getCommonValidatorSeed.ts`, `getShard.ts`)
4. If node is in shard: merge mempools, merge peerlists, order transactions, create block
5. Secretary node (first in shard) coordinates progression via semaphore system
6. Block hash broadcast to network, GCR operations applied
7. Block written to chain via `Chain` class

**Sync Flow:**
1. On startup, `fastSync()` called from `src/index.ts`
2. Node compares its chain height with peers
3. Missing blocks fetched from peers via `nodeCall` RPC method
4. Blocks validated and applied to local chain + GCR

**State Management:**
- `SharedState` singleton (`src/utilities/sharedState.ts`) holds all runtime state: sync status, consensus flags, keypair, shard info, peer manager reference, connection strings, configuration
- Accessed globally via `getSharedState` export
- Mutable properties with side effects (e.g., `syncStatus` setter updates peer data)

## Key Abstractions

**Chain (Static Class):**
- Purpose: All blockchain database operations (get blocks, transactions, GCR data)
- Location: `src/libs/blockchain/chain.ts`
- Pattern: Static methods with TypeORM repositories, initialized via `Chain.setup()`

**PeerManager (Singleton):**
- Purpose: Registry of known peers, online/offline tracking, peer list file I/O
- Location: `src/libs/peer/PeerManager.ts`
- Pattern: Singleton with in-memory peer records, loaded from `demos_peerlist.json`

**SharedState (Singleton):**
- Purpose: Global mutable state shared across all modules
- Location: `src/utilities/sharedState.ts`
- Pattern: Singleton class with public properties, getters/setters with side effects

**Datasource (Singleton):**
- Purpose: TypeORM DataSource wrapper for PostgreSQL connection
- Location: `src/model/datasource.ts`
- Pattern: Singleton with lazy initialization

**BroadcastManager:**
- Purpose: Send messages to all peers or specific subsets
- Location: `src/libs/communications/broadcastManager.ts`
- Pattern: Used by consensus for block hash broadcasting

## Entry Points

**Main Entry (`src/index.ts`):**
- Location: `src/index.ts`
- Triggers: `bun run start:bun` or `tsx src/index.ts`
- Responsibilities: Full node lifecycle - setup DB, warmup, calibrate time, start RPC server, bootstrap peers, find genesis, start OmniProtocol, start optional services (MCP, TLSNotary, Metrics), run main loop, handle graceful shutdown

**RPC Server (`src/libs/network/server_rpc.ts`):**
- Location: `src/libs/network/server_rpc.ts`
- Triggers: Called from `warmup()` in `index.ts` via `serverRpcBun()`
- Responsibilities: HTTP server handling all inbound RPC requests, auth validation, method routing

**Main Loop (`src/utilities/mainLoop.ts`):**
- Location: `src/utilities/mainLoop.ts`
- Triggers: Called from `main()` in `index.ts` (runs async in background)
- Responsibilities: Periodic consensus time checking, peer routine execution, consensus triggering

**Key Generator (`src/libs/utils/keyMaker.ts`):**
- Location: `src/libs/utils/keyMaker.ts`
- Triggers: `bun run keygen`
- Responsibilities: Generate node identity keypair

## Error Handling

**Strategy:** Try-catch with logging, failsafe continuation for optional services

**Patterns:**
- Optional services (MCP, TLSNotary, Metrics, OmniProtocol) wrapped in try-catch with fallback to continue without the service
- Custom exception types in `src/exceptions/index.ts`: `TimeoutError`, `AbortError`, `BlockInvalidError`, `ForgingEndedError`, `NotInShardError`
- `Waiter` utility (`src/utilities/waiter.ts`) for timeout/abort-aware async waiting
- Graceful shutdown handlers for SIGINT/SIGTERM that stop all services in sequence
- RPC layer validates headers and returns structured `RPCResponse` with error info

## Cross-Cutting Concerns

**Logging:**
- Custom `CategorizedLogger` singleton with tag-based categorization (`src/utilities/logger.ts`)
- TUI mode available via `TUIManager` (`src/utilities/tui/TUIManager.ts`) using `terminal-kit`
- Log levels: debug, info, warning, error, critical
- Per-port log directories, custom log files for specific subsystems

**Validation:**
- RPC request validation: signature + identity headers required for authenticated endpoints
- Transaction validation in `src/libs/blockchain/routines/validateTransaction.ts`
- Rate limiting via `src/libs/network/middleware/rateLimiter.ts`
- OmniProtocol rate limiting in `src/libs/omniprotocol/ratelimit/`

**Authentication:**
- Ed25519 signature-based authentication (also supports Falcon, ML-DSA post-quantum algorithms)
- Identity header contains public key (with optional algorithm prefix like `ed25519:0xABC...`)
- Signature header contains signed identity string
- Some endpoints marked as protected requiring admin auth
- `noAuthMethods` list for unauthenticated public endpoints (e.g., `nodeCall`)

**Configuration:**
- Environment variables via `.env` file (loaded with `dotenv`)
- Key env vars: `SERVER_PORT`/`RPC_PORT`, `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_PASSWORD`, `EXPOSED_URL`, `PROD`, `OMNI_ENABLED`, `MCP_ENABLED`, `TLSNOTARY_ENABLED`, `METRICS_ENABLED`, `SHARD_SIZE`, `MAIN_LOOP_SLEEP_TIME`
- Peer list from `demos_peerlist.json`
- Genesis configuration from `data/` directory
- ORM config in `ormconfig.json`
- Path aliases: `@/*` maps to `src/*` (tsconfig), `src/*` also used directly

---

*Architecture analysis: 2026-01-28*
