# Project Current State - Demos Network Node

## Project Overview
**Repository**: Demos Network RPC Node Implementation  
**Version**: 0.9.5 (early development)
**Primary Goal**: Complete telegram identity verification system
**Current Branch**: `tg_identities_v2`

## Technical Environment
- **Platform**: Darwin (macOS)
- **Runtime**: Bun (preferred), TypeScript (ESNext)
- **Working Directory**: `/Users/tcsenpai/kynesys/node`
- **Related Repositories**: `../sdks/` (SDK source), `../local_vault/`
- **Database**: PostgreSQL + SQLite3 with TypeORM
- **Framework**: Fastify with Socket.io

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

## Development Standards & Workflow

### Essential Commands:
```bash
# Code Quality (REQUIRED after changes)
bun run lint:fix      # ESLint validation + auto-fix
bun tsc --noEmit      # Type checking
bun format            # Code formatting

# Development  
bun dev               # Development mode with auto-reload
bun start:bun         # Production start with bun

# Testing
bun test:chains       # Jest tests for chain functionality
```

### Code Standards:
- **Naming**: camelCase (variables/functions), PascalCase (classes/interfaces) 
- **Style**: Double quotes, no semicolons, trailing commas
- **Imports**: Use `@/` aliases (not `../../../`)
- **Comments**: JSDoc for functions, `// REVIEW:` for new features
- **ESLint**: Supports both camelCase and UPPER_CASE variables

### Critical Development Rules:
- **NEVER start the node directly** during development
- **Use `bun run lint:fix`** for error checking (not node startup)
- **Always run type checking** before marking tasks complete
- **Use `@/` imports** instead of relative paths
- **Add JSDoc documentation** for new functions

## Current Project Focus: Telegram Identity System

### Implementation Status: 85% Complete
- **Phase 1** ✅: SDK Foundation
- **Phase 2** ✅: Core Identity Processing Framework  
- **Phase 3** ✅: Complete System Integration (Commit: `d722dc57`)
- **Phase 4** 🔄: Cryptographic validation (next priority)
- **Phase 5** 🔄: End-to-end testing

### Key System Components (Operational):
1. **Transaction Processing**: Telegram identities processed by GCR system
2. **Incentive System**: 2-point rewards with anti-abuse protection  
3. **RPC Integration**: External system queries via endpoints
4. **Database**: JSONB storage and optimized retrieval
5. **Bot Integration**: Ready for crypto validation completion

## Technology Notes
- **GCR**: Always refers to GCRv2 unless specified otherwise
- **Consensus**: Always refers to PoRBFTv2 unless specified otherwise  
- **XM/Crosschain**: Multichain capabilities in `src/features/multichain`
- **SDK**: `@kynesyslabs/demosdk` package (current version 2.4.7)

## Quality Assurance Status
- **Linting**: ✅ All files pass ESLint validation
- **Type Safety**: ✅ Full TypeScript compliance
- **Testing**: 🔄 End-to-end testing pending Phase 5
- **Documentation**: ✅ Comprehensive comments and commit messages
- **Code Review**: Ready for Phase 4 security implementation

The project is in a solid development state with telegram identity system core functionality operational and ready for final cryptographic security implementation.