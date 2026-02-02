# Codebase Structure

**Analysis Date:** 2026-01-28

## Directory Layout

```
node/
├── src/                    # All application source code
│   ├── index.ts            # Main entry point (node bootstrap + lifecycle)
│   ├── benchmark.ts        # Performance benchmarking utility
│   ├── client/             # SDK client utilities
│   ├── exceptions/         # Custom error types
│   ├── features/           # Optional/pluggable feature modules
│   ├── libs/               # Core library modules (blockchain, consensus, networking)
│   ├── migrations/         # TypeORM database migrations
│   ├── model/              # Database entities and datasource config
│   ├── ssl/                # SSL certificate utilities
│   ├── tests/              # Unit tests (inside src)
│   ├── types/              # Type declarations and augmentations
│   └── utilities/          # Cross-cutting utilities (logger, shared state, TUI)
├── tests/                  # Integration/chain tests
├── devnet/                 # Docker-based local devnet setup
├── data/                   # Runtime data (genesis config, chain DB)
├── fixtures/               # Test fixtures and sample data
├── monitoring/             # Monitoring configuration (Grafana, Prometheus)
├── scripts/                # Shell scripts (ceremony contribution)
├── architecture/           # Architecture documentation and diagrams
├── documentation/          # Project documentation
├── local_tests/            # Local testing scripts (46 files)
├── res/                    # Resources (genesis files, configs)
├── specs/                  # Protocol specifications
├── libs/                   # External/vendored libraries
├── tlsnotary/              # TLSNotary external tooling
├── .env                    # Environment configuration (not committed)
├── .env.example            # Environment template
├── package.json            # Dependencies and scripts
├── tsconfig.json           # TypeScript configuration
├── jest.config.ts          # Jest test configuration
├── ormconfig.json          # TypeORM database connection config
├── run                     # Main run script (bash, 34KB)
├── start_db                # Database startup script (bash)
├── reset-node              # Node reset script (bash)
├── node-doctor             # Diagnostic/health check script (bash)
├── install-deps.sh         # Dependency installation script
└── demos_peerlist.json     # Known peers configuration
```

## Directory Purposes

**`src/`:**
- Purpose: All application source code
- Contains: TypeScript files organized by domain
- Key files: `index.ts` (entry point, ~925 lines)

**`src/libs/`:**
- Purpose: Core domain libraries forming the backbone of the node
- Contains: 12 subdirectories, each a domain module
- Key subdirectories:
  - `blockchain/` - Chain, Block, Transaction, Mempool, GCR, sync routines
  - `consensus/v2/` - PoRBFTv2 consensus algorithm and routines
  - `network/` - RPC server, endpoint handlers, method managers, DTR, middleware
  - `peer/` - Peer model, PeerManager singleton, peer routines
  - `omniprotocol/` - Binary TCP protocol (server, transport, serialization, TLS, auth, rate limiting)
  - `communications/` - Broadcast manager for peer messaging
  - `crypto/` - Hashing, signing, encryption utilities
  - `identity/` - Node identity and social identity providers
  - `l2ps/` - Layer 2 parallel subnet support
  - `utils/` - Time calibration, key generation, stdlib helpers
  - `assets/` - FungibleToken.ts, NonFungibleToken.ts
  - `abstraction/` - Web2 platform abstractions (Discord, GitHub, Twitter)

**`src/features/`:**
- Purpose: Optional feature modules that extend the core node
- Contains: 13 feature directories, each self-contained
- Key features:
  - `mcp/` - Model Context Protocol server with tools
  - `tlsnotary/` - TLS attestation service (proxy, tokens, FFI)
  - `metrics/` - Prometheus metrics server and collectors
  - `multichain/` - Cross-chain dispatching (EVM, Aptos)
  - `web2/` - HTTP proxy/DAHR for web2 APIs
  - `bridges/` - Cross-chain bridge (Rubic SDK)
  - `InstantMessagingProtocol/` - WebSocket signaling server
  - `activitypub/` - Fediverse integration
  - `fhe/` - Fully Homomorphic Encryption
  - `zk/` - Zero-knowledge proofs (iZKP)
  - `incentive/` - Point system and referrals
  - `contracts/` - Smart contract support (phases doc only)
  - `logicexecution/` - Logic execution (TODO only)

**`src/model/`:**
- Purpose: Database schema (TypeORM entities) and datasource configuration
- Contains: `datasource.ts` (singleton PostgreSQL connection), `entities/` subdirectory
- Key entities:
  - `entities/Blocks.ts` - Block storage
  - `entities/Transactions.ts` - Transaction storage
  - `entities/Mempool.ts` - Pending transaction pool
  - `entities/Consensus.ts` - Consensus state
  - `entities/Validators.ts` - Validator registry
  - `entities/GCR/GlobalChangeRegistry.ts` - GCR v1
  - `entities/GCR/GCRTracker.ts` - GCR change tracking
  - `entities/GCRv2/GCR_Main.ts` - GCR v2 main table
  - `entities/GCRv2/GCRHashes.ts` - GCR hash tracking
  - `entities/GCRv2/GCRSubnetsTxs.ts` - Subnet transactions
  - `entities/GCRv2/GCR_TLSNotary.ts` - TLSNotary attestations
  - `entities/PgpKeyServer.ts` - PGP key storage

**`src/utilities/`:**
- Purpose: Cross-cutting utilities used by all layers
- Contains: Singleton services, helper functions, CLI tools
- Key files:
  - `sharedState.ts` - Global singleton state (most important file for understanding data flow)
  - `logger.ts` - Logging system
  - `mainLoop.ts` - Background consensus/peer management loop
  - `waiter.ts` - Timeout/abort-aware async waiting
  - `Diagnostic.ts` - System diagnostics (CPU, RAM, disk, network)
  - `tui/TUIManager.ts` - Terminal UI using terminal-kit
  - `tui/CategorizedLogger.ts` - Tag-based log categorization
  - `backupAndRestore.ts` - Chain backup/restore
  - `commandLine.ts` - CLI mode handler
  - `selfCheckPort.ts` - Port availability checking
  - `generateUniqueId.ts` - ID generation
  - `getPublicIP.ts` - Public IP detection
  - `evmInfo.ts` - EVM chain information

**`src/libs/network/`:**
- Purpose: All HTTP RPC server logic and request handling
- Contains: Server setup, auth, method routing, endpoint handlers
- Key files:
  - `server_rpc.ts` - Main RPC server (Bun HTTP, ~17KB)
  - `bunServer.ts` - Bun server wrapper with CORS and JSON helpers
  - `endpointHandlers.ts` - RPC method dispatch (~29KB, largest handler file)
  - `manageNodeCall.ts` - Public node query methods (~28KB)
  - `manageConsensusRoutines.ts` - Consensus-related RPC handlers (~17KB)
  - `manageGCRRoutines.ts` - GCR query/mutation handlers
  - `manageHelloPeer.ts` - Peer discovery handshake
  - `manageExecution.ts` - Transaction execution
  - `manageAuth.ts` - Authentication
  - `manageLogin.ts` - Login flow
  - `manageBridge.ts` - Bridge operations
  - `manageNativeBridge.ts` - Native bridge operations
  - `middleware/rateLimiter.ts` - Rate limiting middleware
  - `dtr/dtrmanager.ts` - Distributed Transaction Routing
  - `routines/` - Subroutines for specific operations
    - `nodecalls/` - Individual nodeCall handlers (getBlockByHash, getBlocks, getPeerlist, etc.)
    - `transactions/` - Transaction processing (identity, L2PS, native bridge, web2 proxy, demosWork)

**`src/libs/consensus/v2/`:**
- Purpose: PoRBFTv2 consensus implementation
- Key files:
  - `PoRBFT.ts` - Main consensus routine with secretary semaphore system
  - `interfaces.ts` - Consensus interfaces
  - `routines/createBlock.ts` - Block creation
  - `routines/mergeMempools.ts` - Mempool merging across shard
  - `routines/mergePeerlist.ts` - Peer list merging
  - `routines/getShard.ts` - Shard computation
  - `routines/isValidator.ts` - Validator eligibility check
  - `routines/getCommonValidatorSeed.ts` - Deterministic validator seed
  - `routines/broadcastBlockHash.ts` - Block hash dissemination
  - `routines/orderTransactions.ts` - Transaction ordering
  - `types/secretaryManager.ts` - Secretary coordination
  - `types/shardTypes.ts` - Shard type definitions

**`src/libs/blockchain/gcr/`:**
- Purpose: Global Change Registry - mutable account state
- Key files:
  - `gcr.ts` - Main GCR class (potentially deprecated, see GCRv2)
  - `handleGCR.ts` - GCR operation handling
  - `gcr_routines/applyGCROperation.ts` - Apply operations to GCR
  - `gcr_routines/txToGCROperation.ts` - Derive operations from transactions
  - `gcr_routines/GCRBalanceRoutines.ts` - Balance queries
  - `gcr_routines/GCRIdentityRoutines.ts` - Identity operations
  - `gcr_routines/GCRNonceRoutines.ts` - Nonce management
  - `gcr_routines/GCRTLSNotaryRoutines.ts` - TLSNotary attestation storage
  - `gcr_routines/IncentiveManager.ts` - Incentive/points logic
  - `gcr_routines/identityManager.ts` - Identity management
  - `gcr_routines/signatureDetector.ts` - Signature algorithm detection
  - `gcr_routines/assignXM.ts` - Cross-chain address assignment
  - `gcr_routines/assignWeb2.ts` - Web2 identity assignment

**`src/client/`:**
- Purpose: Client-side utilities for connecting to the node
- Key files:
  - `client.ts` - Client entry
  - `libs/client_class.ts` - Client class
  - `libs/network.ts` - Network utilities

**`src/exceptions/`:**
- Purpose: Custom exception types
- Key files: `index.ts` (exports TimeoutError, AbortError, BlockInvalidError, ForgingEndedError, NotInShardError)

**`devnet/`:**
- Purpose: Local development network setup
- Contains: Docker compose, peer lists, identity files, init scripts, run scripts
- Key files:
  - `docker-compose.yml` - Multi-node devnet
  - `Dockerfile` - Node container image
  - `run-devnet` - Devnet launcher script
  - `identities/` - Pre-generated node identities
  - `postgres-init/` - Database initialization

**`tests/`:**
- Purpose: Integration tests (chain-level)
- Contains: `mocks/`, `omniprotocol/`

**`monitoring/`:**
- Purpose: Monitoring stack configuration
- Contains: Grafana dashboards, Prometheus config

**`data/`:**
- Purpose: Runtime data directory
- Contains: Genesis configuration, chain database files

**`fixtures/`:**
- Purpose: Test fixtures and sample payloads

## Key File Locations

**Entry Points:**
- `src/index.ts`: Main node entry point (bootstrap, services, main loop)
- `src/libs/utils/keyMaker.ts`: Key generation CLI tool
- `src/libs/utils/showPubkey.ts`: Public key display tool
- `src/utilities/backupAndRestore.ts`: Backup/restore tool

**Configuration:**
- `.env` / `.env.example`: Environment variables
- `package.json`: Dependencies and scripts
- `tsconfig.json`: TypeScript config (paths: `@/*` -> `src/*`)
- `ormconfig.json`: TypeORM database config
- `.eslintrc.cjs`: ESLint rules
- `.prettierrc`: Prettier formatting
- `jest.config.ts`: Jest test config
- `demos_peerlist.json`: Known peer list
- `knip.json`: Dead code detection config

**Core Logic:**
- `src/utilities/sharedState.ts`: Global state singleton (~200 lines, critical)
- `src/libs/blockchain/chain.ts`: Chain operations (static class)
- `src/libs/consensus/v2/PoRBFT.ts`: Consensus algorithm
- `src/utilities/mainLoop.ts`: Background loop
- `src/libs/network/server_rpc.ts`: RPC server
- `src/libs/network/endpointHandlers.ts`: RPC method routing (~29KB)
- `src/libs/network/manageNodeCall.ts`: Public query handlers (~28KB)
- `src/model/datasource.ts`: Database connection

**Testing:**
- `tests/`: Integration tests
- `src/tests/`: Unit tests within source
- `local_tests/`: Local testing scripts (46 files)
- `fixtures/`: Test fixtures

**Scripts:**
- `run`: Main node run script (bash, 34KB - handles setup, DB, startup)
- `start_db`: PostgreSQL startup script
- `reset-node`: Node state reset script
- `node-doctor`: Node health diagnostics script
- `install-deps.sh`: Dependency installation
- `scripts/ceremony_contribute.sh`: ZK ceremony contribution

## Naming Conventions

**Files:**
- PascalCase for classes/components: `PeerManager.ts`, `TUIManager.ts`, `MetricsCollector.ts`
- camelCase for utilities/routines: `mainLoop.ts`, `sharedState.ts`, `calibrateTime.ts`
- camelCase for routine files: `peerBootstrap.ts`, `checkOfflinePeers.ts`, `mergeMempools.ts`
- `manage*.ts` prefix for RPC method handler groups: `manageAuth.ts`, `manageNodeCall.ts`
- `handle*.ts` prefix for specific request handlers: `handleGCR.ts`, `handleWeb2ProxyRequest.ts`

**Directories:**
- lowercase for feature modules: `multichain/`, `tlsnotary/`, `metrics/`
- PascalCase for protocol names: `InstantMessagingProtocol/`
- lowercase for library domains: `blockchain/`, `consensus/`, `peer/`, `crypto/`
- `routines/` subdirectory pattern for related operations within a domain

## Import Path Conventions

**Path Aliases:**
- `@/*` maps to `src/*` (defined in tsconfig.json)
- `src/*` also used as absolute imports (both styles coexist in codebase)
- SDK imports: `@kynesyslabs/demosdk/encryption`, `@kynesyslabs/demosdk/types`, `@kynesyslabs/demosdk`

**Import Examples:**
```typescript
// Path alias style (preferred for new code)
import log from "@/utilities/logger"
import { Waiter } from "@/utilities/waiter"

// Absolute src style (common in existing code)
import Chain from "src/libs/blockchain/chain"
import { getSharedState } from "src/utilities/sharedState"

// SDK imports
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { Operation } from "@kynesyslabs/demosdk/types"
```

## Where to Add New Code

**New Feature Module:**
- Create directory: `src/features/<feature-name>/`
- Add `index.ts` barrel export
- Dynamically import from `src/index.ts` with try-catch failsafe pattern
- Add env var toggle (e.g., `FEATURE_ENABLED`)
- Follow pattern from `src/features/metrics/` or `src/features/mcp/`

**New RPC Endpoint:**
- Add handler in `src/libs/network/endpointHandlers.ts` or create `manage<Feature>.ts`
- Import and wire in `server_rpc.ts`
- Add to `noAuthMethods` if public, or `PROTECTED_ENDPOINTS` if admin-only

**New NodeCall Method:**
- Add handler file in `src/libs/network/routines/nodecalls/`
- Register in `src/libs/network/manageNodeCall.ts`

**New Transaction Type:**
- Add handler in `src/libs/network/routines/transactions/`
- Register in `src/libs/network/manageExecution.ts`

**New Database Entity:**
- Create entity in `src/model/entities/`
- Register in `src/model/datasource.ts` entities array
- TypeORM `synchronize: true` auto-creates tables

**New Consensus Routine:**
- Add to `src/libs/consensus/v2/routines/`
- Wire into `src/libs/consensus/v2/PoRBFT.ts`

**New GCR Operation:**
- Add routine in `src/libs/blockchain/gcr/gcr_routines/`
- Register in `src/libs/blockchain/gcr/gcr_routines/applyGCROperation.ts`

**New Peer Routine:**
- Add to `src/libs/peer/routines/`

**New Utility:**
- Add to `src/utilities/` for cross-cutting concerns
- Add to `src/libs/utils/` for domain-specific helpers

**Tests:**
- Chain/integration tests: `tests/`
- Unit tests: `src/tests/`
- Follow Jest patterns with `*.test.ts` naming

## Special Directories

**`data/`:**
- Purpose: Runtime chain data and genesis configuration
- Generated: Partially (chain.db created at runtime)
- Committed: Only genesis config files

**`devnet/`:**
- Purpose: Local multi-node development environment
- Generated: No (manually configured)
- Committed: Yes

**`dist/`:**
- Purpose: Compiled output
- Generated: Yes (by build)
- Committed: No

**`node_modules/`:**
- Purpose: Dependencies
- Generated: Yes
- Committed: No

**`logs/` and `logs_*_demos_identity/`:**
- Purpose: Runtime log output
- Generated: Yes (at runtime)
- Committed: No

**`.planning/`:**
- Purpose: GSD planning documents
- Generated: By AI tooling
- Committed: Optional

**`.beads/`:**
- Purpose: Issue tracking (beads system)
- Generated: By beads CLI
- Committed: Yes (`issues.jsonl`)

**`.serena/`:**
- Purpose: Serena MCP project memory
- Generated: By Serena
- Committed: Partially

---

*Structure analysis: 2026-01-28*
