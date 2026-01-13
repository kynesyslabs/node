# StoragePrograms Feature Plan

## Summary
Unified storage solution for Demos Network supporting both JSON (structured) and Binary (raw) data with robust ACL and size-based pricing.

## Design Decision
Single unified StorageProgram with `encoding: "json" | "binary"` parameter. Both encodings share identical features.

## Core Specifications

### Limits & Pricing
- **Max Size**: 1MB (1,048,576 bytes) for both encodings
- **Pricing**: 1 DEM per 10KB (minimum 1 DEM)
- **JSON Nesting**: Max 64 levels depth

### Access Control (ACL)
```typescript
interface StorageProgramACL {
    mode: "owner" | "public" | "restricted"
    owner: string                    // Always has full access
    allowed?: string[]               // Explicitly allowed addresses
    blacklisted?: string[]           // Blocked (highest priority)
    groups?: Record<string, {
        members: string[]
        permissions: ("read" | "write" | "delete")[]
    }>
}
```

**ACL Resolution Priority**:
1. Owner → FULL ACCESS (always)
2. Blacklisted → DENIED (even if in allowed/groups)
3. Allowed → permissions granted
4. Groups → check group permissions
5. Mode fallback: owner/restricted → DENIED, public → READ only

### Operations
- CREATE_STORAGE_PROGRAM
- WRITE_STORAGE
- READ_STORAGE
- UPDATE_ACCESS_CONTROL
- DELETE_STORAGE_PROGRAM

### Storage
- **Location**: On-chain (PostgreSQL) initially
- **IPFS**: Stubs ready for future hybrid storage
- **Retention**: Permanent, owner/ACL-deletable only
- **Legacy**: Old Storage transactions kept for retrocompatibility

## Key Files

### SDK (../sdks)
- `src/types/blockchain/TransactionSubtypes/StorageProgramTransaction.ts` - Types
- `src/storage/StorageProgram.ts` - Main class

### Node
- `src/model/entities/GCRv2/GCR_StorageProgram.ts` - Entity (new)
- `src/libs/blockchain/gcr/handleGCR.ts` - Handler implementation
- Confirm flow validation in transaction handlers

## Database Schema
```sql
CREATE TABLE gcr_storage_programs (
    "storageAddress" TEXT PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "programName" TEXT NOT NULL,
    "encoding" TEXT NOT NULL,  -- 'json' | 'binary'
    "data" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "acl" JSONB NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "storageLocation" TEXT DEFAULT 'onchain',
    "ipfsCid" TEXT,  -- STUB for future
    "salt" TEXT DEFAULT '',
    "createdByTx" TEXT NOT NULL,
    "lastModifiedByTx" TEXT NOT NULL,
    "totalFeesPaid" BIGINT NOT NULL,
    "createdAt" TIMESTAMP,
    "updatedAt" TIMESTAMP
);
```

## Implementation Guidelines
- **Elegant**: Clean, readable code following existing patterns
- **Maintainable**: Well-documented, consistent with codebase style
- **No overengineering**: Simple solutions, YAGNI principle
- **Use existing patterns**: Follow TLSNotary, IPFS handler patterns

## Related
- feature_ipfs_transactions (similar pricing model)
- arch_gcr_entities (entity patterns)
- Legacy StorageTransaction.ts (retrocompat)

## SDK Workflow Reminder

**CRITICAL**: After ANY changes to `../sdks`:
1. Run `bun run build` in ../sdks
2. Commit changes
3. Push to remote
4. **STOP AND TELL USER TO PUBLISH NEW VERSION** before continuing with node work

This ensures the node can use the updated SDK types.

## Last Updated
2026-01-13 - Initial planning document
