# DEM → OS Denomination Migration Audit: Node Side

**Date:** May 1, 2026  
**SDK Version Pinned:** @kynesyslabs/demosdk ^2.11.4  
**Node Status:** NOT MIGRATED (SDK Phase 0 not yet in SDK v2.11.4)

## Executive Summary

The node codebase is **structurally ready** for the DEM → OS migration because it already uses `bigint` for balance storage (GCRv2) and has few hardcoded numeric amount assumptions. However, **critical precision loss vulnerabilities exist in transaction validation** due to `parseInt()` calls that assume `number` types for large amounts. The node must implement the migration **atomically with the SDK** — the wire format change from `number` to `string` for amounts will break parsing unless both systems migrate together.

**Top Risk:** Transaction validation and genesis loading use `parseInt(operation.params.amount)` which silently truncates to 32-bit integers on 53-bit JavaScript numbers, losing precision.

---

## 1. Balance Storage

**Status:** READY ✓

### Current State

**File:** `/Users/tcsenpai/kynesys/node/src/model/entities/GCRv2/GCR_Main.ts` (lines 21-22)
```typescript
@Column({ type: "bigint", name: "balance" })
balance: bigint
```

Balance is persisted as PostgreSQL `bigint` and represented as TypeScript `bigint`. This is already OS-compatible (no lossy conversion).

**Implication:** The database schema requires NO changes. On migration day, existing `bigint` values in the database will be interpreted as OS instead of DEM (10^9x difference). Genesis must be recalculated with OS amounts.

---

## 2. Balance Arithmetic

**Status:** MOSTLY SAFE, ONE BROKEN PATH

### Add/Subtract Operations (GCRBalanceRoutines)

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` (lines 59-72)
```typescript
if (editOperation.operation === "add") {
    accountGCR.balance = BigInt(accountGCR.balance) + BigInt(editOperation.amount)
} else if (editOperation.operation === "remove") {
    if ((actualBalance < editOperation.amount || actualBalance === 0n) && getSharedState.PROD) {
        return { success: false, message: "Insufficient balance" }
    }
    accountGCR.balance = BigInt(accountGCR.balance) - BigInt(editOperation.amount)
}
```

**Current:** GCREdit operations already coerce `amount` to BigInt. Safe.  
**What breaks:** If SDK sends `amount` as string (Phase 1.6), the comparison at line 65 (`actualBalance < editOperation.amount`) becomes a string comparison, not numeric. Must be fixed after SDK migration to ensure `editOperation.amount` is BigInt-compatible.

### Transaction-level Balance Checks

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/routines/subOperations.ts` (lines 83, 96, 147, 163, 171)

**CRITICAL VULNERABILITY — parseInt() Precision Loss:**
```typescript
// Line 83 - Genesis balance loading
await GCR.setGCRNativeBalance(receiver, parseInt(amount), operation.hash)

// Line 96 - transferNative
const amount = parseInt(operation.params.amount, 10)

// Lines 147, 171 - addNative / removeNative
const newBalanceTo = balanceTo + parseInt(amount)
const newBalanceTo = balanceTo - parseInt(amount)
```

**Current:** These code paths assume `operation.params.amount` is a `number` (DEM or small integer).  
**What breaks:** If SDK starts sending `amount` as `string` (wire format), `parseInt("1000000000")` works fine for positive cases. BUT:
1. After SDK migration, if amount comes as `"10000000000000000"` (16 decimals, well within OS range), `parseInt()` will silently truncate to JavaScript's `Number.MAX_SAFE_INTEGER` (2^53-1 ≈ 9×10^15), losing precision for large amounts.
2. No validation that `parseInt()` succeeded or that the result matches the original.

**Example failure:** OS amount `123456789012345678n` comes as string `"123456789012345678"`. `parseInt()` returns `123456789012345600` (lossy).

---

## 3. Fee Computation and Storage

**Status:** MIXED — Static values OK, but inconsistent types

### Fee Configuration

**File:** `/Users/tcsenpai/kynesys/node/src/config/defaults.ts` (lines 34-35)
```typescript
rpcFeePercent: 10,      // percentage
rpcFee: 10,              // static value in DEM
```

**File:** `/Users/tcsenpai/kynesys/node/src/config/types.ts`
```typescript
rpcFeePercent: number
rpcFee: number
```

Static fees are stored as `number` (currently DEM). On migration:
- Must specify units in config comments: "rpcFee in OS (smallest unit)"
- Must update defaults: `rpcFee: 10000000000` (10 DEM = 10^10 OS)
- Must validate in loader that fees aren't lossy.

### Fee Storage in Transactions

**File:** `/Users/tcsenpai/kynesys/node/src/model/entities/Transactions.ts` (lines 52-59)
```typescript
@Column("integer", { name: "networkFee" })
networkFee: number

@Column("integer", { name: "rpcFee" })
rpcFee: number

@Column("integer", { name: "additionalFee" })
additionalFee: number
```

**Current:** Fees stored as `integer` (32-bit), which is too small for OS amounts.  
**What breaks:** After SDK migration, if SDK sends fees as strings like `"1000000000"` (1 DEM in OS), `parseInt()` works, but the `integer` column silently truncates. For fees this is less critical (fees are typically small) but still a latent bug.

**Fix required:** Change to `bigint` columns.

### Fee Calculation

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/routines/calculateCurrentGas.ts`
```typescript
const transactionFee = payloadSize * composedGasPrice
```

No denomination conversion. Works as long as this returns a numeric value for the environment (currently DEM, will become OS after SDK migration).

---

## 4. Transaction Validation

**Status:** UNSAFE — Type assumptions in validation

### confirmTransaction (Signature & Structure Validation)

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/routines/validateTransaction.ts` (lines 29-110)

This function validates signatures and coherence but does NOT validate amounts explicitly. Amount validation happens in:
1. **GCRBalanceRoutines** (line 65-66): Compares `actualBalance < editOperation.amount` — will break if types differ.
2. **subOperations.transferNative** (line 114): `amount > balanceFrom` — will break if amount is string.

### Transaction Hashing

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/transaction.ts` (line 108)
```typescript
static hash(tx: Transaction): any {
    const hash = Hashing.sha256(JSON.stringify(tx.content))
}
```

**Critical:** Transaction hash is computed by serializing `tx.content` as JSON. When SDK migrates amount from `number` to `string`:
- Old: `"amount": 1` → JSON → hash
- New: `"amount": "1000000000"` → JSON → hash

**All existing transaction hashes become invalid.** This is expected and documented in IDEA.md but is a breaking change that requires coordination.

### Amount Validation Checks Missing

The node does NOT explicitly validate:
- Amount is not negative
- Amount + fees ≤ sender balance
- Amount is a valid denomination (e.g., no more than 9 decimals after SDK migration)

These checks rely on the SDK to enforce. If SDK sends an invalid string like `"1.5"` (which is valid in decimal but not representable as BigInt), the node will crash on `BigInt("1.5")`.

---

## 5. Wire Deserialization

**Status:** WILL BREAK — Hardcoded number assumptions

### Transaction Deserialization Path

When SDK sends a transaction with `amount: "1000000000"` (string, Phase 1.1), the node must:

1. **Parse RPC request** — Done via JSON.parse (safe, strings stay strings)
2. **Store in mempool** — Content is stored as-is (safe)
3. **Validate in subOperations** — **BREAKS HERE** (line 96):
   ```typescript
   const amount = parseInt(operation.params.amount, 10)
   ```
   This works for string input but loses precision for large values.

4. **Create Transaction entity** — Content stored as JSON (safe)
5. **Compare balances** — **BREAKS HERE** (line 65, GCRBalanceRoutines):
   ```typescript
   if (actualBalance < editOperation.amount) // type mismatch if amount is string
   ```

### No Type Guards

The node does not validate that incoming `amount` is the expected type. If SDK sends string but node code expects number, or vice versa, silent failures occur.

---

## 6. RPC Response Shape

**Status:** PARTIALLY PREPARED ✓

### getAddressInfo Return Type

**File:** `/Users/tcsenpai/kynesys/node/src/libs/network/handlers/identityHandlers.ts`
```typescript
getAddressInfo: async (data, response) => {
    const nStat = await ensureGCRForUser(data.address)
    response.response = nStat
    return response
}
```

Returns `GCRMain` entity directly, which has `balance: bigint`. When serialized as JSON:
- Current (DEM): `{"balance": 123456789}`
- After migration (OS): `{"balance": 123456789000000000}`
- **Problem:** JSON.stringify does NOT handle bigint natively; will throw TypeError.

**Fix required:** Explicitly serialize balance as string:
```typescript
{
    ...nStat,
    balance: nStat.balance.toString()
}
```

---

## 7. Genesis & Initial Allocation

**Status:** BROKEN — parseInt() precision loss

### Genesis Block Generation

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/chainGenesis.ts` (lines 39-43)
```typescript
genesisTx.content.amount = 0
genesisTx.content.transaction_fee.network_fee = 0
genesisTx.content.transaction_fee.rpc_fee = 0
genesisTx.content.transaction_fee.additional_fee = 0
```

Genesis transaction fees are hardcoded as `0` (no fees in genesis). Safe.

### Genesis Balance Loading

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/chainGenesis.ts` (lines 91-105)
```typescript
for (const balance of genesisData.balances) {
    const user = {
        pubkey: balance[0],
        balance: balance[1],  // balance[1] is accessed directly
    }
}
```

Then in `subOperations.genesis()` (line 83):
```typescript
await GCR.setGCRNativeBalance(receiver, parseInt(amount), operation.hash)
```

**What breaks:** If genesisData comes from SDK with amounts already in OS as strings:
- `genesisData.balances = [["0xabc...", "1000000000"], ...]`
- `parseInt("1000000000")` = `1000000000` ✓ (works for this example)
- But if amount is very large: `parseInt("10000000000000000")` truncates silently.

**Practical impact:** Genesis will fail for accounts with balances > 2^53. Unlikely in practice (max ~9×10^15 OS ≈ 9,000 DEM) but theoretically broken.

### Units in Genesis Data

The node assumes `genesisData.balances[i][1]` is in the same denomination as the active network. When SDK migrates to OS, genesis files must be recalculated or converted. No automatic conversion happens.

---

## 8. Consensus & State Hashing

**Status:** BREAKING CHANGE — Unavoidable

### Transaction Hash Calculation

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/transaction.ts` (line 108)
```typescript
static hash(tx: Transaction): any {
    const hash = Hashing.sha256(JSON.stringify(tx.content))
}
```

**Block Hash Calculation**

**File:** `/Users/tcsenpai/kynesys/node/src/libs/consensus/v2/routines/createBlock.ts`
```typescript
block.hash = Hashing.sha256(JSON.stringify(block.content))
```

**Why it breaks:** When `tx.content.amount` changes from `number` to `string`:
```javascript
JSON.stringify({amount: 1}) // "{"amount":1}"
JSON.stringify({amount: "1000000000"}) // "{"amount":"1000000000"}"
// Different hashes!
```

All existing hashes become invalid. This is documented as expected in IDEA.md but requires:
1. **Hard fork** at migration block
2. **Recompute all historical hashes** after SDK deploys new string serialization
3. **Consensus checkpoints** to validate fork boundary

### State Hashing (GCR)

GCR state changes are tracked in the database and in consensus proofs. If balance values change (due to genesis recalculation), all state hashes change.

**Implication:** Any consensus algorithm that commits to state hashes will see a fork.

---

## 9. GCRv2 & State Changes

**Status:** READY ✓ (with caveats)

### nativeAmount Field

Per IDEA.md Phase 1.6, the SDK defines `StateChange.nativeAmount: string`. The node does not define or import StateChange directly; it works with GCREdit instead:

**SDK Type (not used by node yet):**
```typescript
interface StateChange {
    nativeAmount: string;  // OS amount as string
    sender: BinaryBuffer;
    receiver: BinaryBuffer;
}
```

The node's GCREdit handling (GCRBalanceRoutines) converts amounts to BigInt, so will be compatible once SDK sends strings.

### GCREdit Type Assumptions

**File:** `/Users/tcsenpai/kynesys/node/src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` (line 26, 65)
```typescript
if (editOperation.amount <= 0) {
    return { success: false, message: "Invalid amount" }
}
if (actualBalance < editOperation.amount || actualBalance === 0n) {
```

Line 65 compares `bigint` (actualBalance) with `editOperation.amount`. If SDK sends `amount` as string:
- Comparison fails: `123n < "456"` is false (string comparison)
- **Must fix:** Coerce to BigInt: `actualBalance < BigInt(editOperation.amount)`

---

## 10. Native Bridges (Multichain)

**Status:** MINIMAL CODE — Safe

**File:** `/Users/tcsenpai/kynesys/node/src/features/multichain/routines/executors/pay.ts`

Bridge executors delegate to SDK's xm-localsdk. The node does not compute bridge amounts; it passes operation payloads through. Bridge-specific denomination handling is in the SDK.

**Risk:** If node and SDK versions mismatch during migration, bridge operations might serialize amounts differently.

---

## 11. Storage Program & TLSNotary Fees

**Status:** NOT FOUND — Fees handled elsewhere

The node does not define `STORAGE_PROGRAM_CONSTANTS` or `calculateStorageFee()` mentioned in IDEA.md Phase 2. These are SDK concepts. The node enforces custom charges through generic GCREdit operations.

### IPFS Custom Charges

No references to `max_cost_dem`, `max_cost_os`, or `IPFSCustomCharges` found in the node codebase. These are SDK-side. The node passes them through in transactions without interpretation.

### TLSNotary Fees

**File:** `/Users/tcsenpai/kynesys/node/src/features/tlsnotary/constants.ts`

Only service constants (ports, timeouts, buffer sizes). No fee definitions. TLSNotary pricing is handled by the SDK and stored in custom charges.

**Implication:** Node changes are not required for Phase 2 unless the TLSNotary integration layer in the SDK changes.

---

## 12. SDK Version & Denomination Utilities

**Status:** NOT MIGRATED

**package.json:**
```json
"@kynesyslabs/demosdk": "^2.11.4"
```

The SDK v2.11.4 does NOT export:
- `demToOs()`
- `osToDem()`
- `OS_PER_DEM`
- `denomination` module

The node does not import any denomination utilities. After SDK deploys Phase 0, the node must:
1. Update SDK version to the new major version
2. Import and use `demToOs()`, `toOsString()`, `parseOsString()` in all amount-handling code

---

## 13. Tests

**Status:** PARTIAL READINESS ✓

### Token Tests

**File:** `/Users/tcsenpai/kynesys/node/testing/loadgen/src/token_shared.ts` (lines 59-62, 74-76)
```typescript
if (typeof balRaw === "string") {
    try {
        const bal = BigInt(balRaw)
        if (bal >= minBalance) return
    }
}
```

Tests already handle `balance` as string and parse via BigInt. Tests are **ready** for SDK migration.

### Amount Tests

No explicit tests for amount parsing/validation found in the audit scope. Need to audit:
- `src/tests/*.ts` — unit tests
- `jest` test files — integration tests

Tests that hard-code numeric amounts (e.g., `amount: 100`) will fail after SDK migration unless converted to `amount: "100000000000"`.

---

## Cutover Risks

### 1. **Silent Precision Loss (CRITICAL)**

**Risk:** `parseInt(operation.params.amount)` truncates large OS amounts.

**Example:** OS amount `10000000000000000n` (sent as string by SDK) becomes `10000000000000000` via parseInt, but if the string came from a larger BigInt, the precision is lost silently.

**Mitigation:** Replace all `parseInt(amount)` with `BigInt(amount)` or `BigInt(operationAmount)`. Add assertions to validate round-trip: `BigInt(amount) === BigInt(amountString)`.

**Probability:** High if amounts approach or exceed 2^53 in OS units (unlikely but possible).

---

### 2. **Transaction Hash Mismatch (CRITICAL)**

**Risk:** Transaction hashes computed by node differ from SDK after amount serialization changes.

**Scenario:**
- SDK v2.11.4: Sends `tx.content = {amount: 100, ...}`
- Node hashes: `sha256("{\"amount\":100,...}")`
- SDK v3.0.0: Sends `tx.content = {amount: "100000000000", ...}`
- Node hashes: `sha256("{\"amount\":\"100000000000\",...}")`
- **Hashes don't match!**

**Mitigation:** Hard-fork protocol. At the block boundary where SDK deploys, recompute hashes using the new serialization. Update node consensus validation to accept both old and new formats during transition window.

**Probability:** Certain if SDK and node don't migrate atomically.

---

### 3. **Type Confusion in Balance Comparisons (CRITICAL)**

**Risk:** `actualBalance < editOperation.amount` when types differ.

**Scenario:**
- `actualBalance: 1000000000n` (bigint, OS)
- `editOperation.amount: "500000000"` (string, OS)
- Comparison: `1000000000n < "500000000"` → `false` (string < comparison)
- Funds subtracted despite insufficient balance check passing.

**Mitigation:** Coerce all amounts to BigInt in GCRBalanceRoutines and subOperations. Add type assertions.

**Probability:** High if SDK sends strings and node doesn't validate.

---

### 4. **Database Truncation (MODERATE)**

**Risk:** Fee columns are `integer` (32-bit); large OS fees are silently truncated.

**Example:** RPC fee `1000000000` OS stored in `integer` column → truncated or error.

**Mitigation:** Migrate fee columns to `bigint`.

**Probability:** Moderate; fees are typically small but OS amounts are much larger.

---

### 5. **JSON Serialization Failure (HIGH)**

**Risk:** `JSON.stringify(tx.content)` throws TypeError if `amount` is bigint.

**Scenario:**
- Node constructs `tx.content.amount = 1000000000n` (bigint)
- `JSON.stringify(tx.content)` → TypeError
- Transaction cannot be hashed or sent.

**Mitigation:** Ensure amounts are always strings or numbers before JSON serialization. Use `toOsString()` from SDK.

**Probability:** High if node code constructs bigint amounts and tries to serialize.

---

## Coordinated Migration Order

### Recommended Approach: **Node & SDK Ship Together**

The breaking changes (hash incompatibility, type changes) are unavoidable. A staged approach is not feasible.

#### **Day 1: SDK Releases Major Version**

1. SDK v3.0.0 (Phase 0–8 complete):
   - Exports `demToOs()`, `osToDem()`, `parseOsString()`, `toOsString()`
   - All amount fields in types are `string` (wire format)
   - Tests pass with new serialization
   - **NOT deployed to mainnet yet**

2. Node team:
   - Review and audit this new SDK version
   - Prepare node patches for precision loss, type mismatches
   - Hold release in staging

#### **Day 2: Coordinated Deployment**

1. SDK v3.0.0 deployed to **all SDKs and clients**
2. Node patches deployed to **all nodes** in a synchronized hard fork:
   - Update `subOperations` to use `BigInt()` instead of `parseInt()`
   - Add type guards in GCRBalanceRoutines
   - Update fee column definitions (bigint)
   - Update RPC response serialization to convert bigint to string
   - Update config defaults: `rpcFee: 10000000000` (10 DEM in OS)

3. Genesis recalculated using new SDK conversion utilities

4. Consensus checkpoint at fork block

#### **What Breaks If Order Is Wrong:**

**If SDK deploys first (without node):**
- SDK sends `amount: "1000000000"` strings
- Node's `parseInt()` works but becomes lossy
- Node's GCR balance comparisons fail (type mismatch)
- Transactions hang or are rejected
- RPC errors when trying to JSON.stringify bigint

**If node deploys first (without SDK):**
- Node expects strings but SDK sends numbers
- Node's BigInt coercions work (no error) but interpret DEM as OS
- Balances are 10^9x wrong
- Consensus breaks immediately

#### **Safest Order: Deploy Simultaneously**

1. Select a block N
2. Both SDK and node deploy code that **supports both formats** in a transition window:
   - Node accepts both `amount: number` and `amount: string`
   - SDK sends the new string format
   - Node validates the format dynamically
3. At block N, force the new format exclusively
4. Recompute all hashes from block N forward using the new serialization

---

## Summary Table

| Topic | Current | After Migration | Breaking? | Effort |
|-------|---------|-----------------|-----------|--------|
| Balance storage | bigint | bigint | ✓ No | None |
| Balance arithmetic | BigInt coerce | BigInt coerce | ✓ No | Minor |
| Fee storage | number/integer | bigint | ✓ Yes | Medium |
| TX validation (hash) | sha256(JSON) | sha256(JSON) | ✓ Yes | High |
| TX validation (amount) | parseInt() | BigInt() | ✓ Yes | High |
| RPC response | GCRMain directly | GCRMain + stringify | ✓ Yes | Medium |
| Genesis loading | parseInt() | BigInt() | ✓ Yes | Medium |
| Wire format | number | string | ✓ Yes | High |
| Type guards | None | Required | ✓ Yes | High |

---

## Recommendations

1. **Immediately (before SDK Phase 0 release):**
   - Add type assertions for `amount` in GCRBalanceRoutines and subOperations
   - Replace `parseInt(operation.params.amount, 10)` with `BigInt(operation.params.amount)`
   - Update fee columns in Transactions entity from `integer` to `bigint`
   - Add RPC response serialization to convert `balance: bigint` to `balance: string`

2. **When SDK Phase 0 is released:**
   - Update SDK dependency to the new major version
   - Import `demToOs()`, `toOsString()`, `parseOsString()` from SDK
   - Update config defaults for fees (multiply by OS_PER_DEM)
   - Run comprehensive integration tests with SDK

3. **Before production deployment:**
   - Dry-run genesis recalculation with new denomination
   - Validate consensus checkpoint logic
   - Test hard fork at specific block in staging
   - Ensure all test suites pass with both old and new serialization formats

4. **Post-migration:**
   - Monitor for precision loss (amount validation errors)
   - Verify all transactions hash correctly
   - Check RPC responses include string balances
   - Audit historical transactions for any lossy conversions

---

**End of Audit**
