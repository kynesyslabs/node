# Session: Storage Program Standard Calls API

**Date**: 2026-01-18
**Branch**: storage_v2

## Summary

Implemented granular storage program API - node-side read/write methods and SDK wrappers.

## Completed Tasks

### Core Implementation (✅ Done)

- **node-tytc / DEM-551**: Node read methods in `manageNodeCall.ts`
    - getStorageProgramFields, getStorageProgramValue, getStorageProgramItem
    - hasStorageProgramField, getStorageProgramFieldType, getStorageProgramAll
- **node-d3bv / DEM-552**: Node write methods in `GCRStorageProgramRoutines.ts`
    - SET_FIELD, SET_ITEM, APPEND_ITEM, DELETE_FIELD, DELETE_ITEM
    - Fee calculation based on size delta
- **node-ekwj / DEM-553**: SDK wrapper methods in `../sdks/src/storage/StorageProgram.ts`
    - 6 read methods: getFields, getValue, getItem, hasField, getFieldType, getAll
    - 5 write payload builders: setField, setItem, appendItem, deleteField, deleteItem
    - **SDK v2.9.0 published**

## Remaining Tasks (Epic: node-9idc)

### NEXT SESSION START HERE:

- **node-dsbw**: Update `../storage-poc` to demonstrate new standard calls API

### Also Remaining:

- **node-22zq**: Testing & edge cases for standard calls
- **node-h5tu**: Update `../documentation-mintlify` public docs
- **node-i8b7**: Update `specs/storageprogram/*.mdx` internal specs

## Key Files Modified

- `/home/tcsenpai/kynesys/node/src/libs/network/manageNodeCall.ts` - Read endpoints
- `/home/tcsenpai/kynesys/node/src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines.ts` - Write handlers
- `/home/tcsenpai/kynesys/sdks/src/storage/StorageProgram.ts` - SDK methods

## Linear Issues

- DEM-551: Done
- DEM-552: Done
- DEM-553: Done

## Notes

- Beads issues can't be closed while epic (node-9idc) is open - marked with COMPLETED notes instead
- SDK granular methods use nodeCall pattern for reads, payload builders for writes
