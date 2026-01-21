# Demos Network Node Software - Code Style & Conventions

## ESLint Configuration

### Naming Conventions (enforced by @typescript-eslint/naming-convention)

- **Variables/Functions/Methods**: camelCase (leading/trailing underscores allowed)
- **Classes/Types/Interfaces**: PascalCase
- **Interfaces**: PascalCase (no "I" prefix - explicitly forbidden)
- **Type Aliases**: PascalCase

### Code Style Rules

- **Quotes**: Double quotes (`"`) required
- **Semicolons**: None (`;` forbidden)
- **Indentation**: 4 spaces (via Prettier)
- **Comma Dangling**: Always multiline
- **Switch Cases**: Colon spacing enforced

## Prettier Configuration

- **Print Width**: 80 characters
- **Tab Width**: 4 spaces
- **Single Quote**: false (use double quotes)
- **Semi**: false (no semicolons)
- **Trailing Comma**: "all" (always for multiline)
- **Arrow Parens**: "avoid" (omit when possible)
- **End of Line**: "lf" (Unix line endings)
- **Bracket Spacing**: true

## TypeScript Configuration

- **Target**: ESNext
- **Module**: ESNext with bundler resolution
- **Strict Mode**: Enabled with exceptions:
    - `strictNullChecks`: false
    - `noImplicitAny`: false
    - `strictBindCallApply`: false
- **Decorators**: Experimental decorators enabled
- **Source Maps**: Enabled for debugging

## Import Conventions

- **Path Aliases**: Use `@/` instead of relative imports (`../../../`)
- **Import Style**: ES6 imports with destructuring where appropriate
- **Restricted Imports**: Warnings for certain import patterns

## File Organization

- **License Headers**: All files start with KyneSys Labs license
- **Feature-based Structure**: Code organized in `src/features/` by domain
- **Utilities**: Shared utilities in `src/utilities/` and `src/libs/`
- **Types**: Centralized type definitions in `src/types/`

## Comments & Documentation

- **License**: CC BY-NC-ND 4.0 header in all source files
- **JSDoc**: Expected for public APIs and complex functions
- **Review Comments**: Use `// REVIEW:` for new features needing attention
- **FIXME Comments**: For temporary workarounds needing later fixes
