# Development Guidelines

## Core Principles

### 1. Maintainability First
- Prioritize clean, readable, well-documented code
- Use descriptive names for variables, functions, and types
- Follow established project patterns and conventions
- Document significant architectural decisions

### 2. Planning and Workflow
- **Plan before coding**: Create implementation plans for complex features
- **Phases workflow**: Use *_PHASES.md files for actionable, short but useful steps
- **Incremental development**: Make focused, reviewable changes
- **Seek confirmation**: Ask for clarification on ambiguous requirements
- **Wait for confirmations**: When following phases, complete one phase at a time
- **Context awareness**: This is Demos Network node/RPC software

### 3. Code Quality Standards
- **Error handling**: Comprehensive error handling and validation required
- **Type safety**: Full TypeScript type coverage mandatory
- **Testing**: Follow existing test patterns and maintain coverage
- **Linting**: Run `bun run lint:fix` after changes (MANDATORY)

## Architecture Principles

### Follow Existing Patterns
- Look at similar implementations in the codebase
- Use established utility functions and helpers
- Integrate with existing SDK methods and APIs
- Maintain consistency with current patterns

### Integration Guidelines
- **SDK Integration**: Use @kynesyslabs/demosdk correctly
- **Database**: Follow TypeORM patterns for entities and queries
- **Features**: Place new features in appropriate src/features/ subdirectory
- **Types**: Define types in src/types/ for shared interfaces

## Best Practices

### 1. Clean Imports
**CRITICAL**: Use `@/` path aliases instead of relative imports
```typescript
// ✓ Correct
import { helper } from "@/libs/utils/helper"
import { Feature } from "@/features/incentive/types"

// ✗ Wrong
import { helper } from "../../../libs/utils/helper"
```

### 2. Code Review Markers
Add `// REVIEW:` before newly added features or significant code blocks
```typescript
// REVIEW: New authentication flow implementation
async function authenticateUser(credentials: UserCredentials) {
    // Implementation
}
```

### 3. Documentation Standards
- **JSDoc**: Required for all new methods and functions
- **Inline comments**: Required for complex logic or business rules
- **Decision documentation**: Document non-obvious implementation choices

### 4. Error Messages
- Provide clear, actionable error messages
- Include context for debugging
- Use professional language for user-facing errors

### 5. Naming Conventions
- Variables/functions: camelCase
- Classes/types/interfaces: PascalCase
- No "I" prefix for interfaces
- Descriptive names that express intent

### 6. Code Comments for Cross-Language Understanding
When coding in non-TypeScript/JavaScript languages (e.g., Rust for Solana):
- Always comment with analogies to Solidity/TypeScript/JavaScript
- Help developers from TS/JS/Solidity background grasp code quickly
- Example: "// Similar to TypeScript's async/await pattern"

### 7. Diagrams for Complex Features
When following phases workflow and feature is complex:
- Create markdown file with ASCII/Unicode diagram
- Label with function names
- Number with phase numbers
- Use blocks and lines to show flow
- Place alongside implementation

## Repository-Specific Notes

### Version References
- **GCR**: Always refers to GCRv2 methods unless specified
- **Consensus**: Always refers to PoRBFTv2 if present
- **SDK**: @kynesyslabs/demosdk from npm, sources at ../sdks/

### Branch-Specific Notes
- **native_bridges branch**: Reference ./bridges_docs/ for status and phases
- **native_bridges imports**: When importing from ../sdks/build, add:
  ```typescript
  // FIXME Once we have a proper SDK build, use the correct import path
  ```

## Testing Guidelines

### CRITICAL: Never Start Node During Development
- **NEVER** run `./run` or `bun run start` during development
- **Use** `bun run lint:fix` to check for errors
- **Node startup** only in production or controlled environments
- **ESLint validation** is the primary method for code correctness

### Testing Workflow
```bash
# 1. Make changes
# 2. Validate syntax and quality
bun run lint:fix

# 3. Run tests if applicable
bun run test:chains

# 4. Only in production/controlled environment
./run
```

## Tools and Agents

### MCP Servers Available
- Use MCP servers when needed (e.g., aptos-docs-mcp for Aptos documentation)
- Reference demosdk-references for SDK-specific lookups
- Use demosdk-gitbook for snippets and examples

### Specialized Agents
- Use specialized agents when beneficial (e.g., rust-pro for Rust code)
- Only invoke when they add value to the task

## Communication and Collaboration

### When to Ask Questions
- Requirements are unclear
- Multiple valid approaches exist
- Complex implementation decisions needed
- Non-obvious code choices being made

### Documentation Requirements
- Explain complex implementation decisions
- Provide context for non-obvious code choices
- Document deviations from standard patterns
- Note any technical debt or future improvements

## Development Workflow Summary

1. **Understand the task and context**
2. **Plan the implementation** (create *_PHASES.md if complex)
3. **Follow established patterns** from existing code
4. **Implement with proper documentation** (JSDoc, comments, REVIEW markers)
5. **Use @/ import aliases** (never relative paths)
6. **Validate with linting** (`bun run lint:fix`)
7. **Test if applicable** (`bun run test:chains`)
8. **Report completion** with summary of changes
9. **Wait for confirmation** before next phase

## Code Organization

### File Placement
- Tests: Place in `src/tests/` directory
- Scripts: Place in `src/utilities/` directory
- Documentation: Place in `claudedocs/` for Claude-generated reports
- Features: Place in appropriate `src/features/` subdirectory

### Structure Consistency
- Check for existing directories before creating new ones
- Follow the established directory patterns
- Maintain separation of concerns
- Keep related code together
