# Codebase Structure

**Analysis Date:** 2026-02-22

## Top-level Layout (high signal)

```
.
├── src/                     # Node implementation (TypeScript)
├── tests/                   # Jest tests (integration-ish)
├── fixtures/                # JSON fixtures used by tests
├── devnet/                  # Local multi-node devnet (Docker)
├── monitoring/              # Prometheus + Grafana stack
├── docs/                    # Project documentation
├── documentation/           # Additional docs (legacy / generated)
├── specs/                   # Protocol specs
├── architecture/            # Architecture docs/diagrams
├── data/                    # Runtime data (may include chain dbs)
├── postgres/                # DB assets/scripts (local)
├── tlsnotary/               # TLSNotary tooling (external)
├── .planning/               # GSD planning + codebase maps
│   └── codebase/            # Codebase mapping docs (this folder)
├── package.json             # Dependencies + scripts (bun)
├── bun.lock                 # Bun lockfile
├── tsconfig.json            # TypeScript config + path aliases
├── jest.config.ts           # Jest config (ts-jest)
├── ormconfig.json           # TypeORM config (sqlite; legacy/tooling)
└── run                      # Main launcher script (bash)
```

## `src/` (primary code)

```
src/
├── index.ts                 # Main entrypoint (bootstrap, flags, services)
├── utilities/               # Cross-cutting utilities (logger, shared state, TUI, CLI)
├── libs/                    # Core subsystems (network, blockchain, consensus, peer, crypto, omniprotocol, ...)
├── model/                   # TypeORM entities + datasource config
├── migrations/              # TypeORM migrations
├── features/                # Optional feature modules (MCP, metrics, tlsnotary, multichain, zk, ...)
├── client/                  # Client utilities
├── exceptions/              # Custom errors
├── types/                   # Shared types / augmentations
└── tests/                   # Some tests co-located under src (not the main test suite)
```

## Key “start here” files

- Bootstrap / lifecycle: `src/index.ts`
- Main loop: `src/utilities/mainLoop.ts`
- Shared state: `src/utilities/sharedState`
- RPC server: `src/libs/network/server_rpc.ts`
- Consensus: `src/libs/consensus/v2/PoRBFT.ts`
- DB: `src/model/datasource.ts`, `src/model/entities/`

