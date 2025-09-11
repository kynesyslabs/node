# Demos Network RPC Node - Project Overview

## Purpose & Status
**Primary**: Official Demos Network RPC node implementation (Version 0.9.5, early development)
**Current Goal**: Implement Telegram identity verification on `tg_identities_v2` branch

## Architecture & Key Components
- **Core**: RPC server for Demos Network with blockchain components
- **Consensus**: PoRBFTv2 (when referring to consensus)
- **GCR**: Global Change Registry v2 (when referring to GCR)
- **Multichain**: XM/Crosschain capabilities in `src/features/multichain`
- **SDK**: @kynesyslabs/demosdk package (source at ../sdks/)

## Directory Structure
```
src/
├── features/          # Feature modules (multichain, IMP)
├── libs/              # Core libraries (blockchain, peer, network)
│   ├── blockchain/    # Chain, consensus, GCR routines
│   ├── peer/         # Peer networking
│   └── network/      # RPC server
├── model/            # TypeORM entities & database config
├── utilities/        # Utility functions
├── types/           # TypeScript type definitions
└── tests/           # Test files
```

## Technology Stack
- **Runtime**: Bun (preferred), TypeScript (ESNext)
- **Database**: PostgreSQL + SQLite3 with TypeORM
- **Framework**: Fastify with Socket.io
- **Testing**: Jest with ts-jest
- **Blockchain**: Web3, various crypto libraries

## Development Environment
- **Platform**: Darwin (macOS)
- **Working Dir**: /Users/tcsenpai/kynesys/node
- **Branch**: tg_identities_v2
- **Related Repos**: ../sdks/, ../local_vault/