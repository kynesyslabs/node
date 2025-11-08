# Demos Network Node Software - Codebase Structure

## Root Directory Structure
```
/
├── src/                    # Main source code
├── documentation/          # Project documentation
├── postgres/              # Database scripts and configs
├── sdk/                   # SDK-related files
├── ssl/                   # SSL certificates
├── data/                  # Runtime data storage
├── REPO_ANALYSIS/         # Repository analysis files
├── .serena/               # Serena MCP configuration
├── .claude/               # Claude AI configuration
└── .trunk/                # Trunk.io tooling
```

## Source Code Structure (`src/`)
```
src/
├── index.ts               # Main application entry point
├── benchmark.ts           # Performance benchmarking
├── features/              # Feature-based modules
│   ├── multichain/        # Cross-chain functionality (XM)
│   ├── bridges/           # Bridge implementations
│   ├── contracts/         # Smart contract interactions
│   ├── zk/               # Zero-knowledge proofs
│   ├── fhe/              # Fully homomorphic encryption
│   ├── postQuantumCryptography/  # Post-quantum crypto
│   ├── logicexecution/    # Logic execution engine
│   ├── incentive/         # Incentive mechanisms
│   ├── web2/             # Web2 integrations
│   ├── mcp/              # MCP (Model Context Protocol)
│   ├── activitypub/      # ActivityPub protocol
│   ├── pgp/              # PGP encryption
│   └── InstantMessagingProtocol/  # Messaging features
├── libs/                 # Core libraries
│   ├── network/          # Network layer (RPC, P2P)
│   ├── blockchain/       # Blockchain operations
│   ├── peer/             # Peer management
│   └── utils/            # Utility functions
├── model/                # Database models (TypeORM)
├── client/               # Client-side code
├── utilities/            # Shared utilities
├── types/                # TypeScript type definitions
├── exceptions/           # Error handling
├── migrations/           # Database migrations
├── tests/                # Test files
└── ssl/                  # SSL certificates
```

## Key Architecture Patterns

### Feature-Based Organization
- Each major feature has its own directory under `src/features/`
- Features are self-contained with their own models, services, and utilities
- Cross-feature communication through well-defined interfaces

### Core Library Structure
- `libs/network/`: RPC server, API endpoints, networking protocols
- `libs/blockchain/`: Genesis block management, chain operations
- `libs/peer/`: P2P networking, peer discovery, connection management
- `libs/utils/`: Shared utilities like time calibration, cryptographic operations

### Database Layer
- TypeORM-based models in `src/model/`
- Migration files in `src/migrations/`
- Connection configuration in `src/model/datasource.ts`

### Configuration Files
- `package.json`: Dependencies and scripts
- `tsconfig.json`: TypeScript configuration
- `.eslintrc.cjs`: ESLint rules and naming conventions
- `.prettierrc`: Code formatting rules
- `ormconfig.json`: Database ORM configuration
- `.env.example`: Environment variable template

## Entry Points
- **Main Application**: `src/index.ts`
- **Key Generation**: `src/libs/utils/keyMaker.ts`
- **Backup/Restore**: `src/utilities/backupAndRestore.ts`

## Important Directories
- **Runtime Data**: `data/` (chain.db, logs)
- **Identity Files**: `.demos_identity`, `public.key`
- **Peer Configuration**: `demos_peerlist.json`
- **Environment**: `.env` file
