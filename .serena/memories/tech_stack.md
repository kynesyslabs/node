# Technology Stack

## Runtime & Language
- **Primary Runtime**: Bun (mandatory since v0.9.5)
- **Language**: TypeScript with ES modules
- **Node.js**: v20.x+ supported but Bun required for execution
- **Package Manager**: Bun (preferred over npm/yarn)

## Core Dependencies
- **@kynesyslabs/demosdk**: v2.3.20 - Core Demos Network SDK
- **TypeORM**: Database ORM with PostgreSQL
- **Fastify**: Web framework with Swagger API docs
- **Socket.io**: Real-time communication
- **Web3**: Blockchain interaction
- **Rubic SDK**: Cross-chain bridge integrations

## Development Tools
- **TypeScript**: v5.8.3 with strict mode
- **ESLint**: Code linting with @typescript-eslint
- **Prettier**: Code formatting
- **Jest**: Testing framework with ts-jest
- **tsx**: TypeScript execution for development

## Infrastructure
- **Database**: PostgreSQL via Docker Compose (port 5332)
- **Node Port**: 53550 (configurable)
- **Docker**: Required for database management
- **File System**: SQLite for chain data storage

## Build Configuration
- **Module System**: ES Modules (type: "module")
- **Target**: ESNext with bundler resolution
- **Path Aliases**: @/* maps to src/*
- **Decorators**: Enabled for TypeORM entities