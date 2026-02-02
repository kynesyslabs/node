# Coding Conventions

**Analysis Date:** 2026-01-28

## Naming Patterns

**Files:**
- Source files: `camelCase.ts` for modules (e.g., `sharedState.ts`, `mainLoop.ts`, `calibrateTime.ts`)
- Class files: `PascalCase.ts` matching the class name (e.g., `PeerConnection.ts`, `TLSServer.ts`, `RateLimiter.ts`)
- Entity files: `PascalCase.ts` matching the entity name (e.g., `Blocks.ts`, `Transactions.ts`)
- Adapter files: `camelCase.ts` with descriptive suffix (e.g., `consensusAdapter.ts`, `peerAdapter.ts`, `BaseAdapter.ts`)
- Test files: `*.test.ts` in separate `tests/` directory (e.g., `handlers.test.ts`, `dispatcher.test.ts`)
- Mock files: `demosdk-*.ts` prefix pattern in `tests/mocks/` (e.g., `demosdk-encryption.ts`, `demosdk-types.ts`)

**Functions:**
- Use `camelCase` for all functions: `dispatchOmniMessage()`, `getSharedState()`, `encodeJsonRequest()`
- Prefix boolean-returning functions with verbs: `decodeTransaction()`, `verifySignature()`
- ESLint enforces `camelCase` for functions via `@typescript-eslint/naming-convention`

**Variables:**
- Use `camelCase` for variables: `peerManager`, `mockedGetPeerlist`, `baseContext`
- Use `UPPER_CASE` for constants: `OVERRIDE_PORT`, `SERVER_PORT`, `MCP_ENABLED`
- Leading underscores allowed for unused parameters: `_unused`
- ESLint enforces `camelCase` or `UPPER_CASE` for variables

**Types/Interfaces/Classes:**
- Use `PascalCase` for all type-like constructs: `HandlerContext`, `ParsedOmniMessage`, `ReceiveContext`
- Do NOT prefix interfaces with `I` (ESLint rule rejects `^I[A-Z]` pattern). Exception: some legacy types like `IPeer` exist in SDK mock types
- Classes use `PascalCase`: `Chain`, `PeerManager`, `OmniProtocolServer`
- Enums use `PascalCase`: `OmniOpcode`
- Type aliases use `PascalCase`: `DispatchOptions`, `ProposeBlockHashRequestPayload`

## Code Style

**Formatting:**
- Prettier with config at `.prettierrc`
- 4-space indentation (tabs: false)
- Double quotes (singleQuote: false)
- No semicolons (semi: false)
- Trailing commas in multiline (trailingComma: "always-multiline")
- Arrow parens: avoid (`x => x` not `(x) => x`)
- Bracket spacing: true
- Print width: 80
- Line endings: LF

**Linting:**
- ESLint v8 with `@typescript-eslint` plugin
- Config: `.eslintrc.cjs` (CommonJS format)
- Extends: `eslint:recommended`, `plugin:@typescript-eslint/recommended`
- Key enforced rules:
  - `quotes: ["error", "double"]` - Double quotes required
  - `semi: ["error", "never"]` - No semicolons
  - `comma-dangle: ["error", "always-multiline"]` - Trailing commas
  - `no-console: ["warn"]` - Warn on console.log in src/ (except allowed files)
  - `@typescript-eslint/naming-convention` - Enforced naming patterns
- Key disabled rules (permissive):
  - `@typescript-eslint/no-explicit-any: off` - `any` is freely used
  - `@typescript-eslint/no-unused-vars: off` - Unused vars allowed
  - `@typescript-eslint/no-empty-function: off`
  - `@typescript-eslint/ban-types: off`
- Run lint: `bun run lint` or `bun run lint:fix`

## Import Organization

**Order (observed pattern):**
1. Node.js built-ins (`fs`, `net`, `path`)
2. Third-party packages (`typeorm`, `dotenv`, `ethers`)
3. SDK imports (`@kynesyslabs/demosdk/*`)
4. Internal imports using `@/` alias or relative paths

**Path Aliases:**
- `@/*` maps to `src/*` (configured in `tsconfig.json` `paths`)
- Use `@/` for cross-module imports: `import log from "@/utilities/logger"`
- Use relative imports for same-module siblings: `import { getHandler } from "./registry"`
- Both patterns coexist; `@/` preferred for deeper imports

**Import style examples from codebase:**
```typescript
// Node built-ins
import net from "net"
import * as fs from "fs"

// Third-party
import { Repository } from "typeorm"
import * as dotenv from "dotenv"

// SDK
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"

// Internal with alias
import log from "src/utilities/logger"
import Datasource from "src/model/datasource"

// Internal relative
import { OmniOpcode } from "./opcodes"
import { getHandler } from "./registry"
```

**Note:** Some files use `src/` path directly instead of `@/` (e.g., `import log from "src/utilities/logger"`). Both `src/` and `@/` resolve to the same location. The `@/` alias is the preferred convention.

## Error Handling

**Patterns:**
- Custom error classes extend `Error`, set `this.name` in constructor
- Error hierarchy: `OmniProtocolError` (base with error code) -> specific errors like `UnknownOpcodeError`, `ConnectionError`
- Domain errors in `src/exceptions/index.ts`: `TimeoutError`, `AbortError`, `BlockNotFoundError`, etc.
- Protocol errors in `src/libs/omniprotocol/types/errors.ts` with numeric error codes (hex format: `0xf000`, `0xf001`)
- Try/catch with `log.error()` for DB operations (see `src/libs/blockchain/chain.ts`)
- Errors are typically thrown, not returned

**Error class template:**
```typescript
export class CustomError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "CustomError"
    }
}
```

## Logging

**Framework:** Custom `CategorizedLogger` system at `src/utilities/tui/`

**Legacy adapter:** `src/utilities/logger.ts` re-exports `LegacyLoggerAdapter` as default

**Patterns:**
- Import: `import log from "src/utilities/logger"` or `import log from "@/utilities/logger"`
- Usage: `log.error("[TAG] message")` with bracketed tags like `[ChainDB]`, `[MAIN]`, `[PEER]`
- For new code, prefer `CategorizedLogger`:
  ```typescript
  import { CategorizedLogger } from "@/utilities/tui"
  const logger = CategorizedLogger.getInstance()
  logger.info("CORE", "Starting the node")
  ```
- ESLint warns on `console.log` in source files; use the logger instead
- `console.log` is allowed in CLI tools, tests, and `src/index.ts` (via ESLint overrides)

## Comments

**When to Comment:**
- `// REVIEW:` comments mark newly added features or significant code blocks for review
- `// NOTE` for important behavioral notes
- `// SECTION` for major code sections (e.g., `// SECTION Preparation methods`)
- `// TODO:` for known incomplete work (though they exist, prefer beads-mcp for tracking)
- `// FIXME` for known issues requiring attention
- `/* eslint-disable ... */` at file top to suppress specific rules

**JSDoc/TSDoc:**
- Used on exported classes and utility wrappers (see `src/utilities/logger.ts`, `src/exceptions/index.ts`)
- Not consistently applied across all files
- When present, follows standard JSDoc format:
  ```typescript
  /**
   * Thrown when a Waiter event times out
   */
  export class TimeoutError extends Error { ... }
  ```

## Module Design

**Exports:**
- Default exports for singleton classes: `export default class Chain { ... }`
- Named exports for functions and types: `export async function dispatchOmniMessage(...)`
- Re-export barrel files: `src/utilities/logger.ts` re-exports from `./tui/LegacyLoggerAdapter`
- Mixed default + named exports in barrel files

**Static classes:**
- Singletons use static methods on classes: `Chain.setup()`, `Chain.read()`, `Datasource.getInstance()`
- This is a prevalent pattern throughout the codebase

**Barrel files:**
- `index.ts` files used for directory-level re-exports (e.g., `src/libs/omniprotocol/index.ts`)

## TypeScript Strictness

**Config highlights from `tsconfig.json`:**
- `strict: true` BUT with overrides:
  - `strictNullChecks: false` - Null checks are NOT enforced
  - `noImplicitAny: false` - Implicit any is allowed
  - `strictBindCallApply: false`
- `target: ESNext`, `module: ESNext`
- `moduleResolution: bundler`
- Decorators enabled: `emitDecoratorMetadata: true`, `experimentalDecorators: true` (for TypeORM entities)
- `skipLibCheck: true`
- Type checking: `bun run type-check` (uses bun build --no-emit) or `bun run type-check-ts` (uses tsc --noEmit)

## Entity Design (TypeORM)

**Pattern for database entities (see `src/model/entities/Blocks.ts`):**
```typescript
@Entity("table_name")
@Index("idx_name", ["column"])
export class EntityName {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("varchar", { name: "column_name" })
    columnName: string
}
```
- Entity classes use `PascalCase`
- Table names use `snake_case` lowercase
- Column names in DB use `snake_case`, property names use `camelCase` or `snake_case` (inconsistent)

## Git Conventions

**Commit messages (observed from recent history):**
- Lowercase, imperative mood: `enable tlsnotary and monitoring`, `clean up`, `more logs`
- Sometimes prefixed with type: `fix: hang while waiting for next block`, `feat: block batch sync`
- Short, informal style - no strict conventional commits enforcement
- Merge commits: `merge #NNN - description`

**Branch strategy:**
- `testnet` is the default/working branch
- `main` is the stable branch
- Feature branches merge to `testnet`

---

*Convention analysis: 2026-01-28*
