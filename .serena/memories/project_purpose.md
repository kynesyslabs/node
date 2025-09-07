# Demos Network Node Software Project

## Purpose
This repository contains the official implementation of the Demos Network RPC software - a blockchain node implementation for the Demos Network. The software serves as:

- **Network Node**: Core infrastructure component for the Demos Network blockchain
- **RPC Server**: Provides API endpoints for blockchain operations
- **SDK Integration**: Full implementation and usage of @kynesyslabs/demosdk
- **Multi-feature Platform**: Supports various blockchain features including:
  - Multichain/Cross-chain capabilities (XM)
  - Zero-knowledge proofs (ZK)
  - Fully Homomorphic Encryption (FHE)
  - Smart contracts
  - Post-quantum cryptography
  - Bridges
  - Incentive mechanisms
  - Activity pub integration
  - PGP encryption

## Current Status
- Version: 0.9.5
- Status: Early development stage - NOT production ready
- Missing features essential for production use
- Requires careful handling and testing

## Key Components
- **Core Libraries**: Consensus (PoRBFTv2), blockchain, networking, cryptography
- **Features**: Modular feature implementation in src/features/
- **SDK**: Built-in integration with @kynesyslabs/demosdk package
- **Database**: PostgreSQL with TypeORM for data persistence
- **Testing**: Jest-based test framework