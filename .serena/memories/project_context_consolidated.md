# Demos Network Node - Complete Project Context

## Project Overview
**Repository**: Demos Network RPC Node Implementation  
**Version**: 0.9.5 (early development)
**Branch**: `tg_identities_v2`
**Runtime**: Bun (preferred), TypeScript (ESNext)
**Working Directory**: `/Users/tcsenpai/kynesys/node`

## Architecture & Key Components
```
src/
├── features/          # Feature modules (multichain, incentives)
├── libs/              # Core libraries
│   ├── blockchain/    # Chain, consensus (PoRBFTv2), GCR (v2)
│   ├── peer/         # Peer networking
│   └── network/      # RPC server, GCR routines
├── model/            # TypeORM entities & database config  
├── utilities/        # Utility functions
├── types/           # TypeScript definitions
└── tests/           # Test files
```

## Essential Development Commands
```bash
# Code Quality (REQUIRED after changes)
bun run lint:fix      # ESLint validation + auto-fix
bun tsc --noEmit      # Type checking (MANDATORY)
bun format            # Code formatting

# Development  
bun dev               # Development mode with auto-reload
bun start:bun         # Production start

# Testing
bun test:chains       # Jest tests for chain functionality
```

## Critical Development Rules
- **NEVER start the node directly** during development or testing
- **Use `bun run lint:fix`** for error checking (not node startup)
- **Always run type checking** before marking tasks complete
- **ESLint validation** is the primary method for checking code correctness
- **Use `@/` imports** instead of relative paths
- **Add JSDoc documentation** for new functions
- **Add `// REVIEW:` comments** for new features

## Code Standards
- **Naming**: camelCase (variables/functions), PascalCase (classes/interfaces) 
- **Style**: Double quotes, no semicolons, trailing commas
- **Imports**: Use `@/` aliases (not `../../../`)
- **Comments**: JSDoc for functions, `// REVIEW:` for new features
- **ESLint**: Supports both camelCase and UPPER_CASE variables

## Task Completion Checklist
**Before marking any task complete**:
1. ✅ Run type checking (`bun tsc --noEmit`) 
2. ✅ Run linting (`bun lint:fix`)
3. ✅ Add `// REVIEW:` comments on new code
4. ✅ Use `@/` imports instead of relative paths
5. ✅ Add JSDoc for new functions

## Technology Notes
- **GCR**: Always refers to GCRv2 unless specified otherwise
- **Consensus**: Always refers to PoRBFTv2 unless specified otherwise  
- **XM/Crosschain**: Multichain capabilities in `src/features/multichain`
- **SDK**: `@kynesyslabs/demosdk` package (current version 2.4.7)
- **Database**: PostgreSQL + SQLite3 with TypeORM
- **Framework**: Fastify with Socket.io

## Testing & Quality Assurance
- **Node Startup**: Only in production or controlled environments
- **Development Testing**: Use ESLint validation for code correctness
- **Resource Efficiency**: ESLint prevents unnecessary node startup overhead
- **Environment Stability**: Maintains clean development environment