# Demos Network Node Software - Development Patterns & Guidelines

## Architecture Principles

### Feature-Based Architecture

- Organize code by business domain in `src/features/`
- Each feature is self-contained with clear boundaries
- Cross-feature communication through well-defined interfaces
- Examples: `multichain`, `bridges`, `zk`, `fhe`, `postQuantumCryptography`

### Established Patterns to Follow

#### Import Patterns

```typescript
// ✅ GOOD: Use path aliases
import { someUtility } from "@/utilities/someUtility"
import { PeerManager } from "@/libs/peer"

// ❌ BAD: Relative imports
import { someUtility } from "../../../utilities/someUtility"
```

#### License Headers

```typescript
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
```

#### TypeScript Conventions

```typescript
// ✅ GOOD: Follow naming conventions
class UserManager {} // PascalCase for classes
interface UserData {} // PascalCase, no "I" prefix
function getUserData() {} // camelCase for functions
const userName = "john" // camelCase for variables

// ✅ GOOD: Use proper module exports
export { default as server_rpc } from "./server_rpc"

// ✅ GOOD: Destructure imports where appropriate
import { getSharedState } from "./utilities/sharedState"
```

## Development Guidelines

### Code Quality Standards

1. **Maintainability First**: Clean, readable, well-documented code
2. **Error Handling**: Comprehensive error handling and validation
3. **Type Safety**: Full TypeScript coverage, run lint after changes
4. **Testing**: Follow existing test patterns in `src/tests/`

### Workflow Patterns

1. **Plan Before Coding**: Create implementation plans for complex features
2. **Phases Workflow**: Use `*_PHASES.md` files for complex feature development
3. **Incremental Development**: Focused, reviewable changes
4. **Leverage Existing**: Use established patterns and utilities
5. **Seek Confirmation**: Ask for clarification on ambiguous requirements

### Integration Patterns

#### SDK Integration

```typescript
// ✅ Use the published package
import { SomeSDKFunction } from "@kynesyslabs/demosdk"

// ⚠️ Only reference ../sdks/ if package behavior is unclear
```

#### Database Integration (TypeORM)

```typescript
// Follow existing entity patterns
@Entity()
export class SomeEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column()
    name: string
}
```

#### Network Layer Integration

```typescript
// Use established server patterns from src/libs/network/
import { server_rpc } from "@/libs/network"
```

## Project-Specific Conventions

### Demos Network Terminology

- **XM/Crosschain**: Multichain capabilities (interchangeable terms)
- **GCR**: Always refers to GCRv2 methods unless specified
- **Consensus**: Always refers to PoRBFTv2 when present
- **SDK/demosdk**: Refers to `@kynesyslabs/demosdk` package

### Special Branch Considerations

- **native_bridges branch**: Reference `./bridges_docs/` for status
- **SDK imports**: Sometimes import from `../sdks/build` with `// FIXME` comment

### File Creation Guidelines

- **NEVER create files unless absolutely necessary**
- **ALWAYS prefer editing existing files**
- **NEVER proactively create documentation** unless explicitly requested
- **Use feature-based organization** for new modules

### Review and Documentation

```typescript
// REVIEW: New authentication middleware implementation
export class AuthMiddleware {
    // Complex logic explanation here
}
```

## Best Practices

### Error Messages

- Provide clear, actionable error messages
- Include context for debugging
- Use consistent error formatting

### Naming Conventions

- Use descriptive names expressing intent
- Follow TypeScript/JavaScript conventions
- Maintain consistency with existing codebase

### Documentation Standards

- JSDoc for all new methods and functions
- Inline comments for complex logic
- Document architectural decisions

### Performance Considerations

- Consider resource usage and optimization
- Follow established patterns for database queries
- Use appropriate data structures and algorithms

## Testing Strategy

- **NEVER start the node directly** during testing
- Use `bun run lint:fix` for syntax validation
- Follow existing test patterns in `src/tests/`
- Manual testing only in controlled environments
