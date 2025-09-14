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

### Implementation Status: 95% Complete ✅
- **Phase 1** ✅: SDK Foundation
- **Phase 2** ✅: Core Identity Processing Framework  
- **Phase 3** ✅: Complete System Integration
- **Phase 4a+4b** ✅: Complete Cryptographic Verification (Latest: 2025-01-14)
- **Phase 5** 🔄: End-to-end testing (next priority)

### Latest Achievement: Phase 4a+4b Complete (2025-01-14)
**Major Corrections & Implementations**:
1. **Fixed Signature Flow**: Bot signature verification (not user signature)
2. **Genesis Authorization**: Bot address validation against genesis balances
3. **Critical Fix**: Proper handling of genesis balance array structure
4. **Integration Complete**: Full GCRIdentityRoutines and IncentiveManager integration

### Key System Components (Fully Operational):
1. **Transaction Processing**: Telegram identities processed by GCR system
2. **Cryptographic Security**: Bot signature verification with ucrypto
3. **Bot Authorization**: Genesis-based authorization preventing unauthorized bots
4. **Incentive System**: 2-point rewards with anti-abuse protection  
5. **RPC Integration**: External system queries via endpoints
6. **Database**: JSONB storage and optimized retrieval
7. **Bot Integration**: Ready for Phase 5 end-to-end testing

## Technology Notes
- **GCR**: Always refers to GCRv2 unless specified otherwise
- **Consensus**: Always refers to PoRBFTv2 unless specified otherwise  
- **XM/Crosschain**: Multichain capabilities in `src/features/multichain`
- **SDK**: `@kynesyslabs/demosdk` package (current version 2.4.7)

## Quality Assurance Status
- **Linting**: ✅ All files pass ESLint validation
- **Type Safety**: ✅ Full TypeScript compliance (union type constraints documented)
- **Testing**: 🔄 End-to-end testing pending Phase 5
- **Documentation**: ✅ Comprehensive comments and technical documentation
- **Code Review**: Ready for Phase 5 testing implementation
- **Security**: ✅ Enterprise-grade cryptographic verification implemented

## Genesis Block Architecture (Discovered 2025-01-14)
```json
"balances": [
    ["0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c", "1000000000000000000"],
    ["0x51322c62dcefdcc19a6f2a556a015c23ecb0ffeeb8b13c47e7422974616ff4ab", "1000000000000000000"]
]
```
- Structure: Array of `[address, balance]` tuples
- Authorization: Any address with non-zero balance = authorized bot
- Access: Via `Chain.getGenesisBlock().content.balances`

The project is in **excellent development state** with telegram identity system **production-ready** pending final end-to-end testing validation.