# Storage Programs Implementation Phases

## Phase Overview
8-phase implementation plan for Storage Programs feature with complete code snippets and validation steps.

## Phase 1: Database Schema & Core Types
**Duration**: 2-3 days
**Repository**: node + ../sdks

### Tasks:
1. Create TypeORM migration for `data` JSONB column
2. Update GCR_Main entity with new column
3. Create SDK TypeScript types for StorageProgram transactions
4. Add `StorageProgramTransaction` to SDK exports

### Key Files:
- Migration: `src/model/migrations/{timestamp}-AddStorageProgramDataColumn.ts`
- Entity: `src/model/entities/GCRv2/GCR_Main.ts`
- SDK Type: `../sdks/src/types/blockchain/TransactionSubtypes/StorageProgramTransaction.ts`

### Validation:
```bash
bun run typeorm migration:run
bun run typecheck
```

## Phase 2: Node Handler Infrastructure
**Duration**: 3-4 days
**Repository**: node

### Tasks:
1. Create `handleStorageProgramTransaction.ts` handler
2. Implement access control validator
3. Implement size validator
4. Create operation-specific logic (CREATE, WRITE, UPDATE, DELETE)

### Key Files:
- Handler: `src/libs/network/routines/transactions/handleStorageProgramTransaction.ts`
- Validator: `src/libs/blockchain/validators/validateStorageProgramAccess.ts`
- Size Validator: `src/libs/blockchain/validators/validateStorageProgramSize.ts`

### Validation:
```bash
bun run lint:fix
bun test src/libs/network/routines/transactions/handleStorageProgramTransaction.test.ts
```

## Phase 3: HandleGCR Integration
**Duration**: 2 days
**Repository**: node

### Tasks:
1. Add `storageProgram` case to HandleGCR.apply()
2. Implement GCR edit application for storage operations
3. Add transaction validation

### Key Files:
- `src/libs/blockchain/gcr/handleGCR.ts`

### Key Code Pattern:
```typescript
case 'storageProgram':
    const storageProgramPayload = edit.context as StorageProgramContext
    await this.applyStorageProgramEdit(edit, storageProgramPayload)
    break
```

### Validation:
```bash
bun test src/libs/blockchain/gcr/handleGCR.test.ts
```

## Phase 4: Endpoint Integration
**Duration**: 1 day
**Repository**: node

### Tasks:
1. Add `storageProgram` case to endpointHandlers.ts switch
2. Route transactions to handleStorageProgramTransaction
3. Test transaction flow end-to-end

### Key Files:
- `src/libs/network/endpointHandlers.ts`

### Key Code Pattern:
```typescript
case "storageProgram":
    payload = tx.content.data
    const storageProgramResult = await handleStorageProgramTransaction(
        payload[1] as StorageProgramPayload,
        tx.content.from,
        tx.hash
    )
    break
```

### Validation:
```bash
bun run lint:fix
# Submit test transaction via RPC
```

## Phase 5: SDK Implementation
**Duration**: 3-4 days
**Repository**: ../sdks

### Tasks:
1. Create `StorageProgram` class with methods
2. Implement address derivation helper
3. Implement all CRUD methods
4. Add TypeScript type exports

### Key Methods:
- `createStorageProgram()`
- `writeStorage()`
- `readStorage()`
- `updateAccessControl()`
- `deleteStorageProgram()`
- `deriveStorageAddress()` (static helper)

### Key Files:
- Class: `../sdks/src/classes/StorageProgram.ts`
- Export: `../sdks/src/index.ts`

### Validation:
```bash
cd ../sdks
bun run typecheck
bun run build
bun test src/classes/StorageProgram.test.ts
```

## Phase 6: RPC Endpoints
**Duration**: 2 days
**Repository**: node

### Tasks:
1. Add query endpoints for reading storage programs
2. Implement filtering and pagination
3. Add error handling for missing programs

### Key Endpoints:
- `GET /storage-program/:address`
- `GET /storage-variable/:address/:key`
- `GET /storage-programs/deployer/:address`

### Key Files:
- `src/libs/network/rpc/storageProgram.ts`
- `src/libs/network/rpc/index.ts`

### Validation:
```bash
curl http://localhost:3000/storage-program/stor-abc123...
```

## Phase 7: Testing & Documentation
**Duration**: 3-4 days
**Repository**: node + ../sdks

### Tasks:
1. Write unit tests for all validators and handlers
2. Write integration tests for transaction flow
3. Write E2E tests with SDK methods
4. Update documentation
5. Create usage examples

### Test Files:
- `src/libs/network/routines/transactions/handleStorageProgramTransaction.test.ts`
- `src/libs/blockchain/validators/validateStorageProgramAccess.test.ts`
- `src/libs/blockchain/validators/validateStorageProgramSize.test.ts`
- `../sdks/src/classes/StorageProgram.test.ts`
- `tests/e2e/storageProgram.test.ts`

### Documentation:
- Update `../sdks/storageTx.md`
- Create `../sdks/storageProgramTx.md`
- Add examples to README

### Validation:
```bash
bun test
# Coverage should be >80% for new code
```

## Phase 8: Deployment & Migration
**Duration**: 2-3 days
**Repository**: node

### Tasks:
1. Deploy to testnet
2. Run migration on testnet database
3. Test with real transactions
4. Monitor for issues
5. Deploy to mainnet after validation period

### Deployment Checklist:
- [ ] Migration tested on testnet
- [ ] All tests passing
- [ ] Documentation complete
- [ ] Security review complete
- [ ] Performance tests passed
- [ ] Rollback plan documented

### Migration Command:
```bash
# Testnet
bun run typeorm migration:run

# Mainnet (after validation)
bun run typeorm migration:run
```

### Rollback Plan:
If issues found, revert migration with:
```bash
bun run typeorm migration:revert
```

## Success Criteria
- ✅ All 8 phases completed
- ✅ All tests passing (>80% coverage)
- ✅ Documentation complete
- ✅ Testnet validation successful
- ✅ Security review approved
- ✅ Performance benchmarks met
- ✅ Mainnet deployment successful

## Notes
- Wait for confirmation between phases
- Add `// REVIEW:` comments for new code
- Use JSDoc format for all methods
- Follow existing transaction patterns
- Test backwards compatibility with existing `storage` type

## Reference
Full specification: `/Users/tcsenpai/kynesys/node/STORAGE_PROGRAMS_SPEC.md`