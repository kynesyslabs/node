# Node Testing Guidelines

## Critical Rules
- **NEVER start the node directly** during development or testing
- **Use `bun run lint:fix`** to check for syntax errors and code quality issues
- **Node startup** should only be done in production or controlled environments
- **ESLint validation** is the primary method for checking code correctness in this repository

## Testing Workflow
1. Make code changes
2. Run `bun run lint:fix` to validate syntax and fix formatting
3. Check ESLint output for any remaining errors
4. Only start node in production or controlled test environments

## Why This Approach
- Node startup is resource-intensive and unnecessary for code validation
- ESLint catches syntax errors, type issues, and formatting problems
- Prevents accidental node startup during development
- Maintains development environment stability