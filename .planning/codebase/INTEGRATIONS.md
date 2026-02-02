# External Integrations

**Analysis Date:** 2026-01-28

## APIs & External Services

**Web2 Identity Verification:**
- Twitter/X - Social identity verification
  - SDK/Client: `axios` + custom implementation
  - Auth: `TWITTER_USERNAME`, `TWITTER_PASSWORD`, `TWITTER_EMAIL`
  - Files: `src/libs/identity/tools/twitter.ts`, `src/libs/abstraction/web2/twitter.ts`

- Discord - Social identity verification
  - SDK/Client: `axios` + custom implementation
  - Auth: `DISCORD_API_URL`, `DISCORD_BOT_TOKEN`
  - Files: `src/libs/identity/tools/discord.ts`, `src/libs/abstraction/web2/discord.ts`

- GitHub - Social identity verification & attestation
  - SDK/Client: `@octokit/core` (Octokit)
  - Auth: `GITHUB_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
  - Files: `src/libs/identity/tools/github.ts` (axios), `src/libs/abstraction/web2/github.ts` (Octokit)

- Nomis - Cross-chain reputation scoring
  - SDK/Client: `axios`
  - Files: `src/libs/identity/tools/nomis.ts`

**Domain Name Resolution:**
- Unstoppable Domains - Web3 domain resolution
  - SDK/Client: `@unstoppabledomains/resolution` (listed in deps), `ethers` (ENS-style resolution)
  - Files: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`, `src/libs/blockchain/gcr/gcr_routines/udSolanaResolverHelper.ts`

**Cross-Chain Bridge Aggregation:**
- Rubic SDK - DEX/bridge aggregation
  - SDK/Client: `rubic-sdk` ^5.57.4
  - Files: `src/features/bridges/rubic.ts`, `src/features/bridges/bridgeUtils.ts`, `src/libs/network/manageBridge.ts`

## Blockchain Networks

**EVM Chains:**
- Ethereum / EVM-compatible chains
  - SDK/Client: `ethers` v6 (^6.16.0)
  - Usage: ENS/UD resolution, identity management, bridge operations
  - Files: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`, `src/features/multichain/chainwares/evmwares/`

- Web3.js integration for Rubic bridge
  - SDK/Client: `web3` ^4.16.0
  - Files: `src/features/bridges/rubic.ts`

**Solana:**
- Solana blockchain
  - SDK/Client: `@solana/web3.js` ^1.98.4
  - Anchor: `@coral-xyz/anchor` ^0.32.1 (for program interactions)
  - Metaplex: `@metaplex-foundation/js` ^0.20.1 (NFT operations)
  - Usage: UD resolution, bridge operations, cross-chain execution
  - Files: `src/libs/blockchain/gcr/gcr_routines/udSolanaResolverHelper.ts`, `src/features/bridges/rubic.ts`

**Aptos:**
- Aptos blockchain
  - SDK/Client: `@aptos-labs/ts-sdk` ^5.2.0
  - Usage: Cross-chain payments, contract read/write, balance queries
  - Files: `src/features/multichain/chainwares/aptoswares/`, `src/features/multichain/routines/executors/aptos_*.ts`

## Demos Network SDK (@kynesyslabs/demosdk)

**Package:** `@kynesyslabs/demosdk` ^2.8.16

**Submodule Imports Used:**
- `@kynesyslabs/demosdk/types` - Core type definitions (`RPCRequest`, `RPCResponse`, `Transaction`, `Bundle`, `BrowserRequest`, `SigningAlgorithm`, `ValidityData`, `Tweet`, `Web2GCRData`, etc.)
- `@kynesyslabs/demosdk/encryption` - Cryptographic utilities (`ucrypto`, `hexToUint8Array`, `uint8ArrayToHex`)
- `@kynesyslabs/demosdk/abstraction` - Web2 abstraction layer types (`Web2CoreTargetIdentityPayload`)
- `@kynesyslabs/demosdk` - Bridge module (`bridge`)

**Usage Scope:**
- Pervasive across the entire codebase (30+ import sites)
- Types used in: entities, network handlers, communications, blockchain operations
- Encryption used in: peer communication, identity, consensus
- SDK source available at `../sdks/` for reference when behavior is unclear

## Communication Protocols

**HTTP/REST RPC:**
- Custom `BunServer` class provides the primary RPC interface
  - Files: `src/libs/network/bunServer.ts`, `src/libs/network/server_rpc.ts`
  - Default port: 53550 (env: `SERVER_PORT` or `RPC_PORT`)
  - Handles all RPC methods: nodeCall, auth, consensus, GCR, bridges, execution
  - Rate limiting middleware: `src/libs/network/middleware/rateLimiter.ts`
  - Security module: `src/libs/network/securityModule.ts`
  - OpenAPI spec: `src/libs/network/openApiSpec.ts`, `src/libs/network/openapi-spec.json`

**WebSocket:**
- Socket.IO for P2P peer communication
  - Server: `socket.io` ^4.7.1
  - Client: `socket.io-client` ^4.7.2
  - Files: `src/client/libs/client_class.ts`, `src/client/libs/network.ts`, `src/libs/peer/`
  - Used for peer discovery, message routing, real-time communication

- WebSocket Signaling Server (Instant Messaging Protocol)
  - Files: `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts`
  - Default port: 3005 (env: `SIGNALING_SERVER_PORT`)
  - Features: peer registration, discovery, direct message routing, public key exchange

**OmniProtocol (Custom TCP Protocol):**
- Binary TCP protocol for high-performance node communication
  - Files: `src/libs/omniprotocol/` (auth, config, integration, protocol, ratelimit, serialization, server, tls, transport, types)
  - Default port: SERVER_PORT + 1 (env: `OMNI_PORT`)
  - Modes: `HTTP_ONLY`, `OMNI_PREFERRED`, `OMNI_ONLY`
  - TLS support: configurable via `OMNI_TLS_ENABLED`, supports self-signed and CA certs
  - Rate limiting built-in per IP and per identity
  - Integration bridge: `src/libs/omniprotocol/integration/peerAdapter.ts`

**MCP (Model Context Protocol):**
- AI agent integration server
  - Files: `src/features/mcp/MCPServer.ts`, `src/features/mcp/tools/`
  - SDK: `@modelcontextprotocol/sdk` ^1.13.3
  - Transports: stdio and SSE (Express-based SSE server)
  - Default port: 3001 (env: `MCP_SERVER_PORT`)
  - Toggleable: `MCP_ENABLED` env var

## Data Storage

**Databases:**
- PostgreSQL (primary persistent storage)
  - Connection: `PG_HOST`, `PG_PORT` (default 5332), `PG_USER` (default "demosuser"), `PG_PASSWORD`, `PG_DATABASE` (default "demos")
  - Client: TypeORM ^0.3.17 with `pg` ^8.12.0 driver
  - Config: `src/model/datasource.ts` (Singleton pattern)
  - Synchronize: `true` (auto-schema sync, intentional per project conventions)
  - Migrations: `src/migrations/` (TypeORM migrations via `typeorm-ts-node-esm`)
  - Entities:
    - `src/model/entities/Blocks.ts` - Block storage
    - `src/model/entities/Transactions.ts` - Transaction records
    - `src/model/entities/Mempool.ts` - Mempool transactions
    - `src/model/entities/Consensus.ts` - Consensus state
    - `src/model/entities/Validators.ts` - Validator registry
    - `src/model/entities/PgpKeyServer.ts` - PGP key storage
    - `src/model/entities/GCR/GlobalChangeRegistry.ts` - GCR v1
    - `src/model/entities/GCR/GCRTracker.ts` - GCR tracking
    - `src/model/entities/GCRv2/GCRHashes.ts` - GCR v2 hashes
    - `src/model/entities/GCRv2/GCRSubnetsTxs.ts` - GCR v2 subnet transactions
    - `src/model/entities/GCRv2/GCR_Main.ts` - GCR v2 main table
    - `src/model/entities/GCRv2/GCR_TLSNotary.ts` - GCR v2 TLS notary attestations

- SQLite (secondary, ActivityPub federation)
  - Files: `src/features/activitypub/fedistore.ts`
  - Package: `sqlite3` ^5.1.6
  - DB file: `src/features/activitypub/db.sqlite3`

**File Storage:**
- Local filesystem for identity files (`.demos_identity`)
- Local filesystem for peer lists (`demos_peerlist.json`)
- Local `data/` directory for chain data (`data/chain.db`)

**Caching:**
- None (no Redis/Memcached detected)
- In-memory state via `SharedState` singleton (`src/utilities/sharedState.ts`)

## Authentication & Identity

**Node Identity:**
- Ed25519 key pairs stored in `.demos_identity` file
- Key generation: `src/libs/utils/keyMaker.ts`
- Identity management: `src/libs/identity/identity.ts`
- Signing algorithms: Ed25519 (primary), with post-quantum Dilithium available (`superdilithium`)
- RSA support via `node-forge` (`src/libs/crypto/rsa.ts`)

**Peer Authentication:**
- Custom auth handshake between peers (`src/libs/network/manageAuth.ts`, `src/libs/network/manageHelloPeer.ts`)
- Public key exchange during peer discovery
- Signed object verification for RPC requests

**Web2 Identity Abstraction:**
- Twitter, Discord, GitHub verification
  - Files: `src/libs/abstraction/web2/` (twitter.ts, discord.ts, github.ts, parsers.ts)
  - Web2 proxy request handling: `src/libs/network/routines/transactions/handleWeb2ProxyRequest.ts`

**Browser Login:**
- Browser-based login flow: `src/libs/network/manageLogin.ts`

## Monitoring & Observability

**Prometheus Metrics:**
- Package: `prom-client` ^15.1.3
- Server: `src/features/metrics/MetricsServer.ts` (Bun HTTP server)
- Service: `src/features/metrics/MetricsService.ts`
- Collector: `src/features/metrics/MetricsCollector.ts`
- Custom collectors: `src/features/metrics/collectors/`
- Endpoint: `http://localhost:9090/metrics` (configurable via `METRICS_PORT`)
- Toggle: `METRICS_ENABLED` env var (default: true)

**TLSNotary HTTPS Attestation:**
- MPC-TLS attestation for verifiable HTTPS proofs
- Service: `src/features/tlsnotary/TLSNotaryService.ts`
- Proxy management: `src/features/tlsnotary/proxyManager.ts`
- Port allocation: `src/features/tlsnotary/portAllocator.ts`
- Token management: `src/features/tlsnotary/tokenManager.ts`
- Routes: `src/features/tlsnotary/routes.ts`
- Default port: 7047 (env: `TLSNOTARY_PORT`)
- Toggle: `TLSNOTARY_ENABLED` env var (default: false)

**Logging:**
- Custom TUI-integrated categorized logging system
  - Files: `src/utilities/logger.ts` (re-export), `src/utilities/tui/` (implementation)
  - Legacy adapter: `src/utilities/tui/LegacyLoggerAdapter.ts`
  - Categories: CORE, PEER, MAIN, etc. (auto-detected from tags)
  - File logging and TUI display

**Diagnostics:**
- System diagnostics: `src/utilities/Diagnostic.ts`
- Checks: CPU, RAM, disk space, network speed
- Configurable thresholds via env vars (`MIN_CPU_SPEED`, `MIN_RAM`, `MIN_DISK_SPACE`, etc.)

**NTP Time Synchronization:**
- Package: `ntp-client` ^0.5.3
- Files: `src/libs/utils/calibrateTime.ts`
- Used for network-wide timestamp consistency

## CI/CD & Deployment

**Hosting:**
- Self-hosted node software (not a SaaS deployment)

**CI Pipeline:**
- Not detected in repository (no `.github/workflows/` or similar CI configs visible)

**Scripts:**
- Start: `bun run start` (tsx) or `bun run start:bun` (native bun)
- Lint: `bun run lint` / `bun run lint:fix`
- Type check: `bun run type-check`
- Migrations: `bun run migration:run` / `bun run migration:revert`

## Environment Configuration

**Required env vars (for basic operation):**
- PostgreSQL: `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` (all have defaults)
- Network: `SERVER_PORT` or `RPC_PORT` (default 53550)

**Optional feature env vars:**
- `EXPOSED_URL` - Public-facing URL
- `MCP_ENABLED` / `MCP_SERVER_PORT` - AI agent MCP server
- `OMNI_ENABLED` / `OMNI_PORT` / `OMNI_MODE` - OmniProtocol TCP
- `OMNI_TLS_ENABLED` / `OMNI_CERT_PATH` / `OMNI_KEY_PATH` - TLS for OmniProtocol
- `METRICS_ENABLED` / `METRICS_PORT` - Prometheus metrics
- `TLSNOTARY_ENABLED` / `TLSNOTARY_PORT` / `TLSNOTARY_SIGNING_KEY` - TLS notary
- `SIGNALING_SERVER_PORT` - WebSocket signaling
- `PROD` - Production mode flag
- `SHARD_SIZE`, `MAIN_LOOP_SLEEP_TIME`, `CONSENSUS_TIME` - Tuning
- `SUDO_PUBKEY` - Admin public key
- `WHITELISTED_IPS` - Comma-separated IP whitelist

**Secrets/credentials:**
- `TWITTER_USERNAME`, `TWITTER_PASSWORD`, `TWITTER_EMAIL`
- `GITHUB_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`, `DISCORD_API_URL`
- `TLSNOTARY_SIGNING_KEY` (secp256k1 private key)

**Secrets location:**
- `.env` file (local, gitignored)
- `.env.example` provides template

## Webhooks & Callbacks

**Incoming:**
- RPC endpoint handles all inbound requests (`src/libs/network/server_rpc.ts`)
- Protected endpoints: `rate-limit/unblock`, `getCampaignData`, `awardPoints`

**Outgoing:**
- Peer-to-peer broadcasts via `src/libs/communications/broadcastManager.ts`
- HTTP/Socket.IO/OmniProtocol to peers
- Axios calls to external identity APIs (Twitter, Discord, GitHub, Nomis)
- Blockchain RPC calls to EVM, Solana, Aptos nodes

## Special Features

**Fully Homomorphic Encryption (FHE):**
- Library: `node-seal` ^5.1.3 (Microsoft SEAL)
- Files: `src/features/fhe/FHE.ts`

**Zero-Knowledge Proofs:**
- Directory: `src/features/zk/iZKP/`

**ActivityPub Federation:**
- Files: `src/features/activitypub/` (fediverse.ts, fedistore.ts, feditypes.ts)
- Local SQLite database for federation state

**Incentive/Points System:**
- Files: `src/features/incentive/PointSystem.ts`, `src/features/incentive/referrals.ts`

**Web2 Proxy:**
- Files: `src/features/web2/` (proxy/, dahr/, handleWeb2.ts, sanitizeWeb2Request.ts, validator.ts)

**Logic Execution:**
- Files: `src/features/logicexecution/` (planned/stub, contains TODO.md)

---

*Integration audit: 2026-01-28*
