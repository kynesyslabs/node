# Token Scripting System - Phase 5.2: Custom Script Methods

## Summary

Phase 5.2 implements custom script methods, allowing token scripts to define arbitrary callable functions beyond native operations (like `stake()`, `claimRewards()`, `vote()`).

## Components Implemented

### 1. GCREditTokenCustom Type
**File**: `src/libs/blockchain/gcr/types/token/GCREditToken.ts`

```typescript
export interface GCREditTokenCustom extends GCREditTokenBase {
    operation: "custom"
    data: {
        method: string        // Custom method name
        params: unknown[]     // Method arguments
    }
}
```

### 2. handleCustomMethod in GCRTokenRoutines
**File**: `src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines.ts`

Handles the "custom" operation case in `applyTokenEdit()`:
- Validates method exists in token script
- Verifies method is a write operation (`mutates: true`)
- Builds execution context with BlockContext
- Executes via `scriptExecutor.executeMethod()`
- Applies returned mutations via `applyMutations()`
- Handles discriminated union `ScriptResult` with explicit type extraction

Key patterns used:
```typescript
// Method validation
const methodDef = script.methods.find(m => m.name === method)
if (!methodDef.mutates) { /* reject view-only methods */ }

// SharedState access (getter, not function)
const sharedState = getSharedState

// BlockContext construction
const blockContext = {
    height: sharedState.lastBlockNumber ?? 0,
    prevBlockHash: sharedState.lastBlockHash ?? "0".repeat(64),
    timestamp: tx?.content?.timestamp ?? Date.now(),
}

// Discriminated union handling
if (!result.success) {
    const errorResult = result as Extract<typeof result, { success: false }>
    // Use errorResult.error
}
```

### 3. token.callView RPC Handler
**File**: `src/libs/network/manageNodeCall.ts`

Implements the `token.callView` nodeCall for executing view (read-only) methods:
- Validates token exists and has a script
- Builds `tokenData` from token entity
- Calls `scriptExecutor.executeView()`
- Returns `ViewResult` with value or error

### 4. Documentation Updates
**File**: `src/libs/scripting/README.md`

Added:
- Custom Script Methods section with examples
- View function RPC examples
- Custom method execution flow diagram
- Method types table (write vs view)

## Type Definitions

### TokenScriptMethod
```typescript
interface TokenScriptMethod {
    name: string
    params: string[]
    returns?: string
    mutates: boolean  // true = write method, false = view method
}
```

### ExecuteMethodRequest
```typescript
interface ExecuteMethodRequest {
    tokenAddress: string
    method: string
    args: unknown[]
    caller: string
    blockContext: BlockContext
    txHash: string
    tokenData: GCRTokenData
    config?: Partial<SandboxConfig>
}
```

### ScriptResult (Discriminated Union)
```typescript
type ScriptResult = ScriptSuccess | ScriptError

interface ScriptSuccess {
    success: true
    mutations: StateMutation[]
    returnValue?: unknown
    executionTimeMs: number
    gasUsed: number
}

interface ScriptError {
    success: false
    error: string
    stack?: string
    executionTimeMs: number
    gasUsed: number
}
```

### ViewResult (Discriminated Union)
```typescript
type ViewResult = ViewSuccess | ViewError

interface ViewSuccess {
    success: true
    value: unknown
    executionTimeMs: number
    gasUsed: number
}

interface ViewError {
    success: false
    error: string
    errorType: "method_not_found" | "execution_error" | "mutation_rejected" | "timeout"
    stack?: string
    executionTimeMs: number
    gasUsed: number
}
```

## Execution Flows

### Write Method (via Transaction)
```
SDK: demos.tokens.custom({ method: "stake", params: [...] })
  │
  ▼
Transaction: type="tokenExecution", operation="custom"
  │
  ▼
GCRTokenRoutines.applyTokenEdit(case: "custom")
  │
  ├── Validate method exists and mutates=true
  ├── Build BlockContext from sharedState
  ├── scriptExecutor.executeMethod()
  ├── applyMutations() to get newState
  └── Save token entity
```

### View Method (via RPC)
```
SDK: rpc.nodeCall("token.callView", { method: "getStakingInfo", ... })
  │
  ▼
manageNodeCall(case: "token.callView")
  │
  ├── Validate token has script
  ├── Build tokenData from entity
  ├── scriptExecutor.executeView()
  └── Return { value, executionTimeMs, gasUsed }
```

## Files Modified

- `src/libs/blockchain/gcr/types/token/GCREditToken.ts` - Added GCREditTokenCustom
- `src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines.ts` - Added handleCustomMethod
- `src/libs/network/manageNodeCall.ts` - Implemented token.callView
- `src/libs/scripting/README.md` - Documentation updates

## Related Memories

- `feature_scripting_system_overview` - Phase 1 overview
- `feature_scripting_system_phase2` - Phase 2 sandbox/executor
- `feature_scripting_validation_rules` - Validation rules
- `feature_scripting_view_functions` - View function details
