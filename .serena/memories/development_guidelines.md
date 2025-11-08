# Demos Network Node - Development Guidelines

## Code Style Standards

### ESLint Naming Conventions
- **Variables/Functions/Methods**: camelCase (leading/trailing underscores allowed)
- **Classes/Types/Interfaces**: PascalCase
- **Interfaces**: PascalCase (NO "I" prefix - explicitly forbidden)
- **Type Aliases**: PascalCase

### Code Formatting (Prettier)
- **Quotes**: Double quotes (`"`) required
- **Semicolons**: None (`;` forbidden)
- **Indentation**: 4 spaces
- **Print Width**: 80 characters
- **Trailing Comma**: "all" (always for multiline)
- **Arrow Parens**: "avoid" (omit when possible)
- **Line Endings**: "lf" (Unix)

### Import Conventions
- **Path Aliases**: ALWAYS use `@/` instead of relative imports
- **Import Style**: ES6 imports with destructuring
- **Example**:
  ```typescript
  // ✅ GOOD
  import { someUtility } from "@/utilities/someUtility"
  
  // ❌ BAD
  import { someUtility } from "../../../utilities/someUtility"
  ```

## Development Workflow

### Quality Checks (MANDATORY)
```bash
bun run lint:fix          # ALWAYS run after code changes
bun tsc --noEmit         # Type checking (MANDATORY before completion)
```

### Code Review Preparation
- Add `// REVIEW:` comments before newly added features
- Use JSDoc format for all new methods and functions
- Document non-obvious implementation decisions
- Inline comments for complex logic or business rules

### File Creation Rules
- **NEVER create files unless absolutely necessary**
- **ALWAYS prefer editing existing files**
- **NEVER proactively create documentation** unless explicitly requested
- **Use feature-based organization** for new modules

## Architecture Principles

### Feature-Based Organization
- Organize code by business domain in `src/features/`
- Each feature self-contained with clear boundaries
- Cross-feature communication through well-defined interfaces

### Established Patterns
1. **DRY**: Abstract common functionality, eliminate duplication
2. **KISS**: Prefer simplicity over complexity
3. **YAGNI**: Implement current requirements only
4. **SOLID**: Single responsibility, open/closed, LSK substitution, interface segregation, dependency inversion

### License Headers
All source files start with:
```typescript
/* LICENSE
© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0
Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
*/
```

## Development Best Practices

### Error Handling
- Provide clear, actionable error messages
- Include context for debugging
- Use consistent error formatting

### Naming Conventions
- Use descriptive names expressing intent
- Follow TypeScript/JavaScript conventions
- Maintain consistency with existing codebase

### Performance Considerations
- Consider resource usage and optimization
- Follow established patterns for database queries
- Use appropriate data structures and algorithms

## Testing Strategy

### Node Testing Rules
- **NEVER start the node directly** during development (`bun run start`, `./run`)
- **Use `bun run lint:fix`** for syntax validation
- **ESLint validation** is the primary method for checking code correctness
- Manual testing only in controlled environments

### Test Organization
- Follow existing test patterns in `src/tests/`
- Place tests in appropriate test directories
- Co-locate with source when appropriate

## Task Completion Checklist

Before marking any task complete:
1. ✅ Run type checking (`bun tsc --noEmit`)
2. ✅ Run linting (`bun run lint:fix`)
3. ✅ Add `// REVIEW:` comments on new code
4. ✅ Use `@/` imports instead of relative paths
5. ✅ Add JSDoc for new functions

## Common Commands

### Essential Development
```bash
bun run lint:fix          # Auto-fix ESLint issues
bun run format            # Format code with Prettier
bun tsc --noEmit         # Type checking only
bun install              # Install dependencies
```

### Database Operations
```bash
bun run migration:generate  # Generate TypeORM migration
bun run migration:run       # Run pending migrations
bun run migration:revert    # Revert last migration
```

### Testing
```bash
bun test:chains          # Run chain-specific tests
```

## Important DON'Ts

### ❌ NEVER Do These
- Start the node directly during development
- Skip linting after code changes
- Use relative imports (use `@/` path aliases)
- Create unnecessary files
- Ignore naming conventions
- Proactively create documentation

### ✅ ALWAYS Do These
- Run `bun run lint:fix` after any code changes
- Use established patterns from existing code
- Follow the license header format in new files
- Ask for clarification on ambiguous requirements
- Use feature-based organization for new modules
