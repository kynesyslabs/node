# TypeScript Type Check Report

**Date**: 2025-12-16
**Command**: `bun run type-check-ts` (`tsc --noEmit`)

## Summary

| Metric | Value |
|--------|-------|
| **Total Errors** | 120 |
| **Affected Files** | 38 |
| **Most Common Error** | TS2345 (64 occurrences) |

## Configuration Changes Made

Updated `tsconfig.json` to exclude the same directories as ESLint:

```json
"exclude": [
    "node_modules",
    "diagrams",
    "data",
    "dist",
    ".github",
    ".vscode",
    "postgres_*",
    "aptos_examples_ts",
    "local_tests",
    "aptos_tests",
    "omniprotocol_fixtures_scripts",
    "sdk",
    "tests"
]
```

## Fixed Issues

- **Fixed**: Direct import from `../sdks/` in `src/features/InstantMessagingProtocol/signalingServer/types/IMMessage.ts`
  - Changed from: `import { SerializedSignedObject } from "../../../../../../sdks/src/encryption/unifiedCrypto"`
  - Changed to: `import { SerializedSignedObject } from "@kynesyslabs/demosdk/types"`

## Errors by File (Top 20)

| Count | File |
|-------|------|
| 15 | `src/libs/omniprotocol/protocol/handlers/sync.ts` |
| 15 | `src/libs/omniprotocol/protocol/handlers/meta.ts` |
| 11 | `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts` |
| 8 | `src/libs/omniprotocol/transport/TLSConnection.ts` |
| 7 | `src/libs/utils/calibrateTime.ts` |
| 6 | `src/features/fhe/fhe_test.ts` |
| 5 | `src/libs/omniprotocol/integration/startup.ts` |
| 4 | `src/libs/omniprotocol/protocol/handlers/transaction.ts` |
| 3 | `src/tests/transactionTester.ts` |
| 3 | `src/libs/omniprotocol/tls/certificates.ts` |
| 3 | `src/libs/omniprotocol/protocol/handlers/gcr.ts` |
| 3 | `src/features/multichain/routines/executors/aptos_contract_write.ts` |
| 3 | `src/features/multichain/routines/executors/aptos_contract_read.ts` |
| 2 | `src/libs/network/routines/transactions/handleWeb2ProxyRequest.ts` |
| 2 | `src/libs/network/routines/transactions/handleIdentityRequest.ts` |
| 2 | `src/libs/network/manageNativeBridge.ts` |
| 2 | `src/libs/crypto/cryptography.ts` |
| 2 | `src/libs/blockchain/routines/executeNativeTransaction.ts` |
| 2 | `src/features/web2/proxy/Proxy.ts` |
| 2 | `src/features/web2/dahr/DAHR.ts` |

## Errors by Type

| Count | Error Code | Description |
|-------|------------|-------------|
| 64 | TS2345 | Argument type mismatch - wrong type passed to function parameter |
| 26 | TS2339 | Property does not exist on type |
| 7 | TS2341 | Property is private and only accessible within class |
| 6 | TS2554 | Expected X arguments, but got Y |
| 5 | TS2322 | Type not assignable to target type |
| 3 | TS2724 | Module has no exported member (wrong name) |
| 2 | TS2551 | Property does not exist, did you mean...? |
| 2 | TS2305 | Module has no exported member |
| 1 | TS2552 | Cannot find name, did you mean...? |
| 1 | TS2415 | Class incorrectly extends base class |
| 1 | TS2367 | Unintentional comparison (no type overlap) |
| 1 | TS2353 | Object literal may only specify known properties |
| 1 | TS2307 | Cannot find module |

## Error Categories Analysis

### 1. Logger Migration Issues (TS2345) - ~50 errors
Many errors are related to `log.info/debug/warning/error` calls passing wrong argument types.
- **Pattern**: Passing `unknown`, `number`, `string`, `Error` where `boolean` is expected
- **Root Cause**: Logger function signature expects `(message: string, isDebug?: boolean)` but code passes data objects
- **Affected Files**: Most files with logger calls

### 2. OmniProtocol Handler Type Issues - ~40 errors
- `sync.ts`, `meta.ts`, `gcr.ts`, `transaction.ts` handlers have type issues
- **Pattern**: `unknown` type not assignable to `Buffer`, missing `.length` property
- **Root Cause**: Payload types not properly typed from dispatch

### 3. TLSConnection Class Issues (TS2341, TS2415) - 8 errors
- `TLSConnection` incorrectly extends `PeerConnection`
- Private properties (`setState`, `socket`, `peerIdentity`) access issues
- **Fix needed**: Change `private` to `protected` in `PeerConnection` base class

### 4. Deprecated Crypto Methods (TS2551) - 2 errors
- `crypto.createCipher` and `crypto.createDecipher` are deprecated
- Should use `createCipheriv` and `createDecipheriv` instead
- **Affected**: `src/libs/crypto/cryptography.ts`

### 5. SDK Type Mismatches (TS2724, TS2305) - 5 errors
- `EncryptedTransaction` not exported from `@kynesyslabs/demosdk/types`
- `SubnetPayload` not exported from `@kynesyslabs/demosdk/l2ps`
- **Fix needed**: Update SDK or adjust imports

### 6. Miscellaneous Issues
- `src/utilities/tui/TUIManager.ts`: `"CMD"` not in `LogCategory` type
- `src/libs/network/index.ts`: Missing default export from `server_rpc`
- `src/libs/omniprotocol/auth/parser.ts`: `bigint` not assignable to `number`

## Priority Recommendations

### High Priority (Breaks Functionality)
1. Fix `TLSConnection` class inheritance (change `private` → `protected`)
2. Fix deprecated crypto methods in `cryptography.ts`
3. Update SDK imports for `EncryptedTransaction`, `SubnetPayload`

### Medium Priority (Type Safety)
1. Add proper typing to OmniProtocol handler payloads
2. Fix logger call signatures across codebase
3. Add `"CMD"` to `LogCategory` type

### Low Priority (Minor Issues)
1. Fix test file types (`src/tests/`)
2. Address `fhe_test.ts` argument count issues
