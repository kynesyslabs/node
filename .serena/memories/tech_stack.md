# Demos Network Node Software - Technology Stack

## Core Technologies
- **Runtime**: Bun (preferred over npm/yarn) with Node.js 20.x+ compatibility
- **Language**: TypeScript with ES modules
- **Module System**: ESNext with bundler resolution
- **Package Manager**: Bun (primary), with npm fallback

## Database & ORM
- **Database**: PostgreSQL (port 5332 by default)
- **ORM**: TypeORM with decorators and migrations
- **Connection**: Custom datasource configuration in `src/model/datasource.ts`

## Web Framework & APIs
- **Primary Framework**: Fastify with CORS support
- **API Documentation**: Swagger/OpenAPI integration
- **Alternative**: Express.js (legacy support)
- **WebSocket**: Socket.io for real-time communication

## Key Dependencies
### Core Network & Blockchain
- `@kynesyslabs/demosdk`: ^2.3.22 (Demos Network SDK)
- `@cosmjs/encoding`: Cosmos blockchain integration
- `web3`: ^4.16.0 (Ethereum integration)
- `rubic-sdk`: ^5.57.4 (Cross-chain bridge integration)

### Cryptography & Security
- `node-forge`: ^1.3.1 (Cryptographic operations)
- `openpgp`: ^5.11.0 (PGP encryption)
- `superdilithium`: ^2.0.6 (Post-quantum cryptography)
- `node-seal`: ^5.1.3 (Homomorphic encryption)
- `rijndael-js`: ^2.0.0 (AES encryption)

### Development Tools
- **TypeScript**: ^5.8.3
- **ESLint**: ^8.57.1 with @typescript-eslint
- **Prettier**: ^2.8.0
- **Jest**: ^29.7.0 (Testing framework)
- **tsx**: ^3.12.8 (TypeScript execution)

## Infrastructure
- **Containerization**: Docker with docker-compose
- **Networking**: Custom P2P networking implementation
- **Time Synchronization**: NTP client integration
- **Terminal Interface**: terminal-kit for CLI interactions

## Path Resolution
- **Base URL**: `./` (project root)
- **Path Aliases**: `@/*` maps to `src/*`
- **Module Resolution**: Bundler-style with tsconfig-paths