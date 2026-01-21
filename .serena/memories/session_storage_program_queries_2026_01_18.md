# Session: Storage Program Query Methods - 2026-01-18

## Summary

Fixed SDK storage program query methods to work without authentication and resolved address format normalization issue.

## Work Completed

### 1. Unauthenticated Storage Program Queries

**Problem**: SDK storage program queries (`getByAddress`, `getByOwner`, `searchByName`) were returning null/empty because `gcr_routine` requires authentication headers.

**Solution**:

- Added storage program query methods to `manageNodeCall.ts` (unauthenticated endpoint)
- Updated SDK `StorageProgram.ts` to use `nodeCall` instead of `gcr_routine`

**Files Modified**:

- `src/libs/network/manageNodeCall.ts` - Added 3 new cases: `getStorageProgram`, `getStorageProgramsByOwner`, `searchStoragePrograms`
- `../sdks/src/storage/StorageProgram.ts` - Changed from `gcr_routine` to `nodeCall`

### 2. createdByTx Field Population

**Problem**: `createdByTx` field in `GCRStorageProgram` entity was not being populated during transaction processing.

**Root Cause**: In `endpointHandlers.ts:109`, `gcredit.txhash = ""` is set during validation for hash comparison, but never restored.

**Solution**: Added `edit.txhash = tx.hash` in `handleGCR.ts` `applyToTx()` method before applying edits.

**File Modified**:

- `src/libs/blockchain/gcr/handleGCR.ts` - Added txhash assignment in applyToTx loop

### 3. Storage Address Normalization

**Problem**: `getStorageProgram` endpoint returned null because:

- DB stores addresses as `stor-{hash}` (with prefix)
- Client was sending `{hash}` (without prefix)

**Solution**: Added `normalizeStorageAddress()` helper function in `manageNodeCall.ts` that:

- Strips `0x` prefix if present (legacy addresses)
- Adds `stor-` prefix if missing

**File Modified**:

- `src/libs/network/manageNodeCall.ts` - Added normalizeStorageAddress() function

## Database Observations

- Table name: `gcr_storageprogram` (no underscore)
- Entity name: `GCRStorageProgram`
- Storage addresses in DB: `stor-{40char_hash}` format
- Some legacy addresses have `0xstor-` prefix

## Technical Details

### nodeCall vs gcr_routine

- `nodeCall`: Public endpoint, no authentication required
- `gcr_routine`: Requires `signature` and `identity` headers

### Storage Address Formats Observed

```
0xstor-53ad58410dfcd0b93c18f0928d84ad43c1bbf5f5  (legacy with 0x)
stor-7e40fde1086c8ed4cf0486ed12c010d30abd715f   (current format)
7e40fde1086c8ed4cf0486ed12c010d30abd715f       (raw hash, needs normalization)
```

## Testing Notes

- Node needs restart after changes for them to take effect
- Storage POC at `../storage-poc/` can be used for testing
- PostgreSQL container: `postgres_5332` on port 5332 (user: demosuser, db: demos)

## Related Files

- `src/libs/network/manageGCRRoutines.ts` - Contains authenticated storage methods (kept for backward compatibility)
- `src/model/entities/GCRv2/GCR_StorageProgram.ts` - Entity definition
- `src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines.ts` - Shared query routines

## Next Steps

- Test the endpoints after node restart
- Consider adding similar normalization to other storage-related endpoints if needed
