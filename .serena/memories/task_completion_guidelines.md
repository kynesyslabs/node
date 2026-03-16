# Demos Network Node Software - Task Completion Guidelines

## Essential Quality Checks After Code Changes

### 1. Code Quality Validation

```bash
bun run lint:fix          # ALWAYS run after code changes
```

- Fixes ESLint issues automatically
- Validates naming conventions (camelCase, PascalCase)
- Ensures code style compliance
- **CRITICAL**: This is the primary validation method - NEVER skip

### 2. Type Safety Verification

Since this project uses TypeScript with strict settings:

- TypeScript compilation happens during `bun run lint:fix`
- Watch for type errors in the output
- Address any type-related warnings

### 3. Code Review Preparation

- Add `// REVIEW:` comments before newly added features
- Document complex logic with inline comments
- Ensure JSDoc comments for new public methods

## Development Workflow Completion

### When Adding New Features

1. **Implement the feature** following established patterns
2. **Run `bun run lint:fix`** to validate syntax and style
3. **Add review comments** for significant changes
4. **Update relevant documentation** if needed
5. **Test manually** if applicable (avoid starting the node directly)

### When Modifying Existing Code

1. **Understand existing patterns** before making changes
2. **Maintain consistency** with current codebase style
3. **Run `bun run lint:fix`** to catch any issues
4. **Verify imports** use `@/` path aliases instead of relative paths

### When Working with Database Models

1. **Generate migrations** if schema changes: `bun run migration:generate`
2. **Review generated migrations** before committing
3. **Test migration** in development environment if possible

## Important "DON'Ts" for Task Completion

### ❌ NEVER Do These:

- **Start the node directly** during development (`bun run start`, `./run`)
- **Skip linting** - always run `bun run lint:fix`
- **Use relative imports** - use `@/` path aliases instead
- **Create unnecessary files** - prefer editing existing ones
- **Ignore naming conventions** - follow camelCase/PascalCase rules

### ✅ ALWAYS Do These:

- **Run `bun run lint:fix`** after any code changes
- **Use established patterns** from existing code
- **Follow the license header** format in new files
- **Ask for clarification** on ambiguous requirements
- **Use feature-based organization** for new modules

## Validation Commands Summary

| Task Type          | Required Command             | Purpose                      |
| ------------------ | ---------------------------- | ---------------------------- |
| Any code change    | `bun run lint:fix`           | Syntax, style, type checking |
| New features       | `// REVIEW:` comments        | Mark for code review         |
| Database changes   | `bun run migration:generate` | Create schema migrations     |
| Dependency updates | `bun install`                | Ensure deps are current      |

## Quality Gates

Before considering any task complete:

1. ✅ Code passes `bun run lint:fix` without errors
2. ✅ All new code follows established patterns
3. ✅ Path aliases (`@/`) used instead of relative imports
4. ✅ Review comments added for significant changes
5. ✅ No unnecessary new files created

## Special Project Considerations

- **Node Testing**: Use ESLint validation instead of starting the node
- **SDK Integration**: Reference `@kynesyslabs/demosdk` package, not source
- **Bun Preference**: Always use `bun` commands over `npm`/`yarn`
- **License Compliance**: CC BY-NC-ND 4.0 headers in all new source files
