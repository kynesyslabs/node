# Coding Conventions

**Analysis Date:** 2026-02-22

## Formatting

**Prettier**
- Config: `.prettierrc`
- Key settings:
  - `tabWidth: 4`
  - `semi: false`
  - `singleQuote: false`
  - `printWidth: 80`
  - `trailingComma: "all"`

## Linting

**ESLint**
- Config: `.eslintrc.cjs`
- Parser: `@typescript-eslint/parser`
- Extends: `eslint:recommended`, `plugin:@typescript-eslint/recommended`
- Notable rules:
  - Double quotes required: `quotes: ["error", "double"]`
  - No semicolons: `semi: ["error", "never"]`
  - `no-console` is `warn` globally, but overridden to `off` for many CLI/test/TUI paths and `src/index.ts`
  - `@typescript-eslint/no-explicit-any` is `off` (so `any` is common)
  - `no-unused-vars` is `off`

## Naming

**ESLint naming convention**
- Variables: `camelCase` or `UPPER_CASE`, underscores allowed
- Types/classes/interfaces: `PascalCase`
- Interfaces must NOT start with `I` (rule rejects `^I[A-Z]`)

**Observed patterns**
- Files are typically `camelCase.ts` for modules and `PascalCase.ts` for entity/class-like files under `src/model/entities/`

## Imports & Paths

**TS path alias**
- `@/*` → `src/*` (`tsconfig.json`)
- Code uses both `@/` and `src/...` absolute-ish imports (e.g. `import log from "@/utilities/logger"` and `import log from "src/utilities/logger"`)

**Module system**
- ESM repo (`package.json` `"type": "module"`)
- TS uses `"moduleResolution": "bundler"`; prefer explicit file extensions when needed in runtime JS (`.js` in some entity imports)

## Logging

- Prefer categorized logger over raw `console.*` in core code:
  - `src/utilities/logger`
  - TUI components under `src/utilities/tui/` may still use console (ESLint override)

## Configuration

- Env loading: `dotenv.config()` in `src/index.ts`
- Example env files: `.env.example`, `env.example`

