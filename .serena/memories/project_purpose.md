# Demos Network Node Software - Project Purpose

## Overview
This is the official implementation of Demos Network RPC (node) software. The repository contains the core network infrastructure components for running a Demos Network node.

## Key Responsibilities
- **Network Node**: Core RPC server for Demos Network blockchain operations
- **SDK Integration**: Full integration with @kynesyslabs/demosdk package for blockchain interactions
- **Multi-chain Support**: Cross-chain (XM) capabilities for multichain operations
- **Feature-Rich**: Includes multiple protocol implementations (ActivityPub, FHE, ZK, PQC, Bridges, etc.)

## Core Components
- **Node Software**: Main RPC server handling network communications
- **Database Layer**: PostgreSQL-based persistence using TypeORM
- **Protocol Features**: Various blockchain protocols and features in src/features/
- **SDK**: Demos Network SDK implementation (@kynesyslabs/demosdk)

## Important Notes
- This is the node/RPC codebase, not just a client application
- Currently in early development stage, not production-ready
- Uses Bun runtime for cross-platform compatibility (Linux, macOS, WSL2)
- Supports both local testing and network participation

## Related Repositories
- SDK sources located at ../sdks/ (separate repository)
- Multiple additional repos: faucet, identity verification, key server, etc.
