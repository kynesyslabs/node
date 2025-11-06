# Code Style and Conventions

## Naming Conventions (ESLint Enforced)

### Variables and Functions
- **Format**: camelCase
- **Leading/Trailing Underscores**: Allowed
- **Example**: `getUserData`, `_privateVar`, `helperFunction_`

### Functions and Methods
- **Format**: camelCase
- **Example**: `calibrateTime()`, `digestArguments()`, `getNextAvailablePort()`

### Classes, Types, and Interfaces
- **Format**: PascalCase
- **Interface Prefix**: NO "I" prefix (enforced by ESLint)
- **Example**: 
  - Classes: `UserManager`, `DataProcessor`
  - Interfaces: `UserData` (NOT `IUserData`)
  - Type Aliases: `ResponseType`, `ConfigOptions`

## Code Formatting

### Quotes and Semicolons
- **Quotes**: Double quotes (enforced)
- **Semicolons**: NO semicolons (enforced)
- **Example**:
```typescript
const message = "Hello world"  // ✓ Correct
const message = 'Hello world'; // ✗ Wrong
```

### Spacing and Structure
- **Switch Case**: Space after colon
- **Comma Dangle**: Always in multiline structures
- **Extra Semicolons**: Error
- **Example**:
```typescript
switch (value) {
    case "a": return true  // ✓ Correct spacing
    case "b": return false
}

const obj = {
    key1: "value1",
    key2: "value2",  // ✓ Trailing comma
}
```

## Import Organization

### Path Aliases (CRITICAL)
- **Use**: `@/` for all imports instead of relative paths
- **Example**:
```typescript
// ✓ Correct
import { helper } from "@/libs/utils/helper"
import { Feature } from "@/features/incentive/types"

// ✗ Wrong
import { helper } from "../../../libs/utils/helper"
import { Feature } from "../../features/incentive/types"
```

### Import Rules
- **Restricted Imports**: Warning enabled
- **No Relative Imports**: Prefer @/ aliases for maintainability

## TypeScript Configuration

### Type Safety
- **strictNullChecks**: false (relaxed)
- **noImplicitAny**: false (relaxed)
- **strictBindCallApply**: false (relaxed)
- **strict**: true (but with above overrides)
- **skipLibCheck**: true

### Decorators
- **experimentalDecorators**: true (required for TypeORM)
- **emitDecoratorMetadata**: true (required for TypeORM)

## Documentation Standards

### JSDoc Format
- **Required**: All new methods and functions must have JSDoc comments
- **Inline Comments**: Required for complex logic or business rules
- **Implementation Decisions**: Document non-obvious choices

### Code Review Markers
- **Marker**: `// REVIEW:` before newly added features or significant code blocks
- **Purpose**: Highlight changes for review process

## Linting and Disabled Rules

### Relaxed Rules
- `no-unused-vars`: OFF
- `@typescript-eslint/no-unused-vars`: OFF
- `@typescript-eslint/no-var-requires`: OFF
- `@typescript-eslint/ban-types`: OFF
- `@typescript-eslint/no-empty-function`: OFF
- `@typescript-eslint/no-explicit-any`: OFF
- `no-var`: OFF
- `no-console`: Not enforced (warnings disabled)

## Best Practices

### Error Messages
- Provide clear, actionable error messages for debugging

### Variable Naming
- Use descriptive names expressing intent clearly
- Follow domain-specific terminology from blockchain/network context

### Code Organization
- Follow established project structure
- Maintain consistency with existing patterns
- Integrate with SDK methods properly
