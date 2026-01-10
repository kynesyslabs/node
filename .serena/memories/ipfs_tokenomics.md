# IPFS Tokenomics System

## Overview
IPFS operations have associated costs based on storage size, duration, and network fees.

## Cost Components

### 1. Base Storage Cost
Calculated per byte of content stored:
```typescript
// From ipfsTokenomics.ts
const COST_PER_BYTE = 1n  // Base unit per byte
```

### 2. Duration Multipliers (DEM-481)
Different pin durations have different pricing:
```typescript
const DURATION_MULTIPLIERS: Record<PinDuration, number> = {
  week: 0.1,      // 10% of permanent cost
  month: 0.3,     // 30% of permanent cost
  quarter: 0.6,   // 60% of permanent cost
  year: 0.9,      // 90% of permanent cost
  permanent: 1.0  // Full cost (default)
}
```

### 3. Duration Values (milliseconds)
```typescript
const DURATION_VALUES: Record<string, number> = {
  week: 7 * 24 * 60 * 60 * 1000,      // 604,800,000
  month: 30 * 24 * 60 * 60 * 1000,    // 2,592,000,000
  quarter: 90 * 24 * 60 * 60 * 1000,  // 7,776,000,000
  year: 365 * 24 * 60 * 60 * 1000     // 31,536,000,000
}
```

### 4. Network Fee
Fixed fee for transaction processing.

## Cost Calculation

### For New Pins (add/pin)
```typescript
function calculatePinCost(size: number, duration: PinDuration): IPFSCostBreakdown {
  const baseCost = BigInt(size) * COST_PER_BYTE
  const multiplier = DURATION_MULTIPLIERS[duration] || 1.0
  const storageCost = BigInt(Math.ceil(Number(baseCost) * multiplier))
  const networkFee = NETWORK_FEE
  return {
    storageCost: storageCost.toString(),
    durationMultiplier: multiplier,
    networkFee: networkFee.toString(),
    totalCost: (storageCost + networkFee).toString()
  }
}
```

### For Extension (extend_pin)
```typescript
function calculateExtensionCost(
  size: number, 
  currentExpiration: number,
  newDuration: PinDuration
): IPFSCostBreakdown {
  // Only charges for the additional time
  // Proportional to remaining vs new duration
}
```

## Free Allocation
Accounts may have free storage allocation:
```typescript
interface AccountIPFSState {
  freeAllocationBytes: number  // Total free bytes allowed
  usedFreeBytes: number        // Free bytes already used
}
```
Free allocation is applied before charging.

## Reward System
Nodes can earn rewards for hosting content:
```typescript
static async updateRewards(pubkey: string, amount: bigint)
static async updateCosts(pubkey: string, amount: bigint)
```
Net balance: `earnedRewards - paidCosts`

## CustomCharges in Transactions
IPFS costs are passed via transaction's `customCharges` field:
```typescript
interface CustomCharges {
  ipfs?: IPFSCustomCharges
}
```
This allows variable-cost operations beyond fixed transaction fees.
