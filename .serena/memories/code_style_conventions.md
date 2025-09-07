# Code Style and Conventions

## Naming Conventions (ESLint Enforced)
- **Variables/Functions**: camelCase (e.g., `getUserData`, `apiResponse`)
- **Methods**: camelCase (e.g., `processTransaction`)
- **Classes**: PascalCase (e.g., `NetworkManager`, `BlockchainNode`)
- **Types/Interfaces**: PascalCase, NO "I" prefix (e.g., `UserData`, not `IUserData`)
- **Type Aliases**: PascalCase (e.g., `ResponseType`)
- **Constants**: camelCase with leading/trailing underscores allowed

## Code Formatting (Prettier)
- **Quotes**: Double quotes ("text")
- **Semicolons**: NONE (semi: false)
- **Tab Width**: 4 spaces (no tabs)
- **Line Width**: 80 characters
- **Trailing Commas**: Always multiline
- **Arrow Functions**: Avoid parentheses (arrowParens: "avoid")
- **Bracket Spacing**: Enabled
- **End of Line**: LF

## TypeScript Configuration
- **Strict Mode**: Enabled
- **Null Checks**: Disabled (strictNullChecks: false)
- **Implicit Any**: Allowed (noImplicitAny: false)
- **Decorators**: Experimental decorators enabled
- **Path Aliases**: Use @/* instead of relative imports (../../../)

## Import Conventions
- **Absolute Imports**: Prefer @/* path aliases over relative imports
- **SDK Imports**: Use @kynesyslabs/demosdk for SDK functionality
- **No Restricted Imports**: Warnings for certain import patterns

## Code Quality Rules
- **Unused Variables**: Disabled (allowed for development)
- **Console Logs**: Allowed (no-console: off)
- **Switch Statements**: Proper colon spacing required
- **Extra Semicolons**: Error (contradicts semi: false rule)