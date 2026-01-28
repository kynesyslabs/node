# Technology Stack

**Analysis Date:** 2026-01-28

## Languages

**Primary:**
- TypeScript ^5.9.3 - All source code (`src/`)

**Secondary:**
- None detected - Pure TypeScript codebase

## Runtime

**Environment:**
- Bun (primary runtime, used for server via `Bun.serve()`)
- Node.js (fallback via `tsx` for `start` scripts)
- ESM modules (`"type": "module"` in `package.json`)

**Package Manager:**
- Bun (preferred per project conventions)
- Lockfile: `bun.lockb` expected (Bun binary lockfile)

## Frameworks

**Core:**
- Custom `BunServer` class (`src/libs/network/bunServer.ts`) - Primary HTTP server built on Bun's native `Server`
- Express ^4.19.2 - Used for MCP server SSE transport (`src/features/mcp/MCPServer.ts`)
- Fastify ^4.28.1 - Available but secondary (with `@fastify/cors`, `@fastify/swagger`, `@fastify/swagger-ui`)
- Socket.IO ^4.7.1 / socket.io-client ^4.7.2 - P2P peer communication (`src/client/libs/`, `src/libs/peer/`)

**Testing:**
- Jest ^29.7.0 - Test runner
- ts-jest ^29.3.2 - TypeScript Jest transformer
- Test command: `bun run test:chains` (matches `tests/**/*.ts`)

**Build/Dev:**
- tsx ^3.12.8 - TypeScript execution (start scripts)
- ts-node ^10.9.1 / ts-node-dev ^2.0.0 - Dev mode
- tsconfig-paths ^4.2.0 - Path alias resolution at runtime
- ESLint ^8.57.1 + @typescript-eslint - Linting
- Prettier ^2.8.0 - Formatting
- Knip ^5.74.0 - Dead code detection

## Key Dependencies

**Critical:**
- `@kynesyslabs/demosdk` ^2.8.16 - Demos Network SDK (types, encryption, bridge, abstraction modules). Used pervasively across the codebase for types (`RPCRequest`, `RPCResponse`, `Transaction`, `Bundle`), encryption (`ucrypto`, `hexToUint8Array`, `uint8ArrayToHex`), and bridge functionality.
- TypeORM ^0.3.17 - Database ORM for PostgreSQL (`src/model/datasource.ts`)
- `pg` ^8.12.0 - PostgreSQL driver

**Blockchain Integrations:**
- `ethers` ^6.16.0 - EVM chain interactions, ENS resolution (`src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`)
- `web3` ^4.16.0 - Used in bridge/Rubic integration (`src/features/bridges/rubic.ts`)
- `@solana/web3.js` ^1.98.4 - Solana interactions (`src/libs/blockchain/gcr/gcr_routines/udSolanaResolverHelper.ts`, `src/features/bridges/rubic.ts`)
- `@coral-xyz/anchor` ^0.32.1 - Solana Anchor framework for program interactions
- `@aptos-labs/ts-sdk` ^5.2.0 - Aptos chain interactions (`src/features/multichain/chainwares/aptoswares/`, `src/features/multichain/routines/executors/`)
- `rubic-sdk` ^5.57.4 - Cross-chain bridge aggregation (`src/features/bridges/`)

**Cryptography:**
- `node-forge` ^1.3.3 - RSA, PKI operations, TLS (`src/libs/crypto/`, `src/libs/communications/`)
- `@noble/ed25519` ^3.0.0 - Ed25519 signatures
- `@noble/hashes` ^2.0.1 - Hashing primitives
- `tweetnacl` ^1.0.3 - NaCl cryptography
- `superdilithium` ^2.0.6 - Post-quantum signatures (listed as dependency)
- `rijndael-js` ^2.0.0 - AES encryption
- `@scure/bip39` ^2.0.1 / `bip39` ^3.1.0 - Mnemonic phrase generation
- `bs58` ^6.0.0 - Base58 encoding
- `@cosmjs/encoding` ^0.33.1 - Cosmos-compatible encoding

**Privacy/Advanced Crypto:**
- `node-seal` ^5.1.3 - Fully Homomorphic Encryption (SEAL library) (`src/features/fhe/FHE.ts`)

**Infrastructure:**
- `@modelcontextprotocol/sdk` ^1.13.3 - MCP server for AI agent integration (`src/features/mcp/`)
- `prom-client` ^15.1.3 - Prometheus metrics client (`src/features/metrics/`)
- `axios` ^1.6.5 - HTTP client (used in 9+ files for external API calls)
- `dotenv` ^16.4.5 - Environment configuration
- `ntp-client` ^0.5.3 - Network time synchronization (`src/libs/utils/calibrateTime.ts`)
- `helmet` ^8.1.0 - HTTP security headers (MCP server)
- `http-proxy` ^1.18.1 - HTTP proxying
- `zod` ^3.25.67 - Schema validation (MCP tool input schemas)

**Utility:**
- `lodash` ^4.17.21 - General utilities
- `terminal-kit` ^3.1.1 - TUI (Terminal UI) rendering
- `cli-progress` ^3.12.0 - CLI progress bars
- `crc` ^4.3.2 - CRC checksums
- `seedrandom` ^3.0.5 / `alea` ^1.0.1 - Deterministic random number generation
- `object-sizeof` ^2.6.3 - Object size calculation
- `node-disk-info` ^1.3.0 - Disk diagnostics
- `big-integer` ^1.6.52 - Arbitrary precision integers
- `reflect-metadata` ^0.1.13 - TypeORM decorator support

**Identity/Web3:**
- `@unstoppabledomains/resolution` ^9.3.3 - Unstoppable Domains resolution
- `@octokit/core` ^6.1.5 - GitHub API client (`src/libs/abstraction/web2/github.ts`)
- `@metaplex-foundation/js` ^0.20.1 - Solana NFT/Metaplex

## Configuration

**Environment:**
- `.env` file loaded via `dotenv` at startup (`src/index.ts`)
- `.env.example` provides template with all available vars
- Key env categories:
  - **Database**: `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`
  - **Network**: `RPC_PORT`, `SERVER_PORT`, `EXPOSED_URL`, `SIGNALING_SERVER_PORT`
  - **Features**: `OMNI_ENABLED`, `MCP_ENABLED`, `METRICS_ENABLED`, `TLSNOTARY_ENABLED`
  - **Identity**: `TWITTER_USERNAME/PASSWORD/EMAIL`, `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`
  - **Tuning**: `SHARD_SIZE`, `MAIN_LOOP_SLEEP_TIME`, `CONSENSUS_TIME`, `MAX_MESSAGE_SIZE`

**TypeScript:**
- Config: `tsconfig.json`
- Target: ESNext
- Module: ESNext with bundler resolution
- Path alias: `@/*` maps to `src/*`
- Decorators enabled (for TypeORM entities)
- `strictNullChecks: false`, `noImplicitAny: false` (relaxed strict mode)

**Build:**
- No separate build step for production; runs directly via `tsx` or `bun`
- Type checking: `bun run type-check` (uses `bun build --no-emit`) or `bun run type-check-ts` (uses `tsc --noEmit`)

**Linting:**
- `.eslintrc.cjs` - ESLint config with TypeScript plugin
- Double quotes, no semicolons
- Naming conventions enforced: camelCase for variables/functions, PascalCase for types/classes
- `no-console: warn` in src/ (exceptions for CLI tools, tests, entry point)

**Formatting:**
- `.prettierrc` - 4-space indent, double quotes, no semicolons, trailing commas, LF line endings, 80-char width

## Platform Requirements

**Development:**
- Bun runtime (cross-platform: Linux, macOS, Windows/WSL2)
- PostgreSQL database (default port 5332, configurable)
- Node.js types available for compatibility

**Production:**
- Bun runtime
- PostgreSQL instance
- Network ports: RPC (default 53550), Signaling (3005), MCP (3001), Metrics (9090), OmniProtocol (RPC+1), TLSNotary (7047)
- Optional TLS certificates for OmniProtocol

---

*Stack analysis: 2026-01-28*
