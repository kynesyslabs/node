# Token Scripting - View Functions

## Summary
View functions are read-only script methods that allow querying token state without producing mutations. They are called via nodeCall (no consensus needed) and return computed values directly.

## Architecture

### ScriptExecutor.executeView()
High-level orchestration for view function execution:
- Builds token accessor from GCR data
- Gets script code from token data
- Delegates to TokenSandbox.executeView()
- Returns ViewResult with value or error

### TokenSandbox.executeView()
Low-level SES execution for view functions:
- Creates read-only endowments (token, Math, JSON, console, BigInt)
- Evaluates script code in SES compartment
- Calls specified method with provided arguments
- Validates result does NOT contain mutations
- Returns computed value or rejects with error

### Mutation Rejection
View functions MUST NOT return mutations:
- containsMutations() recursively checks result
- isMutationLike() detects mutation objects
- If mutations found: returns ViewError with errorType="mutation_rejected"

## Types

### ViewResult
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

### ExecuteViewRequest
```typescript
interface ExecuteViewRequest {
    tokenAddress: string
    method: string
    args: unknown[]
    tokenData: GCRTokenData
    config?: Partial<SandboxConfig>
}
```

## Usage

### From ScriptExecutor
```typescript
const result = await scriptExecutor.executeView({
    tokenAddress: "0x...",
    method: "getCustomData",
    args: ["some-key"],
    tokenData: gcrTokenData
})

if (result.success) {
    console.log(result.value) // Computed value
} else {
    console.error(result.error, result.errorType)
}
```

### Example View Functions
```javascript
// In token script:

// Read custom storage
function getCustomData(key) {
    return token.storage[key]
}

// Compute reward based on balance
function computeReward(address) {
    const balance = token.balanceOf(address)
    return balance * 0.05 // 5% annual reward
}

// Check if user can perform action
function canTransfer(from, amount) {
    return token.balanceOf(from) >= amount && !token.paused
}
```

## Key Differences from executeMethod()

| Aspect | executeMethod() | executeView() |
|--------|----------------|---------------|
| Consensus | Required | Not required |
| Mutations | Allowed | Rejected |
| Call path | Transaction → Consensus | nodeCall → Direct |
| Randomness | Deterministic (block+tx) | Simple seed |
| Endowments | Full (context, token, Math, Date) | Minimal (token, Math, JSON, console, BigInt) |

## Security

### Read-Only Guarantee
View functions cannot:
- Modify token state
- Return mutations
- Access transaction context (no caller, txHash, blockHeight)

### Determinism Not Required
Since view functions don't participate in consensus:
- Simple random seed (not blockchain-derived)
- No need for deterministic timestamps
- Can be called at any time without coordination

## Integration Points

### Phase 3.2: nodeCall Handler
```typescript
// In manageNodeCall.ts:
case "tokenViewCall":
    const { tokenAddress, method, args } = params
    const tokenData = await getTokenFromGCR(tokenAddress)
    const result = await scriptExecutor.executeView({
        tokenAddress,
        method,
        args,
        tokenData
    })
    return result
```

### Phase 3.3: SDK Wrapper
```typescript
// In SDK:
demos.tokens.view(tokenAddress, method, args)
// → nodeCall("tokenViewCall", { tokenAddress, method, args })
```

## Related
- ScriptExecutor: High-level orchestration
- TokenSandbox: Low-level execution
- types.ts: Type definitions
- Phase 3.1 acceptance criteria

## Last Updated
2026-02-23 - Initial implementation of view function system
