# Tech Stack

## Core Technologies
- **Runtime**: Bun (primary), Node.js 20.x+ (supported)
- **Language**: TypeScript (ESNext target)
- **Module System**: ESNext modules with bundler resolution
- **Package Manager**: Bun (required for package management)

## Key Dependencies

### Blockchain & Crypto
- **@kynesyslabs/demosdk**: ^2.2.71 - Demos Network SDK (core integration)
- **web3**: ^4.16.0 - Ethereum compatibility
- **@cosmjs/encoding**: ^0.33.1 - Cosmos ecosystem support
- **superdilithium**: ^2.0.6 - Post-quantum cryptography
- **node-seal**: ^5.1.3 - Fully Homomorphic Encryption (FHE)
- **openpgp**: ^5.11.0 - PGP encryption
- **node-forge**: ^1.3.1 - Additional cryptography

### Database & ORM
- **typeorm**: ^0.3.17 - Database ORM
- **pg**: ^8.12.0 - PostgreSQL driver
- **sqlite3**: ^5.1.6 - SQLite support
- **reflect-metadata**: Required for TypeORM decorators

### Server & API
- **fastify**: ^4.28.1 - HTTP server framework
- **@fastify/cors**: ^9.0.1 - CORS support
- **@fastify/swagger**: ^8.15.0 - API documentation
- **express**: ^4.19.2 - Alternative HTTP framework
- **socket.io**: ^4.7.1 - WebSocket support

### Development Tools
- **TypeScript**: ^5.8.3
- **ESLint**: ^8.57.1 with TypeScript plugin
- **Prettier**: ^2.8.0
- **Jest**: ^29.7.0 - Testing framework
- **ts-node-dev**: ^2.0.0 - Development server

## Infrastructure
- **Docker & Docker Compose**: Required for PostgreSQL database
- **PostgreSQL**: Database backend (runs on port 5332 by default)
- **Port Requirements**: 
  - 5332: PostgreSQL
  - 53550: Node software default port

## Build Configuration
- **Target**: ESNext
- **Module**: ESNext with bundler resolution
- **Source Maps**: Enabled with inline sources
- **Path Aliases**: @/* maps to src/*
- **Decorators**: Experimental decorators enabled (required for TypeORM)
