# Testing Patterns

**Analysis Date:** 2026-01-28

## Test Framework

**Runner:**
- Jest v29.7.0
- Config: `jest.config.ts`
- ts-jest preset for TypeScript transformation

**Assertion Library:**
- Jest built-in `expect` API
- Imports from `@jest/globals` (v30.2.0 in devDependencies)

**Run Commands:**
```bash
bun run test:chains         # Run all tests matching tests/**/*.ts
```

The `test:chains` script runs:
```bash
jest --testMatch '**/tests/**/*.ts' --testPathIgnorePatterns src/* tests/utils/* tests/**/_template* --verbose
```

No general `test` script exists. Tests are specifically scoped to `tests/` directory.

## Test File Organization

**Location:**
- Separate `tests/` directory at project root (NOT co-located with source)
- Test subdirectories mirror feature areas: `tests/omniprotocol/`
- Mock files in `tests/mocks/`
- Fixture JSON files in `fixtures/` at project root
- Consensus fixtures in `fixtures/consensus/`

**Naming:**
- Test files: `*.test.ts` (e.g., `handlers.test.ts`, `dispatcher.test.ts`, `consensus.test.ts`)
- Mock files: `demosdk-*.ts` pattern (e.g., `demosdk-encryption.ts`, `demosdk-types.ts`)

**Structure:**
```
tests/
├── mocks/
│   ├── demosdk-abstraction.ts
│   ├── demosdk-build.ts
│   ├── demosdk-encryption.ts
│   ├── demosdk-types.ts
│   ├── demosdk-websdk.ts
│   └── demosdk-xm-localsdk.ts
└── omniprotocol/
    ├── consensus.test.ts
    ├── dispatcher.test.ts
    ├── fixtures.test.ts
    ├── gcr.test.ts
    ├── handlers.test.ts
    ├── peerOmniAdapter.test.ts
    └── transaction.test.ts

fixtures/
├── address_info.json
├── block_header.json
├── consensus/
│   └── *.json (per-method fixtures)
├── last_block_number.json
├── mempool.json
├── peerlist.json
└── peerlist_hash.json
```

## Test Structure

**Suite Organization:**
```typescript
import { beforeAll, describe, expect, it, jest, beforeEach } from "@jest/globals"

// 1. SDK mocks FIRST (before any imports that use them)
jest.mock("@kynesyslabs/demosdk/encryption", () => ({ ... }))
jest.mock("@kynesyslabs/demosdk/build/multichain/core", () => ({ ... }))

// 2. Internal module mocks
jest.mock("src/libs/blockchain/chain", () => ({ ... }))
jest.mock("src/utilities/sharedState", () => ({ ... }))

// 3. Type-only imports (safe before dynamic imports)
import type { HandlerContext } from "src/libs/omniprotocol/types/message"

// 4. Dynamic imports in beforeAll (to respect mock hoisting)
let dispatchOmniMessage: typeof import("...")["dispatchOmniMessage"]

beforeAll(async () => {
    ({ dispatchOmniMessage } = await import("src/libs/omniprotocol/protocol/dispatcher"))
})

// 5. Test suites
describe("Feature Name", () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it("description of behavior", async () => {
        // Arrange → Act → Assert
    })
})
```

**Key Patterns:**
- `jest.mock()` calls placed at the TOP of file, before any imports
- Dynamic `import()` in `beforeAll` to ensure mocks are registered before module loads
- `beforeEach` with `jest.clearAllMocks()` for test isolation
- Descriptive `it()` strings: `"encodes nodeCall response"`, `"handles proto_disconnect without response"`

## Mocking

**Framework:** Jest built-in `jest.mock()` and `jest.fn()`

**SDK Mock Pattern (critical - used in every test file):**
```typescript
// SDK encryption mock - required because SDK has native dependencies
jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    __esModule: true,
    ucrypto: {
        getIdentity: jest.fn(async () => ({
            publicKey: new Uint8Array(32),
            algorithm: "ed25519",
        })),
        sign: jest.fn(async () => ({
            signature: new Uint8Array([1, 2, 3, 4]),
        })),
        verify: jest.fn(async () => true),
    },
    uint8ArrayToHex: jest.fn((input: Uint8Array) =>
        Buffer.from(input).toString("hex"),
    ),
    hexToUint8Array: jest.fn((hex: string) => {
        const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
        return new Uint8Array(Buffer.from(normalized, "hex"))
    }),
}))
```

**Module mock pattern (internal modules):**
```typescript
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlocks: jest.fn(),
        getBlockByHash: jest.fn(),
        getTxByHash: jest.fn(),
    },
}))
```

**Mock retrieval after dynamic import:**
```typescript
let mockedChain: { getBlocks: jest.Mock; getBlockByHash: jest.Mock }

beforeAll(async () => {
    mockedChain = (await import("src/libs/blockchain/chain"))
        .default as { getBlocks: jest.Mock; getBlockByHash: jest.Mock }
})
```

**What to Mock:**
- `@kynesyslabs/demosdk/*` modules (encryption, types, multichain) - always mocked
- Blockchain data layer (`chain`, `mempool_v2`)
- Network routines (`getPeerlist`, `getBlockByNumber`)
- Shared state (`sharedState`)
- Any module with side effects or external dependencies

**What NOT to Mock:**
- Serialization/deserialization functions (tested directly for round-trip correctness)
- Protocol opcodes and enums
- Pure utility functions

**Jest Config Module Mapping (`jest.config.ts`):**
```typescript
moduleNameMapper: {
    "^@kynesyslabs/demosdk/encryption$": "<rootDir>/tests/mocks/demosdk-encryption.ts",
    "^@kynesyslabs/demosdk/types$": "<rootDir>/tests/mocks/demosdk-types.ts",
    "^@kynesyslabs/demosdk/websdk$": "<rootDir>/tests/mocks/demosdk-websdk.ts",
    "^@kynesyslabs/demosdk/xm-localsdk$": "<rootDir>/tests/mocks/demosdk-xm-localsdk.ts",
    "^@kynesyslabs/demosdk/abstraction$": "<rootDir>/tests/mocks/demosdk-abstraction.ts",
    "^@kynesyslabs/demosdk/build/.*$": "<rootDir>/tests/mocks/demosdk-build.ts",
}
```

## Fixtures and Factories

**Test Data - JSON Fixtures:**
```typescript
// Helper function pattern used across test files
const fixture = <T>(name: string): T => {
    const file = path.resolve(__dirname, "../../fixtures", `${name}.json`)
    return JSON.parse(readFileSync(file, "utf8")) as T
}

// Usage
const peerlistFixture = fixture<{ result: number; response: unknown }>("peerlist")
```

**Location:**
- `fixtures/` directory at project root
- `fixtures/consensus/` subdirectory for consensus-specific fixtures
- Each fixture is a JSON file representing captured HTTP responses from the real network

**Factory helpers (inline):**
```typescript
const makeMessage = (opcode: number) => ({
    header: { version: 1, opcode, sequence: 42, payloadLength: 0 },
    payload: null,
    checksum: 0,
})

const makeContext = () => ({
    peerIdentity: "peer",
    connectionId: "conn",
    receivedAt: Date.now(),
    requiresAuth: false,
})
```

## Coverage

**Requirements:** No coverage thresholds enforced
**Coverage tool:** Not configured in jest.config.ts (no `collectCoverage`, no `coverageThreshold`)

## Test Types

**Unit Tests:**
- Serialization round-trip tests (encode -> decode -> compare)
- Handler dispatch tests with mocked dependencies
- Protocol message construction and parsing

**Integration Tests:**
- Handler integration tests that test dispatch through the handler registry
- Fixture-based tests that validate against captured real network data

**E2E Tests:**
- Not present. Per project guidelines: "NEVER start the node directly during development or testing"
- ESLint validation (`bun run lint:fix`) is the primary code correctness check

## Common Patterns

**Async Testing:**
```typescript
it("encodes nodeCall response", async () => {
    mockedManageNodeCall.mockResolvedValue(response)

    const buffer = await dispatchOmniMessage({ ... })

    expect(mockedManageNodeCall).toHaveBeenCalledWith({ ... })
    const decoded = decodeNodeCallResponse(buffer)
    expect(decoded.status).toBe(200)
})
```

**Round-Trip Encoding Tests:**
```typescript
it("should encode and decode without data loss", () => {
    const original = { ... }
    const encoded = encodeJsonRequest(original)
    expect(encoded).toBeInstanceOf(Buffer)

    const decoded = decodeJsonRequest<typeof original>(encoded)
    expect(decoded).toEqual(original)
})
```

**Fixture-Driven Tests:**
```typescript
fixtures.forEach(fixtureFile => {
    it(`should decode and encode ${fixtureFile} correctly`, () => {
        const fixture = loadConsensusFixture(fixtureFile)
        // encode -> decode -> compare against fixture
    })
})
```

**Error Testing:**
```typescript
it("throws UnknownOpcodeError for unregistered opcode", async () => {
    await expect(
        dispatchOmniMessage({ message: makeMessage(0xffff), ... })
    ).rejects.toThrow(UnknownOpcodeError)
})
```

## Test Configuration Notes

- `testTimeout: 20_000` (20 seconds) - tests involving ledger lookups need this
- `isolatedModules: true` in ts-jest transform options
- Tests excluded from TypeScript compilation in `tsconfig.json` (`"exclude": ["tests", "src/tests"]`)
- `src/tests/` directory exists but contains a manual `transactionTester.ts` utility (not Jest tests)

## Adding New Tests

**New test file:**
- Place in `tests/<feature-area>/<name>.test.ts`
- Copy the SDK mock boilerplate from an existing test file
- Use `beforeAll` with dynamic imports for modules that depend on mocked dependencies
- Add JSON fixtures to `fixtures/` if testing against real data shapes

**New mock file:**
- Place in `tests/mocks/demosdk-<module>.ts`
- Register in `jest.config.ts` `moduleNameMapper` if it replaces an SDK module

---

*Testing analysis: 2026-01-28*
