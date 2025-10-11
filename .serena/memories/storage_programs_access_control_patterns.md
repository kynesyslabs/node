# Storage Programs Access Control Patterns

## Access Control Implementation

### RPC Endpoint Security
**File**: `src/libs/network/manageNodeCall.ts`

```typescript
// Caller authentication required
if (!sender) {
    response.result = 401
    response.response = { error: "Caller address required for storage access" }
    break
}

// Access control validation
const accessCheck = validateStorageProgramAccess(
    "READ_STORAGE",
    sender,
    storageProgram.data,
)

if (!accessCheck.success) {
    response.result = 403
    response.response = { error: accessCheck.error || "Access denied" }
    break
}
```

### Access Control Modes

**private / deployer-only**:
- Only deployer can read and write
- Most restrictive mode

**public**:
- Anyone can read
- Only deployer can write
- Good for public datasets

**restricted**:
- Only deployer or allowlisted addresses
- Configured via allowedAddresses array
- Good for shared team storage

### Validator Logic
**File**: `src/libs/blockchain/validators/validateStorageProgramAccess.ts`

```typescript
const isDeployer = requestingAddress === deployer

// Admin operations always require deployer
if (operation === "UPDATE_ACCESS_CONTROL" || operation === "DELETE_STORAGE_PROGRAM") {
    return isDeployer ? { success: true } : { success: false, error: "..." }
}

// Mode-specific rules
switch (accessControl) {
    case "private":
    case "deployer-only":
        return isDeployer ? { success: true } : { success: false }
    
    case "public":
        if (operation === "READ_STORAGE") return { success: true }
        if (operation === "WRITE_STORAGE") {
            return isDeployer ? { success: true } : { success: false }
        }
    
    case "restricted":
        if (isDeployer || allowedAddresses.includes(requestingAddress)) {
            return { success: true }
        }
        return { success: false }
}
```

### Authentication Flow

1. **RPC Request** → Headers contain `"identity"` field
2. **Server Validation** → `validateHeaders()` verifies signature
3. **Extract Sender** → `sender = headers.get("identity")`
4. **Pass to Handler** → `manageNodeCall(payload, sender)`
5. **Enforce Access** → `validateStorageProgramAccess(operation, sender, data)`
6. **Return 403/401** → Appropriate error without data leakage

### Security Considerations

**Never leak data on denial**:
```typescript
// ✅ Good - no data in error response
response.response = { error: "Access denied" }

// ❌ Bad - leaks metadata
response.response = { error: "Access denied", metadata: program.metadata }
```

**Always validate sender**:
```typescript
// ✅ Good - check sender exists
if (!sender) return 401

// ❌ Bad - assume sender exists
const accessCheck = validateStorageProgramAccess(operation, sender, data)
```

## Integration Points

### Transaction Handler
**File**: `src/libs/network/routines/transactions/handleStorageProgramTransaction.ts`

- Queues GCR edits with sender context
- Access validation happens in HandleGCR.applyStorageProgramEdit()
- Sender included in context for deferred validation

### GCR Handler
**File**: `src/libs/blockchain/gcr/handleGCR.ts`

- Receives sender from transaction context
- Validates access before applying edits
- Returns error if access denied
- No state changes on validation failure
