# Hook System Architecture

## Summary
The hook system allows token scripts to extend native operations (transfer, mint, burn, approve) with custom logic. Hooks can validate, modify, or reject operations and add additional mutations.

## Hook Types
All 8 hook types are supported:
- `beforeTransfer` / `afterTransfer`
- `beforeMint` / `afterMint`
- `beforeBurn` / `afterBurn`
- `beforeApprove` / `afterApprove`

## Key Components

### HookExecutor (`HookExecutor.ts`)
High-level orchestrator for hook execution during native operations.

**Main Method**: `executeWithHooks(request: ExecuteWithHooksRequest): Promise<HookExecutionResult>`

**Execution Flow**:
```text
ExecuteWithHooksRequest
       │
       ▼
1. Execute beforeHook
   ├── If hook throws or returns `reject` → Return `rejection`
   └── If hook returns mutations/setStorage → Update working state
       │
       ▼
2. Apply native operation mutations
       │
       ▼
3. Execute afterHook
   ├── If hook throws or returns `reject` → Return `rejection`
   └── If hook returns mutations/setStorage → Update working state
       │
       ▼
4. Return HookExecutionResult
   ├── finalState: GCRTokenData
   ├── mutations: TokenMutation[]
   ├── rejection: { hookType: string; reason: string } | null
   └── metadata: HookExecutionMetadata
```

### Hook Result Structure
```typescript
interface HookResult {
    reject?: string | boolean
    mutations?: TokenMutation[]
    setStorage?: Record<string, unknown>
}
```

### Hook Rejection
```typescript
interface HookRejection {
    hookType: string
    reason: string
}
```

## Utility Functions

### Native Operation Mutations
- `createTransferMutations(from, to, amount)` → [subBalance, addBalance]
- `createMintMutations(to, amount)` → [addBalance]
- `createBurnMutations(from, amount)` → [subBalance]
- `createApproveMutations(owner, spender, amount)` → [setAllowance]

### Validation Helpers
- `validateSufficientBalance(tokenData, address, amount)`
- `validateSufficientAllowance(tokenData, owner, spender, amount)`

### Merging
- `mergeHookResults(results: HookResult[])` → Single HookResult

## Usage Example
```typescript
const executor = new HookExecutor(scriptExecutor)

const result = await executor.executeWithHooks({
    operation: "transfer",
    operationData: { from: "0x1", to: "0x2", amount: 100n },
    tokenAddress: "0xToken",
    tokenData: currentState,
    scriptCode: tokenScript,
    txContext: { caller, txHash, timestamp, blockHeight, prevBlockHash },
    nativeOperationMutations: createTransferMutations("0x1", "0x2", 100n),
})

if (!result.rejection) {
    // Apply result.finalState to storage
} else {
    // Handle rejection: result.rejection.reason
}
```

## Integration with ScriptExecutor
HookExecutor uses the current `scriptExecutor` implementation in `src/libs/scripting/index.ts`, which executes exported hook functions inside a Node `vm` context with timeouts. This is a determinism-oriented execution model, not a security boundary.

## Error Handling
- Hook errors cancel the operation.
- The current branch does not re-run hook logic during rollback; rollback support is limited to the native reverse paths implemented in `GCRTokenRoutines`.
- Custom-method rollback remains explicitly unsupported and should not be documented as fully restorative.

## Consensus Integration (Phase 5.1)

### GCRTokenRoutines Integration
The hook system is now integrated into the consensus flow through `GCRTokenRoutines`:

**Files Modified**:
- `src/libs/blockchain/gcr/handleGCR.ts` - Passes Transaction to GCRTokenRoutines.apply
- `src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines.ts` - Contains hook integration

**Key Changes**:

1. **GCRTokenRoutines.apply signature updated**:
   ```typescript
   static async apply(
       editOperation: GCREditToken,
       gcrTokenRepository: Repository<GCRToken>,
       simulate: boolean,
       tx?: Transaction,  // New: Transaction context for hook execution
   ): Promise<GCRResult>
   ```

2. **Helper Methods Added**:
   - `getHookExecutor()` - Singleton HookExecutor instance
   - `tokenToGCRTokenData(token)` - Converts GCRToken entity to GCRTokenData interface
   - `applyGCRTokenDataToEntity(token, data)` - Applies mutations back to entity

3. **Handler Integration Pattern**:
   Each handler (transfer, mint, burn) now checks for scripts:
   ```typescript
   if (token.hasScript && token.script?.code && tx && !edit.isRollback) {
       // Use HookExecutor.executeWithHooks()
       // Handle rejection via result.rejection
       // Apply finalState via applyGCRTokenDataToEntity()
   } else {
       // Native operation without hooks
   }
   ```

### Consensus Flow

```text
Transaction submitted
       │
       ▼
PoRBFTv2 Consensus
       │
       ▼
applyGCREditsFromMergedMempool
       │
       ▼
HandleGCR.apply(edit, tx)    ← Now passes tx
       │
       ▼
GCRTokenRoutines.apply(edit, repo, simulate, tx)
       │
       ▼
handleTransferToken / handleMintToken / handleBurnToken
       │
       ├── Token has script? ──Yes──▶ HookExecutor.executeWithHooks()
       │                                    │
       │                              ┌─────┴─────┐
       │                              │           │
       │                        Proceed     Rejection
       │                              │           │
       │                      Apply finalState    │
       │                              │           │
       │                              ▼           ▼
       │                         Save entity   Return failure
       │
       └── No script ───────▶ Native operation
                                    │
                                    ▼
                               Save entity
```

### Determinism Notes
- Consensus-critical hook execution currently uses the Node `vm`-based runtime in `src/libs/scripting/index.ts`, not SES.
- `prevBlockHash` is currently a placeholder value in some paths and is intended to be injected by consensus later.
- `blockHeight` comes from `tx.blockNumber` and may be absent during mempool-side processing.
- `timestamp` is taken from transaction content when available; any `Date.now()` fallback should be treated as non-consensus or pre-consensus behavior, not as a deterministic guarantee.

### Rollback Handling
Script hooks are not executed during rollback. Rollback paths currently reverse only the supported native token effects; script-upgrade payload restoration and opaque custom-method state reversal are tracked separately and are not complete guarantees today.

## Last Updated
2026-02-23 - Phase 5.1 consensus integration complete
