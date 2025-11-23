# Rate Limiter RPC Method Extraction - Enhancement Needed

## Current State

**File**: `src/libs/network/middleware/rateLimiter.ts`
**Lines**: 202-230 (getMethodFromRequest method)

### Current Behavior
```typescript
private getMethodFromRequest(req: Request): string | null {
    // Works for GET requests with path mapping
    const pathMethodMap: Record<string, string> = {
        "/info": "info",
        "/version": "version",
        // ... etc
    }
    
    // For POST requests to root, we can't easily peek at the body
    // without consuming it, so we'll use default limits
    return "POST"  // ← Problem: All POST requests use generic limit
}
```

### Impact
- Escrow rate limits configured in `sharedState.ts` (lines 249-251) are NOT enforced
- All POST RPC calls fall under generic POST limit (200K/day)
- Method-specific limits like `escrow_deposit: 10/min` are ignored

## Escrow RPC Endpoints (Verified Existing)

**File**: `src/libs/network/server_rpc.ts`

1. `get_escrow_balance` (line 308)
2. `get_claimable_escrows` (line 335)  
3. `get_sent_escrows` (line 362)

These are **query** endpoints. The transaction creation endpoints (deposit, claim, refund) will be added when Phase 4 is completed.

## Required Enhancement

### Solution: Parse POST Body for RPC Method

```typescript
private async getMethodFromRequest(req: Request): Promise<string | null> {
    try {
        const url = new URL(req.url)
        const path = url.pathname
        
        // Handle GET requests (existing logic)
        if (req.method === "GET" && pathMethodMap[path]) {
            return pathMethodMap[path]
        }
        
        // NEW: Handle POST RPC requests
        if (req.method === "POST") {
            try {
                // Clone request to avoid consuming body
                const clonedReq = req.clone()
                const body = await clonedReq.json()
                
                // Extract RPC method from payload
                if (body && typeof body.method === "string") {
                    return body.method  // Returns: "escrow_deposit", "get_escrow_balance", etc.
                }
            } catch {
                // Body parsing failed, use default
            }
        }
        
        return "POST"
    } catch {
        return "POST"
    }
}
```

### Key Changes
1. **Use `req.clone()`**: Prevents consuming original request body
2. **Parse JSON body**: Extract `method` field from RPC payload
3. **Fallback gracefully**: Return "POST" if parsing fails
4. **Async method**: Change signature to return `Promise<string | null>`

### Downstream Updates Required

**Line 280**: Update method call to await
```typescript
// Before
const method = this.getMethodFromRequest(req)

// After  
const method = await this.getMethodFromRequest(req)
```

**Line 237**: Update getLimitForMethod
```typescript
// No changes needed - already accepts method string
return this.config.methodLimits[method] || this.config.defaultLimit
```

## Testing Plan

### Test Cases
1. **GET requests**: Verify path mapping still works
2. **POST RPC calls**: Verify method extraction works
   - Test with `{ method: "escrow_deposit", params: [...] }`
   - Test with `{ method: "get_escrow_balance", params: [...] }`
3. **Malformed POST**: Verify fallback to "POST"
   - Invalid JSON
   - Missing method field
   - Non-string method value
4. **Rate limit enforcement**: Verify escrow limits applied
   - 11th deposit in 1 minute → blocked
   - 6th claim in 1 minute → blocked

### Performance Validation
- Measure latency impact of `req.clone()` and JSON parsing
- Should be <5ms overhead per request
- Acceptable for security benefit

## Priority

**High Priority** - This is blocking enforcement of escrow DoS protection.

Without this enhancement:
- ❌ Escrow operations can be spammed at 200K/day rate
- ❌ DoS attacks via deposit/claim flooding not prevented
- ✅ Generic POST limit provides some protection (but insufficient)

With this enhancement:
- ✅ Escrow deposit limited to 10/minute per IP
- ✅ Escrow claim/refund limited to 5/minute per IP  
- ✅ DoS attack surface significantly reduced

## Implementation Effort

**Estimated**: 30 minutes
- 15 min: Implement method extraction logic
- 10 min: Update downstream async calls
- 5 min: Test and validate

**Risk**: Low
- Non-breaking change (fallback to existing behavior)
- Well-isolated change in single method
- Easy to test and verify
