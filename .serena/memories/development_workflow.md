# Development Workflow & Standards

## Essential Commands
```bash
# Development
bun start:bun          # Start with bun (preferred)
bun dev               # Development mode with auto-reload
bun start:clean       # Start with clean chain database

# Code Quality (ALWAYS run after changes)
bun lint              # Check prettier + ESLint
bun tsc --noEmit      # Type check (REQUIRED)
bun format            # Format code
bun lint:fix          # Auto-fix issues

# Testing
bun test:chains       # Jest tests for chain functionality

# Dependencies
bun install           # Install packages
bun upgrade_sdk       # Upgrade @kynesyslabs/demosdk
```

## Code Standards
- **Naming**: camelCase (variables/functions), PascalCase (classes/interfaces)
- **Style**: Double quotes, no semicolons, trailing commas
- **Imports**: Use `@/` aliases (not `../../../`)
- **Comments**: JSDoc for functions, `// REVIEW:` for new features

## Task Completion Checklist
```bash
# Standard completion check
bun lint && bun tsc --noEmit && bun format
```

**Before marking any task complete**:
1. ✅ Run type checking (`bun tsc --noEmit`) 
2. ✅ Run linting (`bun lint`)
3. ✅ Add `// REVIEW:` comments on new code
4. ✅ Use `@/` imports instead of relative paths
5. ✅ Add JSDoc for new functions

## Documentation Standards
- JSDoc format for methods
- Inline comments for complex logic
- `// REVIEW:` before new features
- Create `*_PHASES.md` for complex implementations

## Important Notes
- **Always use bun** (not npm/yarn)
- **GCR = GCRv2**, **Consensus = PoRBFTv2** unless specified
- **XM = Crosschain** (multichain capabilities)
- Use Serena MCP when available for project operations