# Testing Patterns

**Analysis Date:** 2026-02-22

## Framework

- Jest (`devDependencies.jest`: `^29.7.0`)
- TypeScript transform via `ts-jest` (`^29.3.2`)
- Config: `jest.config.ts`

## How to run

```bash
bun run test:chains
```

Script (from `package.json`):
- `jest --testMatch '**/tests/**/*.ts' --testPathIgnorePatterns src/* tests/utils/* tests/**/_template*  --verbose`

## Test layout

**Primary test folder**
- `tests/` (repo root)

**Fixtures**
- JSON fixtures under `fixtures/` (used by tests)

**Mocks**
- SDK mocks under `tests/mocks/` (notably `@kynesyslabs/demosdk/*` remaps)
- Jest moduleNameMapper entries in `jest.config.ts` point to these mock files

## Common patterns

- Tests often mock Demos SDK modules before importing code that depends on them (see `tests/mocks/` and `jest.config.ts`)
- Long-running tests: Jest timeout is increased (`testTimeout: 20_000` in `jest.config.ts`)

