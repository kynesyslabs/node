# Coding Guidelines - Demos Network Node Software

This document provides natural language coding guidelines extracted from the project's ESLint configuration and established patterns.

## 1. Code Formatting

### 1.1 Quotes and Semicolons

- **Always use double quotes** for string literals
    - ✅ `const message = "Hello World"`
    - ❌ `const message = 'Hello World'`

- **Never use semicolons** at the end of statements
    - ✅ `const value = 42`
    - ❌ `const value = 42;`

### 1.2 Comma Usage

- **Always include trailing commas** in multi-line structures (arrays, objects, function parameters)
    - ✅ Multi-line with trailing comma:

    ```typescript
    const config = {
        host: "localhost",
        port: 53550,
        debug: true,
    }
    ```

    - ❌ Multi-line without trailing comma:

    ```typescript
    const config = {
        host: "localhost",
        port: 53550,
        debug: true,
    }
    ```

### 1.3 Switch Statements

- **Add space after colon** in switch case statements, but not before
    - ✅ `case "test": return value`
    - ❌ `case "test" :return value`
    - ❌ `case "test":return value`

## 2. Naming Conventions

### 2.1 Variables and Functions

- **Use camelCase** for all variables and function names
    - ✅ `const userName = "Alice"`
    - ✅ `function calculateTotal() { }`
    - ❌ `const user_name = "Alice"`
    - ❌ `function CalculateTotal() { }`

- **Leading underscores are allowed** but should be used sparingly (typically for private/internal properties)
    - ✅ `const _internalState = {}`
    - ✅ `const normalVariable = {}`

### 2.2 Methods

- **Use camelCase** for all class and object methods
    - ✅ `class Service { processData() { } }`
    - ❌ `class Service { ProcessData() { } }`

### 2.3 Types and Interfaces

- **Use PascalCase** for all type definitions
    - ✅ `type UserProfile = { }`
    - ✅ `interface Configuration { }`
    - ❌ `type userProfile = { }`

- **Don't prefix interfaces with 'I'**
    - ✅ `interface UserService { }`
    - ❌ `interface IUserService { }`

### 2.4 Classes

- **Use PascalCase** for all class names
    - ✅ `class NetworkManager { }`
    - ❌ `class networkManager { }`
    - ❌ `class network_manager { }`

### 2.5 Type Aliases

- **Use PascalCase** for type aliases
    - ✅ `type ResponseStatus = "success" | "error"`
    - ❌ `type responseStatus = "success" | "error"`

## 3. TypeScript Specific Guidelines

### 3.1 Type Safety

- **Using `any` is allowed** when necessary, but should be avoided when possible
    - Prefer specific types or `unknown` when the type is truly unknown
    - Document why `any` is used when it's necessary

### 3.2 Empty Functions

- **Empty functions are permitted** (useful for default callbacks, placeholders, or optional handlers)
    - ✅ `const noop = () => {}`
    - ✅ `onError: () => {}  // Default no-op handler`

### 3.3 CommonJS Requires

- **`require()` statements are allowed** when needed for dynamic imports or CommonJS compatibility
    - However, prefer ES6 `import` statements when possible

### 3.4 Variable Declarations

- **`var` keyword is technically allowed** but strongly discouraged
    - Always prefer `const` for values that won't be reassigned
    - Use `let` for values that will be reassigned
    - ✅ `const API_URL = "https://api.example.com"`
    - ✅ `let counter = 0`
    - ⚠️ `var oldStyle = "avoid this"`

## 4. Code Quality

### 4.1 Unused Variables

- **Unused variables are currently not enforced** by the linter
    - However, you should still remove unused code for cleanliness
    - Consider commenting out code that might be needed later with explanation

### 4.2 Console Statements

- **Console statements are allowed** (no warning for console.log, console.error, etc.)
    - Use them appropriately for debugging and logging
    - Consider using a proper logging system for production code

### 4.3 Extra Semicolons

- **No extra semicolons allowed** (this is enforced as an error)
    - ❌ `const value = 42;;`
    - ❌ `function test() { };`

## 5. Import Guidelines

### 5.1 Import Restrictions

- **Import restrictions are configured as warnings**
    - Follow the project's module structure
    - Avoid circular dependencies
    - Use proper path aliases when configured

## 6. Environment and Compatibility

### 6.1 Target Environment

- Code runs primarily in **Bun runtime** (with Node.js compatibility)
- **Bun is the preferred package manager and runtime**
- **ES6 modules** are the primary module system (CommonJS supported for compatibility)
- **Bun test** is used for testing (Jest configuration maintained for compatibility)
- ECMAScript 2020+ features are available
- TypeScript is executed directly via Bun without compilation step

### 6.2 Global Variables

- `NodeJS` namespace is available (read-only)
- `globalThis` is available for global scope access
- Bun-specific globals are available when running under Bun runtime

## 7. Best Practices (Beyond ESLint)

### 7.1 File Organization

- Keep files focused on a single responsibility
- Group related functionality in feature modules
- Use clear, descriptive file names

### 7.2 Error Handling

- Always handle errors appropriately
- Use try-catch blocks for async operations
- Provide meaningful error messages

### 7.3 Comments and Documentation

- Write self-documenting code when possible
- Add comments for complex logic
- Use JSDoc comments for public APIs

### 7.4 Testing

- Write tests for new features
- Maintain existing test coverage
- Follow the established testing patterns in the codebase

---

## 8. Package Management and Runtime

### 8.1 Package Manager

- **Always use Bun** as the package manager
    - ✅ `bun install`
    - ✅ `bun add <package>`
    - ❌ `npm install`
    - ❌ `yarn add`

### 8.2 Running Scripts

- **Use Bun to run TypeScript directly**
    - ✅ `bun run <script>`
    - ✅ `bun src/index.ts`
    - ⚠️ Only use `npm run` for legacy compatibility scripts

### 8.3 Testing

- **Prefer Bun's built-in test runner**
    - ✅ `bun test`
    - ✅ `bun test:chains` (for specific test suites)

---

**Note:** These guidelines are automatically extracted from the project's ESLint configuration and adapted for Bun-first development. When in doubt, run `bun run lint` to check compliance with these rules. Use `bun run lint:fix` to automatically fix formatting issues.
