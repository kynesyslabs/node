# DEM → OS Denomination Migration Audit

**Date**: May 1, 2026  
**Auditor**: Claude Code (Read-Only Audit)  
**SDK Version Audited**: 2.11.5  
**Source Location**: `/Users/tcsenpai/kynesys/sdks/`

---

## Executive Summary

The SDK is in a **greenfield state** for denomination migration—no `denomination/` module exists, no conversion utilities are implemented, and all amount/fee/balance fields remain as `number` types (DEM). However, several recent changes show partial progress toward the migration goal:

1. **CustomCharges.ts** (Type 1 interface) already references `max_cost_dem` as `string`, not `number`.
2. **Account.balance** (Type 1.5) is already `string` (but unconfirmed if it's DEM or OS).
3. **getAddressInfo** (Type 5.2) already converts balance to `BigInt` (but with a FIXME warning for balance = 0).
4. **StorageProgram** (Type 2.1) has `FEE_PER_CHUNK: 1n` as `BigInt`, not mapped to denomination constants.
5. **IPFS Custom Charges** (Type 3) reference `max_cost_dem` throughout, with methods `quoteToCustomCharges` and `createCustomCharges` already in place (but calling themselves with `maxCostDem` camelCase, not snake_case).

**Critical Finding**: Transaction hashing uses `JSON.stringify(raw_tx.content)` directly on objects with numeric amount fields. Switching from `number` to `string` **will change transaction hashes and invalidate existing signatures**. This is a breaking change that must coordinate with node-side hashing logic.

---

## Phase-by-Phase Audit

### Phase 0: Foundation – Constants & Conversion Utilities

**Status**: ❌ **MISSING ENTIRELY**

- No `src/denomination/` directory exists.
- No `constants.ts`, `conversion.ts`, or `index.ts` exports.
- No unit tests for denomination conversions.

**Action Required**: All Phase 0 deliverables are needed as a prerequisite.

---

### Phase 1: Type Definitions – Migrate to OS (BigInt/string)

#### 1.1 TxFee.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/TxFee.ts`  
**Status**: ❌ **STILL NUMBER**

```typescript
// Current (line 1–5):
export interface TxFee {
    network_fee: number    // ← still number
    rpc_fee: number        // ← still number
    additional_fee: number // ← still number
}
```

Expected: `string` (OS as wire format).

---

#### 1.2 Transaction.ts – TransactionContent.amount
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/Transaction.ts`  
**Status**: ❌ **STILL NUMBER** (line 83)

```typescript
// Current:
export interface TransactionContent {
    type: "web2Request" | /* ... */ | "tokenExecution"
    from: string
    from_ed25519_address: string
    to: string
    amount: number  // ← still number
    // ...
    data: TransactionContentData
    gcr_edits: GCREdit[]
    nonce: number
    timestamp: number
    transaction_fee: TxFee
    custom_charges?: CustomCharges
}
```

Expected: `string` (OS as wire format).

---

#### 1.3 rawTransaction.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/rawTransaction.ts`  
**Status**: ❌ **STILL NUMBER** (lines 24–29)

```typescript
// Current:
export interface RawTransaction {
    // ...
    amount: number         // ← still number
    nonce: number
    timestamp: number
    networkFee: number     // ← still number
    rpcFee: number         // ← still number
    additionalFee: number  // ← still number
    // ...
}
```

Expected: All fee and amount fields as `string`.

---

#### 1.4 statusNative.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/statusNative.ts`  
**Status**: ❌ **STILL NUMBER** (line 3)

```typescript
// Current:
export interface StatusNative {
    address: string
    balance: number  // ← still number
    nonce: number
    tx_list: string
}
```

Expected: `string` (OS as wire format).

---

#### 1.5 gls/account.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/gls/account.ts`  
**Status**: ⚠️ **PARTIAL** (line 5)

```typescript
// Current:
export interface Account {
    pubkey: string
    assignedTxs: string[]
    nonce: number
    balance: string  // ← ALREADY STRING
    identities: AccountIdentities
    points: AccountPoints
    referralInfo: ReferralInfo
    flagged: boolean
    flaggedReason: string
    reviewed: boolean
    createdAt: string
    updatedAt: string
}
```

**Note**: `balance` is already `string`, but unclear if it represents DEM or OS. Needs verification that it's being populated as OS from the node.

---

#### 1.6 gls/StateChange.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/gls/StateChange.ts`  
**Status**: ❌ **STILL NUMBER**

```typescript
// Current (lines 14–32):
interface TokenTransfer {
    address: string
    amount: number  // ← still number
}

interface NFTTransfer {
    address: string
    tokenId: string
    amount: number  // ← still number
}

export interface StateChange {
    sender: forge.pki.ed25519.BinaryBuffer
    receiver: forge.pki.ed25519.BinaryBuffer
    nativeAmount: number  // ← still number
    tx_hash: string
    token: TokenTransfer
    nft: NFTTransfer
}
```

Expected: All `amount` and `nativeAmount` fields as `string`.

---

#### 1.7 CustomCharges.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/CustomCharges.ts`  
**Status**: ✅ **MATCHES PLAN** (partially)

```typescript
// Current (line 43):
export interface IPFSCustomCharges {
    max_cost_dem: string  // ← ALREADY STRING (good!)
    file_size_bytes: number
    operation: "IPFS_ADD" | "IPFS_PIN" | "IPFS_UNPIN"
    duration_blocks?: number
    estimated_breakdown?: IPFSCostBreakdown
}

// Lines 22–32:
export interface IPFSCostBreakdown {
    base_cost: string  // ← ALREADY STRING
    size_cost: string  // ← ALREADY STRING
    duration_cost?: string
    additional_costs?: Record<string, string>
}
```

**Note**: IPFS charges are already using `string` for costs and labeled `max_cost_dem`. The doc proposes renaming to `max_cost_os`, but the code doesn't yet use OS (9 decimals); it still refers to them as "DEM wei" (line 22). **Migration path unclear**: is `max_cost_dem: string` currently in DEM strings or OS strings?

---

#### 1.8 bridge/nativeBridgeTypes.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/bridge/nativeBridgeTypes.ts`  
**Status**: ⚠️ **PARTIAL MISMATCH**

```typescript
// Current (lines 9–21):
export type BridgeOperation = {
    demoAddress: string
    originChainType: SupportedChain
    originChain: SupportedEVMChain | SupportedNonEVMChain
    destinationChainType: SupportedChain
    destinationChain: SupportedEVMChain | SupportedNonEVMChain
    originAddress: string
    destinationAddress: string
    amount: string  // ← ALREADY STRING
    token: SupportedStablecoin
    txHash: string
    status: "empty" | "pending" | "completed" | "failed"
}

// Current (lines 24–29):
export type EVMTankData = {
    type: "evm"
    abi: string[]
    address: string
    amountExpected: number  // ← STILL NUMBER (NOT STRING!)
}

export type SolanaTankData = {
    type: "solana"
    address: string
    amountExpected: number  // ← STILL NUMBER
}
```

**Finding**: `BridgeOperation.amount` is already `string`, but `EVMTankData.amountExpected` and `SolanaTankData.amountExpected` remain `number`. Doc says Phase 1.8 should migrate these to `string`, but `SolanaTankData` was not on the radar. This is a **hidden surface area** the doc missed.

---

#### 1.9 TransactionSubtypes/NativeTransaction.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/TransactionSubtypes/NativeTransaction.ts`  
**Status**: ✅ **INHERITS FROM TransactionContent**

NativeTransaction reuses `TransactionContent` type, which has `amount: number`. Once 1.2 is fixed, this is automatically covered.

---

### Phase 2: Storage & TLSNotary Constants

#### 2.1 Storage Program Constants
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/TransactionSubtypes/StorageProgramTransaction.ts` (lines 1–13)  
**Status**: ⚠️ **PARTIAL**

```typescript
// Current:
export const STORAGE_PROGRAM_CONSTANTS = {
    /** Maximum storage size in bytes (1MB) */
    MAX_SIZE_BYTES: 1048576,

    /** Size chunk for pricing in bytes (10KB) */
    PRICING_CHUNK_BYTES: 10240,

    /** Fee per chunk in DEM */
    FEE_PER_CHUNK: 1n,  // ← ALREADY BigInt(1)

    /** Maximum nesting depth for JSON encoding */
    MAX_JSON_NESTING_DEPTH: 64,
}
```

**Finding**: `FEE_PER_CHUNK` is hardcoded as `1n` (BigInt), but the comment still says "in DEM". The doc wants this to be `OS_PER_DEM` (1 billion in OS) for consistency. **Current value is wrong by a factor of 10^9** if the intent is to charge 1 DEM per chunk.

---

#### 2.2 calculateStorageFee in tlsnotary/helpers.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/tlsnotary/helpers.ts` (lines 25–27)  
**Status**: ❌ **RETURNS number, NOT BigInt**

```typescript
// Current:
export function calculateStorageFee(proofSizeKB: number): number {
    return 1 + proofSizeKB  // Returns DEM as number
}
```

Expected: Should return `bigint` (OS as BigInt), with 1 DEM base = `OS_PER_DEM` and 1 DEM per KB = `OS_PER_DEM * proofSizeKB`.

---

### Phase 3: IPFS Module – Migrate Custom Charges

#### 3.1 & 3.2 IPFSOperations.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/ipfs/IPFSOperations.ts`  
**Status**: ⚠️ **METHODS EXIST, BUT NAMING INCONSISTENT**

Found `quoteToCustomCharges` (line 557) and `createCustomCharges` (line 590):

```typescript
// Line 557–566:
static quoteToCustomCharges(quote: IpfsQuoteResponse): {
    maxCostDem: string          // ← camelCase (not snake_case)
    estimatedBreakdown: IPFSCostBreakdown
} {
    return {
        maxCostDem: quote.cost_dem,
        estimatedBreakdown: {
            base_cost: quote.breakdown.base_cost,
            size_cost: quote.breakdown.size_cost,
        },
    }
}

// Line 590–602:
static createCustomCharges(
    quote: IpfsQuoteResponse,
    operation: "IPFS_ADD" | "IPFS_PIN" | "IPFS_UNPIN",
    durationBlocks?: number,
): IPFSCustomCharges {
    return {
        max_cost_dem: quote.cost_dem,  // ← snake_case, still references `cost_dem`
        file_size_bytes: quote.file_size_bytes,
        operation,
        duration_blocks: durationBlocks,
        estimated_breakdown: {
            base_cost: quote.breakdown.base_cost,
            size_cost: quote.breakdown.size_cost,
        },
    }
}
```

**Finding**: The code already passes costs through as strings (from `quote.cost_dem`), but the **denomination is ambiguous**. Are these costs in DEM or OS? The `IpfsQuoteResponse` interface (line 155) labels the field `cost_dem: string`, implying it's DEM-denominated. **No conversion** (`demToOs`) is applied, suggesting the quote response from the node is already expected to be in DEM strings, not OS.

---

#### 3.3 IPFS Payload Builders
**Path**: Various payload builders in `src/ipfs/IPFSOperations.ts`  
**Status**: ⚠️ **USES max_cost_dem, NOT MIGRATED**

Lines 300, 359 show `max_cost_dem: options.customCharges.maxCostDem` being passed to payload builders. Once Phase 3.1–3.2 conversion logic is added, these should automatically flow the correct OS values.

---

### Phase 4: Wallet – Balance & Transfer

#### 4.1 Wallet.getBalance() and balance accessor
**Path**: `/Users/tcsenpai/kynesys/sdks/src/wallet/Wallet.ts`  
**Status**: ❌ **INCOMPLETE & NEVER CALLED**

```typescript
// Line 74–78:
async getBalance(): Promise<void> {
    let info = await websdk.demos.getAddressInfo(this.ed25519_hex.publicKey)
    // TODO Implement this and other nodeCalls
    // return info.native.balance
}
```

**Finding**: The method is stubbed out with a TODO and never implemented. No `_balance` field. No `balanceOs` or `balanceDem` accessors as specified in Phase 4.1.

---

#### 4.2 Wallet.transfer()
**Path**: `/Users/tcsenpai/kynesys/sdks/src/wallet/Wallet.ts` (lines 83–100)  
**Status**: ❌ **ACCEPTS number, NOT BigInt**

```typescript
// Line 83:
async transfer(to: Address, amount: number, demos: websdk.Demos) {
    let tx = DemosTransactions.empty()
    // ...
    tx.content.data = [
        "native",
        {
            nativeOperation: "send",
            args: [to, amount],  // ← passes number directly
        },
    ]
    tx = await demos.sign(tx)
    return await demos.confirm(tx)
}
```

Expected: Should accept `amountOs: bigint` and convert to `toOsString(amountOs)` before building the payload.

---

### Phase 5: Main Demos Class – Public API

#### 5.1 Demos.transfer()
**Path**: `/Users/tcsenpai/kynesys/sdks/src/websdk/demosclass.ts` (line 259)  
**Status**: ❌ **ACCEPTS number, NOT BigInt**

```typescript
// Line 259:
transfer(to: string, amount: number) {
    required(this.keypair, "Wallet not connected")
    return DemosTransactions.pay(to, amount, this)
}
```

Expected: `transfer(to: string, amountOs: bigint)` with JSDoc showing conversion examples (`demToOs(100)`).

---

#### 5.2 Demos.getAddressInfo()
**Path**: `/Users/tcsenpai/kynesys/sdks/src/websdk/demosclass.ts` (lines 808–823)  
**Status**: ⚠️ **PARTIALLY IMPLEMENTED, WITH FIXME**

```typescript
// Line 808–823:
async getAddressInfo(address: string): Promise<AddressInfo | null> {
    const info = await this.nodeCall("getAddressInfo", { address })

    if (info) {
        // REVIEW Fix for when the balance is 0 (see FIXME below)
        if (!info.balance) {
            info.balance = 0
        }
        return {
            ...info,
            balance: BigInt(info.balance),  // ← CONVERTS TO BigInt
            // FIXME This fails when the balance is 0
        } as AddressInfo
    }

    return null
}
```

**Finding**: The code **already converts** balance to `BigInt`, but there's a **FIXME comment** indicating a known bug when balance is 0 (because `BigInt(0)` is falsy in JavaScript). This is an incomplete migration that needs the fallback logic fixed. Also, the comment suggests the node may still send `number` balances, hence the need for conversion.

**Issue**: The conversion assumes `info.balance` is a DEM `number` from the node. If the node is already sending OS strings, this will fail. The fallback to `info.balance = 0` suggests the code was written defensively for a transitional period.

---

### Phase 6: Escrow Module

#### 6.1 EscrowTransaction.sendToIdentity()
**Path**: `/Users/tcsenpai/kynesys/sdks/src/escrow/EscrowTransaction.ts` (lines 61–134)  
**Status**: ❌ **ACCEPTS number, NOT BigInt**

```typescript
// Line 61–69:
static async sendToIdentity(
    demos: Demos,
    platform: "twitter" | "github" | "telegram",
    username: string,
    amount: number,  // ← STILL number
    options?: {
        expiryDays?: number
        message?: string
    }
): Promise<Transaction> {
    // ...
}

// Lines 90–108:
const gcrEdits: GCREdit[] = [
    {
        type: "balance",
        operation: "remove",
        account: sender,
        amount: amount,  // ← passes number directly to GCREdit
        txhash: "",
        isRollback: false,
    },
    {
        type: "escrow",
        operation: "deposit",
        account: escrowAddress,
        data: {
            sender,
            platform,
            username,
            amount: amount,  // ← passes number to escrow data
            expiryDays: options?.expiryDays || 30,
            message: options?.message,
        },
        txhash: "",
        isRollback: false,
    },
]
```

Expected: Should accept `amountOs: bigint` and update GCREdit.amount fields (which are currently `number`).

---

#### 6.2 GCREdit.amount field
**Path**: `/Users/tcsenpai/kynesys/sdks/src/types/blockchain/GCREdit.ts` (lines 18–24, 180–204)  
**Status**: ❌ **STILL number**

```typescript
// Line 18–24:
export interface GCREditBalance {
    type: "balance"
    isRollback: boolean
    operation: "add" | "remove"
    account: string
    amount: number  // ← STILL number
    txhash: string
}

// Line 180–204 (GCREditEscrow):
export interface GCREditEscrow {
    type: "escrow"
    operation: "deposit" | "claim" | "refund"
    account: string
    data: {
        sender?: string
        platform?: "twitter" | "github" | "telegram"
        username?: string
        amount?: number  // ← STILL number
        expiryDays?: number
        message?: string
        // ...
    }
    txhash: string
    isRollback: boolean
}
```

**Finding**: Multiple GCREdit types have `amount: number` fields that need migration.

---

### Phase 7: Bridge Module

#### 7.1 & 7.2 nativeBridge.ts & nativeBridgeTypes.ts
**Path**: `/Users/tcsenpai/kynesys/sdks/src/bridge/nativeBridge.ts` and `/Users/tcsenpai/kynesys/sdks/src/bridge/nativeBridgeTypes.ts`  
**Status**: ⚠️ **INCONSISTENT**

Already reviewed in Phase 1.8:
- `BridgeOperation.amount` is `string` ✅
- `EVMTankData.amountExpected` is `number` ❌
- `SolanaTankData.amountExpected` is `number` ❌

Also found: `/Users/tcsenpai/kynesys/sdks/src/types/bridge/bridgeTradePayload.ts` (line 5)
```typescript
export interface BridgeTradePayload {
    fromToken: "NATIVE" | "USDC" | "USDT",
    toToken: "NATIVE" | "USDC" | "USDT",
    amount: number,  // ← STILL number
    fromChainId: number,
    toChainId: number,
}
```

**Hidden surface area**: `BridgeTradePayload` is not mentioned in the doc but exists in the SDK.

---

### Phase 8: Internal Transaction Building & Serialization

#### 8.1 Transaction Hashing
**Path**: `/Users/tcsenpai/kynesys/sdks/src/websdk/demosclass.ts` (line 375)  
**Status**: 🆕 **CRITICAL SURFACE AREA**

```typescript
// Line 375:
raw_tx.hash = Hashing.sha256(JSON.stringify(raw_tx.content))
```

**Critical Finding**: The transaction hash is computed by hashing the JSON serialization of `raw_tx.content`. **Changing `amount: number` to `amount: string` will change the hash of every transaction.** This breaks signature verification unless the node also updates its hashing logic in lockstep.

**Related code** (line 376–378):
```typescript
const signature = await this.crypto.sign(
    this.algorithm,
    new TextEncoder().encode(raw_tx.hash),
)
```

The signature is computed on the hash string. If the hash changes, all existing signatures become invalid. **This requires node-side coordination.**

---

#### 8.2 ObjectToHex / HexToObject
**Path**: `/Users/tcsenpai/kynesys/sdks/src/utils/dataManipulation.ts` (lines 1–7)  
**Status**: ⚠️ **TRANSPARENT, BUT BigInt NOT SAFE**

```typescript
export async function ObjectToHex(obj: any): Promise<string> {
    return Buffer.from(JSON.stringify(obj)).toString("hex")
}

export async function HexToObject(hex: string): Promise<any> {
    return JSON.parse(Buffer.from(hex, "hex").toString("utf8"))
}
```

**Finding**: `JSON.stringify` does **not** natively handle `BigInt`. If amount fields are stored internally as `BigInt`, they must be **converted to strings before calling `ObjectToHex`**. The doc mentions this (Phase 8.2) but no code changes are present yet.

---

#### 8.3 RPC Layer
**Path**: `/Users/tcsenpai/kynesys/sdks/src/websdk/demosclass.ts` (lines 808–823, 375)  
**Status**: ⚠️ **PARTIALLY DONE**

- Incoming: `getAddressInfo` already parses balance to `BigInt` (but has FIXME).
- Outgoing: No conversion visible. Amount fields are passed as `number` directly.

No explicit use of `toOsString` or `parseOsString` utilities found (because they don't exist yet).

---

### Phase 9: Tests

**Status**: ❌ **NO DENOMINATION TESTS**

- No test file for `src/denomination/conversion.test.ts`.
- Existing tests in `/Users/tcsenpai/kynesys/sdks/src/tests/` do not use denomination conversion.
- No end-to-end test for "user input → wire → display round-trip" as shown in Phase 9.3.

---

### Phase 10: Package Version & Documentation

#### 10.1 Package Version
**Path**: `/Users/tcsenpai/kynesys/sdks/package.json`  
**Status**: ⏳ **READY TO BUMP**

Current: `"version": "2.11.5"`  
Expected after migration: `"3.0.0"` (major version bump)

---

#### 10.2 & 10.3 JSDoc & Examples
**Status**: ❌ **NOT UPDATED**

No JSDoc comments in `Demos.transfer()` or `Wallet.transfer()` mention `demToOs()` or BigInt.

---

## Hidden Surface Area

The following types/files contain amount or balance fields **not explicitly listed in the IDEA.md checklist**:

1. **D402PaymentTransaction.ts** (line 11): `amount: number` ← for D402 payment payloads
2. **bridgeTradePayload.ts** (line 5): `amount: number` ← for bridge trade operations
3. **xm/apiTools.ts**: `amount: number` and `fee: number` in `SolNativeTransfer` and `SolTransaction` ← cross-chain/Solana types
4. **GCREdit.ts**: Multiple amount fields in various GCREdit subtypes:
   - `GCREditBalance.amount: number`
   - `GCREditNonce.amount: number`
   - `GCREditEscrow.data.amount?: number`
5. **StateChange.ts**: `TokenTransfer.amount` and `NFTTransfer.amount`, `StateChange.nativeAmount` ← state change tracking
6. **EVMTankData.amountExpected** and **SolanaTankData.amountExpected** (nativeBridgeTypes.ts) ← bridge-specific tank data

---

## Transaction Hashing & Signature Implications

**Critical Issue**: Line 375 in `demosclass.ts` computes the transaction hash using:
```typescript
raw_tx.hash = Hashing.sha256(JSON.stringify(raw_tx.content))
```

Changing `amount: number` to `amount: string` will **alter the JSON output**, resulting in a different hash. Since signatures are computed over the hash, this breaks all existing transaction signatures **unless**:

1. The node's transaction hashing logic is **updated in lockstep**.
2. All existing transactions are **re-signed or invalidated**.
3. A **version flag** is introduced to distinguish old (number-based) vs. new (string-based) hashing.

**Recommendation**: Coordinate with the node team to confirm that the node will also migrate to string-based amount fields and update its hashing logic before SDK release.

---

## Account Balance Type Inconsistency

**Observation**: `Account.balance` (gls/account.ts, line 5) is **already `string`**, while `StatusNative.balance` (statusNative.ts, line 3) is **still `number`**. These appear to be from different sources:

- `Account` (from GLS/indexing layer) → `balance: string`
- `StatusNative` (from native blockchain layer) → `balance: number`

**Unclear**: Are GLS balances already in OS, or are they in DEM strings? Are native balances in DEM numbers? The migration plan doesn't clarify this discrepancy.

---

## Existing Denomination Indicators

Several clues suggest **partial awareness** of denomination at the code level:

1. **CustomCharges.ts** uses `string` for costs and comments reference "DEM wei" (line 22), suggesting developers knew BigInt-safe strings were needed.
2. **StorageProgramConstants.FEE_PER_CHUNK = 1n** is already `BigInt`, suggesting someone started thinking in that direction.
3. **getAddressInfo** already converts balance to `BigInt`, implying developers anticipated denomination changes.
4. **Comments** in CustomCharges.ts and elsewhere label amounts as "DEM wei" or "OS" but don't yet implement conversion utilities.

**Conclusion**: The migration is **partially anticipated** but not systematically executed.

---

## Top Discrepancies

Ranked by severity and impact:

### 1. **Transaction Hashing Will Break Existing Signatures** (Critical)
- **Issue**: Switching `amount: number` to `amount: string` changes `JSON.stringify` output, which changes the transaction hash (line 375 of demosclass.ts).
- **Impact**: All existing transaction signatures become invalid. Node must migrate hashing logic simultaneously.
- **Location**: `src/websdk/demosclass.ts:375`
- **Required Action**: Coordinate with node team on hashing strategy before release.

### 2. **No Denomination Module Exists** (Blocking)
- **Issue**: Phase 0 (src/denomination/) is completely missing. All conversion utilities (`demToOs`, `osToDem`, `toOsString`, `parseOsString`) don't exist.
- **Impact**: Cannot begin any phase of the migration without these utilities.
- **Required Action**: Create Phase 0 module as a prerequisite for all other phases.

### 3. **getAddressInfo Balance Conversion Has FIXME Bug** (High)
- **Issue**: Line 808 in demosclass.ts converts balance to BigInt but has a documented FIXME for when balance is 0 (falsy check fails).
- **Impact**: Zero balances may not round-trip correctly.
- **Location**: `src/websdk/demosclass.ts:815` (FIXME comment)
- **Required Action**: Fix zero-balance handling before deploying.

### 4. **Hidden Surface Area: 6+ Types with Amount Fields Not Listed** (High)
- **Issue**: D402PaymentPayload, BridgeTradePayload, GCREdit subtypes, StateChange token/NFT amounts, and xm apiTools all have `amount: number` fields not mentioned in the doc.
- **Impact**: Incomplete migration will leave orphaned number amounts in production code.
- **Required Action**: Audit and add all amount fields to the migration checklist.

### 5. **IPFS Custom Charges Denomination Ambiguous** (Medium)
- **Issue**: CustomCharges.ts labels costs as `max_cost_dem` and "DEM wei", but no conversion is applied. Unclear if node returns DEM or OS.
- **Impact**: May pass wrong denomination to node during cost estimation.
- **Location**: `src/ipfs/IPFSOperations.ts:557–602`, `src/types/blockchain/CustomCharges.ts:22–43`
- **Required Action**: Clarify with node whether IPFS quotes are DEM or OS, and apply conversion if needed.

---

## Recommendation

**Do not begin Phase 1–10 migrations until Phase 0 is complete and approved.** The lack of denomination utilities blocks all downstream work. Additionally, **pause on transaction hashing changes** until node team confirms their side is ready, as this is a breaking change that affects signature validity.

**Estimated scope**: ~50–80 files modified across all phases, with highest risk in transaction hashing and GCREdit chains.

