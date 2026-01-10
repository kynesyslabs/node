# IPFS Transaction Types

## Overview
IPFS operations are blockchain transactions that modify account state and trigger tokenomics.

## Transaction Types

### 1. ipfs_add
**Purpose**: Upload new content and pin it
**Payload** (`IPFSAddPayload`):
```typescript
{
  operation: "add"
  content: string        // Base64-encoded content
  filename?: string      // Optional filename
  contentType?: string   // MIME type
  duration?: PinDuration // DEM-481: Expiration duration
}
```
**Flow**: Decode content → Add to IPFS → Pin → Record in GCR → Charge fees

### 2. ipfs_pin
**Purpose**: Pin existing content by CID
**Payload** (`IPFSPinPayload`):
```typescript
{
  operation: "pin"
  cid: string            // Content ID to pin
  duration?: PinDuration // DEM-481: Expiration duration
}
```
**Flow**: Validate CID → Fetch content → Pin → Record in GCR → Charge fees

### 3. ipfs_unpin
**Purpose**: Unpin content (stop paying for storage)
**Payload** (`IPFSUnpinPayload`):
```typescript
{
  operation: "unpin"
  cid: string            // Content ID to unpin
}
```
**Flow**: Verify ownership → Remove from GCR → Unpin from IPFS

### 4. ipfs_extend_pin (DEM-481)
**Purpose**: Extend expiration of existing pin
**Payload** (`IPFSExtendPinPayload`):
```typescript
{
  operation: "extend_pin"
  cid: string            // Content ID to extend
  duration: PinDuration  // New duration to add
}
```
**Flow**: Verify ownership → Calculate new expiration → Update GCR → Charge extension fee

## Type Guards
Located in SDK `types/blockchain/TransactionSubtypes`:
- `isIPFSAddPayload(payload)`
- `isIPFSPinPayload(payload)`
- `isIPFSUnpinPayload(payload)`
- `isIPFSExtendPinPayload(payload)`
- `isIPFSPayload(payload)` - Generic check

## CustomCharges Integration
IPFS operations use CustomCharges for variable pricing:
```typescript
interface IPFSCustomCharges {
  storageCost: string      // Size-based fee
  durationMultiplier: number
  networkFee: string
  totalCost: string
}
```

## Processing Location
`src/libs/blockchain/routines/executeOperations.ts`:
- Case handlers for each IPFS operation type
- Calls corresponding `IPFSOperations.*` method
