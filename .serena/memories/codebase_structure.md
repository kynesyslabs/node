# Codebase Structure

## Root Directory Layout

### Source Code
```
src/
├── index.ts              # Main entry point
├── benchmark.ts          # Performance benchmarking
├── client/               # Client implementations
├── exceptions/           # Custom exception classes
├── features/            # Feature modules (see below)
├── libs/                # Shared libraries and utilities
├── migrations/          # Database migrations
├── model/              # TypeORM models and database layer
├── ssl/                # SSL/TLS certificates
├── tests/              # Test files
├── types/              # TypeScript type definitions
└── utilities/          # Utility scripts
```

### Feature Modules (src/features/)
```
features/
├── InstantMessagingProtocol/  # Messaging protocol
├── activitypub/              # ActivityPub integration
├── bridges/                  # Cross-chain bridges
├── contracts/                # Smart contract interactions
├── fhe/                      # Fully Homomorphic Encryption
├── incentive/                # Incentive system
├── logicexecution/           # Logic execution engine
├── mcp/                      # MCP protocol
├── multichain/               # Cross-chain (XM) capabilities
├── pgp/                      # PGP encryption
├── postQuantumCryptography/  # Post-quantum crypto
├── web2/                     # Web2 integrations
└── zk/                       # Zero-knowledge proofs
```

### Configuration Files
```
.
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── .eslintrc.cjs         # ESLint configuration
├── .prettierrc           # Prettier configuration
├── jest.config.ts        # Jest testing configuration
├── .env                  # Environment variables (not in git)
├── .env.example          # Environment template
├── demos_peerlist.json   # Peer list (not in git)
└── demos_peerlist.json.example  # Peer list template
```

### Documentation
```
docs/                    # General documentation
documentation/           # Additional documentation
architecture/            # Architecture documentation
bridges_docs/           # Bridge implementation docs
claudedocs/             # Claude-generated documentation
PR_COMMENTS/            # Pull request comments
```

### Data and Runtime
```
data/                   # Runtime data (chain.db, etc.)
logs/                   # Application logs
postgres/               # PostgreSQL data directory
postgres_5332/          # Default PostgreSQL instance
docker_data/            # Docker-related data
dist/                   # Compiled output
```

### Development and Testing
```
local_tests/            # Local testing scripts
sdk/                    # SDK-related files
temp/                   # Temporary files
ssl/                    # SSL certificates
```

## Important Files

### Identity and Keys
- `.demos_identity` - Node private key (never commit)
- `.demos_identity.key` - Key file (never commit)
- `publickey_*` - Public key files

### Configuration
- `ormconfig.json` - TypeORM configuration
- `.gitignore` - Git ignore rules
- `bun.lockb` - Bun lock file

### Scripts
- `run` - Main startup script (database + node)
- `captraf.sh` - Traffic capture script

### Phase Documents
- `*_PHASES.md` - Phase-based workflow documents
- `*_SPEC.md` - Feature specifications
- Examples:
  - `STORAGE_PROGRAMS_PHASES.md`
  - `STORAGE_PROGRAMS_SPEC.md`
  - `D402_HTTP_PHASES.md`
  - `APTOS_INTEGRATION_PLAN.md`

## Path Aliases

### @/ Prefix
All imports use the `@/` prefix mapping to `src/`:
```typescript
// ✓ Correct
import { helper } from "@/libs/utils/helper"
import { Feature } from "@/features/incentive/types"
import { Model } from "@/model/entities/User"

// ✗ Wrong - Never use relative paths
import { helper } from "../../../libs/utils/helper"
```

## Naming Conventions in Repository

### Special Terminology
- **XM / Crosschain**: Multichain capabilities (synonymous)
- **SDK / demosdk**: @kynesyslabs/demosdk package
- **SDK sources**: ../sdks/ separate repository
- **Phases workflow**: Implementation following *_PHASES.md files
- **GCR**: Global Consensus Registry (always GCRv2 unless specified)
- **PoR BFT**: Proof of Reserve Byzantine Fault Tolerance (v2)

## Build Output
- Compiled files go to `dist/` directory
- Source maps are generated and inlined
- Declarations are emitted

## Ignored Directories
Common directories in .gitignore:
- `node_modules/`
- `dist/`
- `data/`
- `logs/`
- `postgres*/`
- `.env`
- `.demos_identity*`
- `publickey_*`
