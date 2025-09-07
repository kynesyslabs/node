# Demos Network Codebase Structure

## Root Directory Structure
```
/
├── src/                    # Main source code
├── tests/                  # Test files
├── postgres/               # Database configuration
├── documentation/          # Project documentation
├── ssl/                   # SSL certificates
├── data/                  # Runtime data (chain.db, etc.)
├── sdk/                   # SDK-related files
├── REPO_ANALYSIS/         # Analysis artifacts
└── logs/                  # Runtime logs
```

## Core Source Structure (src/)
```
src/
├── index.ts               # Main entry point
├── benchmark.ts           # Performance benchmarking
├── features/              # Modular feature implementations
│   ├── multichain/        # Cross-chain (XM) capabilities
│   ├── contracts/         # Smart contract features
│   ├── zk/               # Zero-knowledge proofs
│   ├── fhe/              # Fully Homomorphic Encryption
│   ├── bridges/          # Blockchain bridges
│   ├── postQuantumCryptography/  # Post-quantum crypto
│   ├── incentive/        # Incentive mechanisms
│   ├── pgp/              # PGP encryption
│   ├── activitypub/      # ActivityPub integration
│   ├── logicexecution/   # Logic execution engine
│   ├── InstantMessagingProtocol/  # Messaging
│   ├── mcp/              # MCP integration
│   └── web2/             # Web2 integrations
├── libs/                 # Core library implementations
│   ├── consensus/        # PoRBFTv2 consensus
│   ├── blockchain/       # Blockchain core
│   ├── network/          # Networking layer
│   ├── crypto/           # Cryptographic functions
│   ├── identity/         # Identity management
│   ├── peer/            # Peer-to-peer functionality
│   ├── communications/   # Communication protocols
│   ├── abstraction/     # Abstract layers
│   ├── utils/           # Utility functions
│   ├── assets/          # Asset management
│   └── l2ps/            # Layer 2 protocols
├── model/               # Database models (TypeORM)
├── client/              # Client implementations
├── utilities/           # Utility scripts
├── migrations/          # Database migrations
├── types/               # TypeScript type definitions
├── exceptions/          # Error handling
├── tests/               # Test implementations
└── ssl/                 # SSL handling
```

## Key Architectural Patterns
- **Modular Features**: Each feature in separate directory with independence
- **Layered Architecture**: libs/ contains core abstractions
- **Database Layer**: TypeORM entities in model/
- **Type Safety**: Comprehensive TypeScript definitions
- **Testing**: Feature-specific tests alongside implementation