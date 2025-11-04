# Demos Network Node - Core Project Context

## Project Identity
**Repository**: Demos Network RPC Node Implementation  
**Version**: 0.9.5 (early development)  
**License**: CC BY-NC-ND 4.0 by KyneSys Labs  
**Runtime**: Bun (preferred), Node.js 20.x+ compatible  
**Languages**: TypeScript (ESNext with ES modules)

## Architecture Overview

### Repository Structure
```
/
├── src/                    # Main source code
│   ├── features/          # Feature modules (multichain, bridges, zk, fhe, etc.)
│   ├── libs/              # Core libraries
│   │   ├── blockchain/    # Chain, consensus (PoRBFTv2), GCR (v2)
│   │   ├── peer/         # P2P networking
│   │   └── network/      # RPC server, GCR routines
│   ├── model/            # TypeORM entities & database config
│   ├── utilities/        # Shared utilities
│   └── types/           # TypeScript definitions
├── documentation/        # Project documentation
├── postgres/            # Database scripts
├── .serena/            # Serena MCP configuration
└── sdk/                # SDK-related files
```

### Key Components
- **Demos Network RPC**: Core network infrastructure and node functionality
- **Demos Network SDK**: `@kynesyslabs/demosdk` package (current: 2.4.20+)
- **Multi-chain (XM/Crosschain)**: Cross-chain capabilities in `src/features/multichain`
- **Database**: PostgreSQL + TypeORM (port 5332 default)
- **API Framework**: Fastify with CORS, Swagger/OpenAPI
- **P2P Networking**: Custom peer discovery and management

## Technology Stack

### Core Technologies
- **Runtime**: Bun (primary), Node.js 20.x+ (fallback)
- **Language**: TypeScript 5.8.3+ with ES modules
- **Package Manager**: Bun (preferred over npm/yarn)
- **Module Resolution**: Bundler-style with `@/*` path aliases

### Database & ORM
- **Database**: PostgreSQL (port 5332)
- **ORM**: TypeORM with decorators and migrations
- **Connection**: `src/model/datasource.ts`

### Key Dependencies
- `@kynesyslabs/demosdk`: ^2.3.22 (Demos Network SDK)
- `@cosmjs/encoding`: Cosmos blockchain integration
- `web3`: ^4.16.0 (Ethereum integration)
- `rubic-sdk`: ^5.57.4 (Cross-chain bridges)
- `superdilithium`: ^2.0.6 (Post-quantum cryptography)
- `node-seal`: ^5.1.3 (Homomorphic encryption)

### Development Tools
- **TypeScript**: ^5.8.3
- **ESLint**: ^8.57.1 with @typescript-eslint
- **Prettier**: ^2.8.0
- **Jest**: ^29.7.0
- **tsx**: ^3.12.8

## Critical Naming Conventions

### Demos Network Terminology
- **XM/Crosschain**: Multichain capabilities (interchangeable terms)
- **GCR**: Always refers to GCRv2 methods unless specified
- **Consensus**: Always refers to PoRBFTv2 when present
- **SDK/demosdk**: Refers to `@kynesyslabs/demosdk` package

### File Naming
- **Feature-based organization**: Code in `src/features/` by domain
- **Utilities**: Shared code in `src/utilities/` and `src/libs/`
- **Types**: Centralized in `src/types/`
- **Tests**: In `src/tests/` or co-located with source

### Path Resolution
- **Base URL**: `./` (project root)
- **Path Aliases**: `@/*` maps to `src/*` (ALWAYS use instead of relative imports)
- **Module Resolution**: Bundler-style with tsconfig-paths

## Development Context
- **Target Environment**: Early development stage (not production-ready)
- **Platform Support**: Linux, macOS, WSL2 on Windows
- **Focus Areas**: Maintainability, type safety, comprehensive error handling
- **Testing Strategy**: ESLint validation (never start node directly during development)
