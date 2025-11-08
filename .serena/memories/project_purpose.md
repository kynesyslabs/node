# Demos Network Node Software - Project Purpose

## Overview
The Demos Network Node Software is the official RPC implementation for the Demos Network. This repository contains the core network infrastructure components that allow machines to participate in the Demos Network as nodes.

## Key Components
- **Demos Network RPC**: Core network infrastructure and node functionality
- **Demos Network SDK**: Full SDK implementation (`@kynesyslabs/demosdk` package)
- **Multi-chain capabilities**: Cross-chain functionality referred to as "XM" or "Crosschain"
- **Various features**: Including bridges, FHE, ZK, post-quantum cryptography, incentives, and more

## Target Environment
- Early development stage (not production-ready)
- Designed for Linux, macOS, and WSL2 on Windows
- Uses TypeScript with modern ES modules
- Requires Node.js 20.x+, Bun, and Docker

## Architecture
- Modular feature-based architecture in `src/features/`
- Database integration with TypeORM and PostgreSQL
- RESTful API endpoints via Fastify
- Peer-to-peer networking capabilities
- Identity management with cryptographic keys

## Development Context
- Licensed under CC BY-NC-ND 4.0 by KyneSys Labs
- Private repository (not for public distribution)
- Active development with frequent updates
- Focus on maintainability, type safety, and comprehensive error handling
