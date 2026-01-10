# IPFS NodeCall API Reference

## Overview
NodeCalls are RPC endpoints exposed by the Demos Network node for IPFS operations.

## Endpoints

### ipfsAdd
**Purpose**: Upload and pin new content
**Location**: `src/libs/network/routines/nodecalls/ipfs/ipfsAdd.ts`
**Request**:
```typescript
{
  content: string        // Base64-encoded content
  filename?: string
  contentType?: string
  duration?: PinDuration // DEM-481
}
```
**Response**:
```typescript
{
  success: boolean
  cid: string
  size: number
  expiresAt?: number
  cost?: IPFSCostBreakdown
}
```

### ipfsPin
**Purpose**: Pin existing content by CID
**Location**: `src/libs/network/routines/nodecalls/ipfs/ipfsPin.ts`
**Request**:
```typescript
{
  cid: string
  duration?: PinDuration
}
```
**Response**: Similar to ipfsAdd

### ipfsUnpin
**Purpose**: Unpin content
**Location**: `src/libs/network/routines/nodecalls/ipfs/ipfsUnpin.ts`
**Request**:
```typescript
{
  cid: string
}
```
**Response**:
```typescript
{
  success: boolean
  message: string
}
```

### ipfsPins
**Purpose**: Get pins for specific account
**Location**: `src/libs/network/routines/nodecalls/ipfs/ipfsPins.ts`
**Request**:
```typescript
{
  address: string  // Account pubkey
}
```
**Response**:
```typescript
{
  success: boolean
  address: string
  pins: PinnedContent[]
  count: number
  totalPinnedBytes: number
  earnedRewards: string
  paidCosts: string
  expiration: ExpirationSummary  // DEM-481
}
```

### ipfsListPins
**Purpose**: List all pins on IPFS node (admin)
**Location**: `src/libs/network/routines/nodecalls/ipfs/ipfsListPins.ts`
**Response**:
```typescript
{
  success: boolean
  pins: string[]  // Array of CIDs
  count: number
}
```

### ipfsQuota
**Purpose**: Get storage quota for account
**Location**: `src/libs/network/routines/nodecalls/ipfs/ipfsQuota.ts`
**Request**:
```typescript
{
  address: string
}
```
**Response**:
```typescript
{
  success: boolean
  address: string
  totalPinnedBytes: number
  pinCount: number
  freeAllocationBytes: number
  usedFreeBytes: number
  remainingFreeBytes: number
  quotaUsagePercent: number
}
```

## Registration
NodeCalls are registered in:
- `src/libs/network/routines/nodecalls/ipfs/index.ts` - Exports
- `src/libs/network/manageNodeCall.ts` - Route mapping

## Error Handling
All endpoints return:
```typescript
{
  result: number  // HTTP-like status code
  response: {
    success: boolean
    error?: string
  }
  require_reply: boolean
  extra: any
}
```

Common result codes:
- 200: Success
- 400: Bad request (missing params)
- 404: Not found
- 500: Internal error
