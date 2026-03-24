# Project Index: demos-node-software

Generated: 2026-02-18T13:55:45Z

## 📁 Project Structure

- `src/` - Core node runtime, networking, blockchain, features (345 TS/JS source files)
- `tests/` - OmniProtocol and fixture-driven tests
- `scripts/` - Operational scripts (ZK setup, load tests, wallet/proof helpers)
- `docs/`, `documentation/`, `monitoring/` - User and operator docs
- `testing/devnet/` - Local 4-node Docker dev network
- `tlsnotary/`, `postgres/`, `monitoring/` - Infra/service compose stacks

## 🚀 Entry Points

- CLI/Node: `src/index.ts` - Main node bootstrap, runtime config, service startup
- Run script: `run` - Primary launcher used in README quick start
- RPC API: `src/libs/network/server_rpc.ts` - Bun/Fastify RPC surface
- OmniProtocol: `src/libs/omniprotocol/integration/startup.ts` - Omni server startup/shutdown
- Tests: `tests/omniprotocol/*.test.ts`, `src/features/zk/tests/*.test.ts`

## 📦 Core Modules

### Module: Node Runtime
- Path: `src/index.ts`
- Exports: executable bootstrap (process entry)
- Purpose: Initializes chain state, peers, RPC, metrics, OmniProtocol, TLSNotary, and loops

### Module: Network API
- Path: `src/libs/network/index.ts`
- Exports: `serverRpcBun`, `emptyResponse`
- Purpose: Node RPC interface and request handling plumbing

### Module: OmniProtocol SDK Surface
- Path: `src/libs/omniprotocol/index.ts`
- Exports: protocol opcodes/registry, serialization, auth/tls/ratelimit, integration types
- Purpose: Typed protocol and transport abstractions for peer-to-peer operations

### Module: Blockchain Core
- Path: `src/libs/blockchain/`
- Exports: chain, block, mempool, transaction and execution routines
- Purpose: Block production, validation, state transitions, and consensus helpers

### Module: Peer Layer
- Path: `src/libs/peer/`
- Exports: `Peer`, `PeerManager`, peer routines
- Purpose: Peer identity, peer discovery/bootstrap, gossip and broadcast workflows

### Module: L2PS / ZK
- Path: `src/libs/l2ps/`, `src/features/zk/`
- Exports: batch/proof managers, prover wrappers, Merkle and verification helpers
- Purpose: Zero-knowledge workflows and L2 processing

### Module: MCP Feature
- Path: `src/features/mcp/`
- Exports: MCP server + tools integration
- Purpose: Exposes Demos node capabilities through MCP-compatible tool interfaces

## 🔧 Configuration

- `package.json` - runtime scripts, dependencies, main entry (`src/index.ts`)
- `tsconfig.json` - TypeScript compiler configuration
- `ormconfig.json` - TypeORM/database settings
- `knip.json` - unused export/dependency analysis
- `monitoring/prometheus/prometheus.yml` - Prometheus scrape config
- `monitoring/grafana/provisioning/**/*.yml` - Grafana dashboard/datasource provisioning
- `testing/devnet/docker-compose.yml` - local multi-node devnet orchestration
- `tlsnotary/docker-compose.yml` - TLSNotary service stack

## 📚 Documentation

- `README.md` - project overview, quick start, operations
- `INSTALL.md` - installation and setup details
- `CONTRIBUTING.md` - contribution workflow
- `L2PS_TESTING.md` - L2PS test guidance
- `monitoring/README.md` - metrics/Grafana setup
- `testing/devnet/README.md` - local devnet lifecycle
- `OMNIPROTOCOL_SETUP.md` - OmniProtocol setup

## 🧪 Test Coverage

- Unit tests: 10 files (`**/*.test.ts`, `**/*.spec.ts`)
- Integration tests: 8 files (`tests/omniprotocol/*.test.ts`)
- Additional test-support files: 6 (`tests/mocks/*`)
- Coverage: Not reported in-repo (no committed coverage artifact)

## 🔗 Key Dependencies

- `bun` `^1.2.10` - primary runtime
- `typescript` `^5.9.3` - static typing/compiler
- `fastify` `^4.28.1` - API framework (with swagger plugins)
- `typeorm` `^0.3.17` + `pg` `^8.12.0` - persistence layer
- `@kynesyslabs/demosdk` `^2.10.2` - Demos SDK integration
- `@modelcontextprotocol/sdk` `^1.13.3` - MCP server/tooling
- `ethers` `^6.16.0` / `web3` `^4.16.0` / `@solana/web3.js` `^1.98.4` - multichain support
- `snarkjs` `^0.7.5` / `circomlib` `^2.0.5` - zk circuits and proving

## 📝 Quick Start

1. `bun install`
2. Configure `.env` + peerlist (`demos_peerlist.json`)
3. Start node: `./run` (or `bun run start:bun`)
4. Type-check: `bun run type-check`
5. Run tests: `bun run test:chains` (and `bun run zk:test` for ZK suite)
