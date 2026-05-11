# Gas Fee Separation — Implementation Plan

> **Target:** Hard fork. No backward compatibility required.
> **Scope:** Separate the single lump-sum gas deduction into three fee components (`network_fee`, `rpc_fee`, `additional_fee`) with distinct distribution rules, plus refactor special-operation fees.

---

## ⚠️ As-shipped status (read first)

The plan below is the original DEM-665 specification text. **The implementation that landed deviates intentionally** based on findings during execution (Linear DEM-665 design comment, 2026-05-11). Read the deviations before working from the spec verbatim.

### Final design (locked 2026-05-11)

- **Combined fork**: `gasFeeSeparation` rides on the **same `activationHeight`** as `osDenomination`. One coordinated event, one coordinated chain wipe.
- **`fee_config` does NOT live at the top level of `genesis.json`.** The original plan's §2 was rejected after verifying `chainGenesis.ts:60-73` — `block.content.extra` is part of the hashed payload, so a top-level `fee_config` would change the genesis hash and break re-sync. The plan claim that "adding `fee_config` doesn't change the hash" is wrong.
- **Split storage**:
  - `treasuryAddress` ships as **fork-payload** under `forks.gasFeeSeparation` (fork-fixed, immutable for the chain's lifetime).
  - `burnAddress` is a **code constant** in `src/forks/migrations/gasFeeSeparation.ts:BURN_ADDRESS` (`0x` + 64 zeros). Not in genesis. Never rotates.
  - Distribution percentages (50/50, 25/75, 25/50/25) ship as **governance-mutable `NetworkParameters` keys** from day 1, with tighter safety bounds (±10% per proposal, sum-100 cross-key invariant).
- **rpc_address tx field**: fork-gated. Pre-fork: `null` on all txs. Post-fork: stamped by the validating node in `confirmTransaction` (DEM-665 P6).
- **`burnFee` scalar**: retired. Replaced by per-component burn-percentage fields.
- **SDK companion**: 4.0.0-rc.1 (pending publish; user owns).

### Where in the code

| Concern | File:line |
|---|---|
| Fork registry + treasury fork-payload | `src/forks/forkConfig.ts` |
| Validation (treasury lowercase hex, placeholder rejection) | `src/forks/loadForkConfig.ts:validateGasFeeSeparationEntry` |
| State migration (burn + treasury account creation) | `src/forks/migrations/gasFeeSeparation.ts` |
| Activation hook | `src/libs/blockchain/chainBlocks.ts:235-260` |
| Per-component fee math | `src/libs/blockchain/routines/calculateCurrentGas.ts:calculateFeeBreakdown` |
| Fee-distribution edit generator | `src/libs/blockchain/gcr/gcr_routines/feeDistribution.ts` |
| `confirmTransaction` wiring | `src/libs/blockchain/routines/validateTransaction.ts:applyGasFeeSeparation` |
| TLSN fork-gated branches | `src/libs/blockchain/gcr/gcr_routines/handleNativeOperations.ts` (`tlsn_request`, `tlsn_store`) |
| Burn-address spend prevention | `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` |
| Governance keys + cross-key sum-100 invariant | `src/features/networkUpgrade/constants.ts`, `src/features/networkUpgrade/safetyBounds.ts` |
| Activation runbook | `decimal_planning/RUNBOOK_FORK_ACTIVATION.md` §9 |

### Test coverage

| Suite | File | Tests |
|---|---|---|
| Fork loader | `testing/forks/loadForkConfig.test.ts` | 29 |
| State migration | `testing/forks/migrations/gasFeeSeparation.test.ts` | 16 |
| Per-component math | `tests/governance/calculateCurrentGas.test.ts` | 8 |
| Governance bounds | `tests/governance/safetyBounds.test.ts` | 31 |
| Fee-distribution edit generator | `tests/blockchain/feeDistribution.test.ts` | 16 |
| Burn-address spend prevention | `tests/blockchain/GCRBalanceRoutines.test.ts` | 8 |
| TLSN fork-gating | `tests/blockchain/handleNativeOperations.test.ts` | 5 |

Total: **113 DEM-665-specific tests across 7 suites**. Pre-fork legacy behaviour is preserved in every branch (verified by the "pre-fork" arm of each fork-gated test).

### Deferred (filed as follow-ups)

- **myc#100 (P10b)** — devnet integration rehearsal scenarios 09 (fee-distribution boundary cross) and 10 (burn-spend rejection).
- **myc#101 (P10c)** — extract `applyGasFeeSeparation` from `validateTransaction.ts` for direct unit testing.
- **DEM-665 P9** — publish SDK 4.0.0-rc.1 (user-owned), bump node `package.json` pin from 3.1.0 to 4.0.0-rc.1, drop the local `node_modules/@kynesyslabs/demosdk/build` overlay.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Genesis Configuration Changes](#2-genesis-configuration-changes)
3. [Fee Constants & Decimal Upgrade (9 decimals)](#3-fee-constants--decimal-upgrade-9-decimals)
4. [Transaction Structure — Add `rpc_address`](#4-transaction-structure--add-rpc_address)
5. [Gas Calculation Refactor — Split Fee Components](#5-gas-calculation-refactor--split-fee-components)
6. [GCREdit Generation — Separate Edits Per Fee Component](#6-gcredit-generation--separate-edits-per-fee-component)
7. [Burn Address Setup](#7-burn-address-setup)
8. [Special Operations (TLSN) Fee Distribution](#8-special-operations-tlsn-fee-distribution)
9. [Validation & Balance Check](#9-validation--balance-check)
10. [SDK Changes (External)](#10-sdk-changes-external)
11. [File-by-File Change Summary](#11-file-by-file-change-summary)
12. [Testing Checklist](#12-testing-checklist)

---

## 1. Architecture Overview

### Current Flow (Before)

```
TX created → single composedGas calculated → single "pay_gas" Operation → single "remove" GCREdit
```

All gas is calculated as: `payloadSize * (baseGas * congestionFactor + rpcFee)` and deducted from sender via a single `remove` GCREdit. For TLSN operations, a flat fee (1 DEM) is burned via `remove` with no recipient.

### New Flow (After)

```
TX created → 3 fee components calculated separately → rpc_address captured
            → per-component GCREdits generated:
               network_fee:    50% → burn address, 50% → treasury
               rpc_fee:        100% → rpc_address (from ValidityData)
               additional_fee: 75% → treasury, 25% → burn address
            → special ops (TLSN): 25% burn, 50% rpc operator, 25% treasury
```

### Fee Distribution Summary

| Component | Burn % | Treasury % | RPC Operator % |
|-----------|--------|------------|----------------|
| `network_fee` | 50 | 50 | 0 |
| `rpc_fee` | 0 | 0 | 100 |
| `additional_fee` | 25 | 75 | 0 |
| `special_ops` (TLSN) | 25 | 25 | 50 |

### Key Addresses (from genesis.json)

- **Burn address:** `0x0000000000000000000000000000000000000000000000000000000000000000` (64 hex chars = 32 bytes)
- **Treasury address:** Defined in genesis.json `fee_config.treasury_address`

---

## 2. Genesis Configuration Changes

### File: `/home/user/node/data/genesis.json`

**Current content:**
```json
{
    "properties": {
        "id": 1,
        "name": "DEMOS",
        "currency": "DEM"
    },
    "mutables": {
        "minBlocksForValidationOnlineStatus": 4
    },
    "balances": [
        ["0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c", "1000000000000000000"],
        ...
    ],
    "timestamp": "1692734616",
    "status": "confirmed"
}
```

**Add the following top-level key:**

```json
{
    "properties": { ... },
    "mutables": { ... },
    "fee_config": {
        "burn_address": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "treasury_address": "<INSERT_TREASURY_ED25519_PUBKEY_HEX>",
        "distribution": {
            "network_fee": { "burn_pct": 50, "treasury_pct": 50, "rpc_operator_pct": 0 },
            "rpc_fee": { "burn_pct": 0, "treasury_pct": 0, "rpc_operator_pct": 100 },
            "additional_fee": { "burn_pct": 25, "treasury_pct": 75, "rpc_operator_pct": 0 },
            "special_ops": { "burn_pct": 25, "treasury_pct": 25, "rpc_operator_pct": 50 }
        },
        "decimals": 9
    },
    "balances": [ ... ],
    ...
}
```

### File: `/home/user/node/src/libs/blockchain/chain.ts` (lines ~600-660)

In `generateGenesisBlock()`, after the user accounts are created (around line 655), **create the burn address and treasury address as GCR accounts**:

```typescript
// After the user account batch creation loop (around line 655):

// Create burn address account (balance starts at 0)
const feeConfig = genesisData.fee_config
if (feeConfig) {
    await HandleGCR.createAccount(feeConfig.burn_address, { balance: 0n })
    await HandleGCR.createAccount(feeConfig.treasury_address, { balance: 0n })
    log.info("[GENESIS] Burn and treasury accounts created")
}
```

### File: `/home/user/node/src/utilities/sharedState.ts`

Add genesis fee config to SharedState so it's accessible globally. Add these fields to the `SharedState` class (around line 165, near `rpcFee`):

```typescript
// Fee distribution config (loaded from genesis)
feeConfig: {
    burnAddress: string
    treasuryAddress: string
    distribution: {
        network_fee: { burn_pct: number; treasury_pct: number; rpc_operator_pct: number }
        rpc_fee: { burn_pct: number; treasury_pct: number; rpc_operator_pct: number }
        additional_fee: { burn_pct: number; treasury_pct: number; rpc_operator_pct: number }
        special_ops: { burn_pct: number; treasury_pct: number; rpc_operator_pct: number }
    }
    decimals: number
} | null = null
```

Then in chain.ts `generateGenesisBlock()` or wherever genesis is loaded/parsed, populate this:

```typescript
if (genesisData.fee_config) {
    getSharedState.feeConfig = {
        burnAddress: genesisData.fee_config.burn_address,
        treasuryAddress: genesisData.fee_config.treasury_address,
        distribution: genesisData.fee_config.distribution,
        decimals: genesisData.fee_config.decimals,
    }
}
```

**Important:** Also ensure this is loaded during node startup from the stored genesis block (not just during genesis generation). Search for where genesis data is read on normal boot and replicate the loading there.

---

## 3. Fee Constants & Decimal Upgrade (9 decimals)

### File: `/home/user/node/src/libs/blockchain/gcr/gcr_routines/handleNativeOperations.ts`

**Current constants (line 8-11):**
```typescript
const TLSN_REQUEST_FEE = 1
const TLSN_STORE_BASE_FEE = 1
const TLSN_STORE_PER_KB_FEE = 1
```

**Replace with 9-decimal versions (1 DEM = 1_000_000_000 base units):**
```typescript
// 1 DEM = 10^9 base units (9 decimals)
const DEM_DECIMALS = 9
const ONE_DEM = 10 ** DEM_DECIMALS // 1_000_000_000

const TLSN_REQUEST_FEE = 1 * ONE_DEM        // 1 DEM
const TLSN_STORE_BASE_FEE = 1 * ONE_DEM     // 1 DEM
const TLSN_STORE_PER_KB_FEE = 1 * ONE_DEM   // 1 DEM per KB
```

> **Note:** The genesis balances are already stored as `"1000000000000000000"` (18-digit strings). Verify what the intended balance representation is. If those values are meant to be "1 billion DEM" with no decimals, then with 9 decimals each genesis account would have `1_000_000_000 * 10^9 = 10^18` base units — which matches the existing values. **No genesis balance changes needed.**

---

## 4. Transaction Structure — Add `rpc_address`

### Rationale

The `ValidityData` already contains `rpc_public_key` (set in `validateTransaction.ts:50-56`), but this data is not persisted with the transaction and is not available during block processing (GCREdit application). We need to embed the RPC operator's address in the transaction's fee structure so it's available when distributing fees.

### File: `/home/user/node/src/libs/blockchain/transaction.ts`

**Current `transaction_fee` structure (lines 67-71):**
```typescript
transaction_fee: {
    network_fee: null,
    rpc_fee: null,
    additional_fee: null,
},
```

**Change to:**
```typescript
transaction_fee: {
    network_fee: null,
    rpc_fee: null,
    additional_fee: null,
    rpc_address: null,  // Ed25519 public key hex of the RPC node that relayed this tx
},
```

### File: `/home/user/node/src/libs/blockchain/transaction.ts` — `toRawTransaction()` (lines 461-463)

**Current:**
```typescript
networkFee: tx.content.transaction_fee.network_fee,
rpcFee: tx.content.transaction_fee.rpc_fee,
additionalFee: tx.content.transaction_fee.additional_fee,
```

**Change to:**
```typescript
networkFee: tx.content.transaction_fee.network_fee,
rpcFee: tx.content.transaction_fee.rpc_fee,
additionalFee: tx.content.transaction_fee.additional_fee,
rpcAddress: tx.content.transaction_fee.rpc_address,
```

### File: `/home/user/node/src/libs/blockchain/transaction.ts` — `fromRawTransaction()` (lines 497-501)

**Current:**
```typescript
transaction_fee: {
    network_fee: rawTx.networkFee,
    rpc_fee: rawTx.rpcFee,
    additional_fee: rawTx.additionalFee,
},
```

**Change to:**
```typescript
transaction_fee: {
    network_fee: rawTx.networkFee,
    rpc_fee: rawTx.rpcFee,
    additional_fee: rawTx.additionalFee,
    rpc_address: rawTx.rpcAddress,
},
```

### File: `/home/user/node/src/model/entities/Transactions.ts`

**Add column (after line 59):**
```typescript
@Column("varchar", { name: "rpcAddress", nullable: true })
rpcAddress: string
```

### File: `/home/user/node/src/libs/blockchain/routines/validateTransaction.ts`

In `confirmTransaction()`, after validation succeeds (around line 103), **populate the `rpc_address`** from the node's own public key (since this node IS the RPC that validated the tx):

```typescript
// After line 103: validityData.data.valid = true
// Embed RPC address in transaction fee structure for fee distribution
tx.content.transaction_fee.rpc_address = uint8ArrayToHex(
    (await ucrypto.getIdentity(getSharedState.signingAlgorithm)).publicKey as Uint8Array
)
```

This value is the same as `validityData.rpc_public_key.data` (line 52-54), ensuring consistency.

### SDK Changes (see Section 10)

The `TransactionContent` type in the SDK must also be updated to include `rpc_address` in `transaction_fee`. The SDK source is at `../sdks` — look for the compiled counterpart referenced via `@kynesyslabs/demosdk/types`.

---

## 5. Gas Calculation Refactor — Split Fee Components

### File: `/home/user/node/src/libs/blockchain/routines/calculateCurrentGas.ts`

**Current code (full file, 59 lines):**
```typescript
import { getSharedState } from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"
import Chain from "../chain"
import GCR from "../gcr/gcr"
import Transaction from "../transaction"

async function calculateComposedGas(): Promise<number> {
    const lastBlockBaseGas: number = await GCR.getGCRLastBlockBaseGas()
    const factor = await adaptGasToCongestion()
    const adaptedGas = lastBlockBaseGas * factor
    const composedGas = adaptedGas + getSharedState.rpcFee
    return composedGas
}

async function adaptGasToCongestion(): Promise<number> {
    const lastBlockNumber = await Chain.getLastBlockNumber()
    if (lastBlockNumber == 0) { return 0 }
    const previousLastBlockNumber = lastBlockNumber - 1
    const lastBlock = await Chain.getBlockByNumber(lastBlockNumber)
    const previousLastBlock = await Chain.getBlockByNumber(previousLastBlockNumber)
    const lastBlockTimestamp = lastBlock.content.timestamp
    const previousLastBlockTimestamp = previousLastBlock.content.timestamp
    const difference = lastBlockTimestamp - previousLastBlockTimestamp
    const blockTime = getSharedState.block_time * 1000
    let factor = 1
    if (difference > blockTime) {
        const drift = difference - blockTime
        factor = 1 + (1.5 * drift) / blockTime
    }
    return factor
}

export default async function calculateCurrentGas(payload: any): Promise<number> {
    const payloadSize = sizeOf(payload)
    const composedGasPrice = await calculateComposedGas()
    const transactionFee = payloadSize * composedGasPrice
    return transactionFee
}
```

**Replace the entire file with:**

```typescript
import { getSharedState } from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"
import Chain from "../chain"
import GCR from "../gcr/gcr"

export interface FeeBreakdown {
    network_fee: number   // base gas * congestion, proportional to payload size
    rpc_fee: number       // RPC operator's fee, proportional to payload size
    additional_fee: number // dApp fees (future use, currently 0)
    total: number          // sum of all components
}

/**
 * Calculate base network gas adjusted for congestion
 */
async function calculateNetworkGas(): Promise<number> {
    const lastBlockBaseGas: number = await GCR.getGCRLastBlockBaseGas()
    const factor = await adaptGasToCongestion()
    return lastBlockBaseGas * factor
}

/**
 * Adapt gas to network congestion based on block time drift
 */
async function adaptGasToCongestion(): Promise<number> {
    const lastBlockNumber = await Chain.getLastBlockNumber()
    if (lastBlockNumber == 0) {
        return 0
    }
    const previousLastBlockNumber = lastBlockNumber - 1
    const lastBlock = await Chain.getBlockByNumber(lastBlockNumber)
    const previousLastBlock = await Chain.getBlockByNumber(previousLastBlockNumber)
    const lastBlockTimestamp = lastBlock.content.timestamp
    const previousLastBlockTimestamp = previousLastBlock.content.timestamp
    const difference = lastBlockTimestamp - previousLastBlockTimestamp
    const blockTime = getSharedState.block_time * 1000
    let factor = 1
    if (difference > blockTime) {
        const drift = difference - blockTime
        factor = 1 + (1.5 * drift) / blockTime
    }
    return factor
}

/**
 * Calculate separated fee components for a transaction
 * Returns individual fee components and total
 */
export async function calculateFeeBreakdown(payload: any): Promise<FeeBreakdown> {
    const payloadSize = sizeOf(payload)
    const networkGasPrice = await calculateNetworkGas()

    const network_fee = payloadSize * networkGasPrice
    const rpc_fee = payloadSize * getSharedState.rpcFee
    const additional_fee = 0 // Reserved for future dApp fees

    return {
        network_fee,
        rpc_fee,
        additional_fee,
        total: network_fee + rpc_fee + additional_fee,
    }
}

/**
 * @deprecated Use calculateFeeBreakdown() for separated fee components.
 * Kept for backward compatibility during migration.
 */
export default async function calculateCurrentGas(payload: any): Promise<number> {
    const breakdown = await calculateFeeBreakdown(payload)
    return breakdown.total
}
```

---

## 6. GCREdit Generation — Separate Edits Per Fee Component

This is the core of the change. Instead of a single "remove" GCREdit for the total gas fee, we generate **multiple GCREdits** per fee component, distributing to burn address, treasury, and RPC operator.

### New Utility: `/home/user/node/src/libs/blockchain/gcr/gcr_routines/feeDistribution.ts`

**Create this new file:**

```typescript
import { GCREdit } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

export interface FeeDistributionInput {
    senderAddress: string
    rpcAddress: string
    networkFee: number
    rpcFee: number
    additionalFee: number
    txHash: string
    isRollback: boolean
}

/**
 * Generate GCREdits for fee distribution according to genesis fee_config.
 *
 * Distribution rules (from genesis):
 * - network_fee:    50% burned, 50% treasury
 * - rpc_fee:        100% to RPC operator
 * - additional_fee: 75% treasury, 25% burned
 *
 * Each fee is first removed from the sender, then added to the respective recipients.
 */
export function generateFeeDistributionEdits(input: FeeDistributionInput): GCREdit[] {
    const edits: GCREdit[] = []
    const feeConfig = getSharedState.feeConfig

    if (!feeConfig) {
        log.error("[FeeDistribution] No fee config found in shared state. Cannot distribute fees.")
        return edits
    }

    const { burnAddress, treasuryAddress, distribution } = feeConfig
    const { senderAddress, rpcAddress, txHash, isRollback } = input

    // --- NETWORK FEE ---
    if (input.networkFee > 0) {
        const dist = distribution.network_fee
        const burnAmount = Math.floor(input.networkFee * dist.burn_pct / 100)
        const treasuryAmount = input.networkFee - burnAmount // remainder to treasury (avoids rounding loss)

        // Remove total network_fee from sender
        edits.push({
            type: "balance",
            operation: "remove",
            isRollback,
            account: senderAddress,
            txhash: txHash,
            amount: input.networkFee,
        })

        // Add burn portion to burn address
        if (burnAmount > 0) {
            edits.push({
                type: "balance",
                operation: "add",
                isRollback,
                account: burnAddress,
                txhash: txHash,
                amount: burnAmount,
            })
        }

        // Add treasury portion to treasury address
        if (treasuryAmount > 0) {
            edits.push({
                type: "balance",
                operation: "add",
                isRollback,
                account: treasuryAddress,
                txhash: txHash,
                amount: treasuryAmount,
            })
        }
    }

    // --- RPC FEE ---
    if (input.rpcFee > 0 && rpcAddress) {
        // Remove rpc_fee from sender
        edits.push({
            type: "balance",
            operation: "remove",
            isRollback,
            account: senderAddress,
            txhash: txHash,
            amount: input.rpcFee,
        })

        // Add 100% to RPC operator
        edits.push({
            type: "balance",
            operation: "add",
            isRollback,
            account: rpcAddress,
            txhash: txHash,
            amount: input.rpcFee,
        })
    }

    // --- ADDITIONAL FEE ---
    if (input.additionalFee > 0) {
        const dist = distribution.additional_fee
        const burnAmount = Math.floor(input.additionalFee * dist.burn_pct / 100)
        const treasuryAmount = input.additionalFee - burnAmount

        // Remove additional_fee from sender
        edits.push({
            type: "balance",
            operation: "remove",
            isRollback,
            account: senderAddress,
            txhash: txHash,
            amount: input.additionalFee,
        })

        if (burnAmount > 0) {
            edits.push({
                type: "balance",
                operation: "add",
                isRollback,
                account: burnAddress,
                txhash: txHash,
                amount: burnAmount,
            })
        }

        if (treasuryAmount > 0) {
            edits.push({
                type: "balance",
                operation: "add",
                isRollback,
                account: treasuryAddress,
                txhash: txHash,
                amount: treasuryAmount,
            })
        }
    }

    log.debug(`[FeeDistribution] Generated ${edits.length} GCREdits for tx ${txHash}: ` +
        `network=${input.networkFee}, rpc=${input.rpcFee}, additional=${input.additionalFee}`)

    return edits
}

/**
 * Generate GCREdits for special operation fee distribution (TLSN).
 *
 * Distribution: 25% burn, 50% RPC operator, 25% treasury
 */
export function generateSpecialOpsFeeEdits(
    senderAddress: string,
    rpcAddress: string,
    totalFee: number,
    txHash: string,
    isRollback: boolean,
): GCREdit[] {
    const edits: GCREdit[] = []
    const feeConfig = getSharedState.feeConfig

    if (!feeConfig) {
        log.error("[FeeDistribution] No fee config for special ops.")
        return edits
    }

    const { burnAddress, treasuryAddress, distribution } = feeConfig
    const dist = distribution.special_ops

    const burnAmount = Math.floor(totalFee * dist.burn_pct / 100)
    const rpcAmount = Math.floor(totalFee * dist.rpc_operator_pct / 100)
    const treasuryAmount = totalFee - burnAmount - rpcAmount // remainder

    // Remove total fee from sender
    edits.push({
        type: "balance",
        operation: "remove",
        isRollback,
        account: senderAddress,
        txhash: txHash,
        amount: totalFee,
    })

    if (burnAmount > 0) {
        edits.push({
            type: "balance",
            operation: "add",
            isRollback,
            account: burnAddress,
            txhash: txHash,
            amount: burnAmount,
        })
    }

    if (rpcAmount > 0 && rpcAddress) {
        edits.push({
            type: "balance",
            operation: "add",
            isRollback,
            account: rpcAddress,
            txhash: txHash,
            amount: rpcAmount,
        })
    }

    if (treasuryAmount > 0) {
        edits.push({
            type: "balance",
            operation: "add",
            isRollback,
            account: treasuryAddress,
            txhash: txHash,
            amount: treasuryAmount,
        })
    }

    return edits
}
```

---

## 7. Burn Address Setup

### Approach

Use a designated burn address (`0x0000...0000`, 32 zero bytes = 64 hex chars with `0x` prefix) instead of the current "remove without add" pattern.

### What changes:

1. **Genesis:** Create account at burn address with balance 0 (see Section 2).

2. **Prevent spending from burn address.** In `GCRBalanceRoutines.ts` (line 19-23 area), add a check:

```typescript
// In GCRBalanceRoutines.apply(), after editOperationAccount is resolved:
if (editOperation.operation === "remove" &&
    getSharedState.feeConfig &&
    editOperationAccount === getSharedState.feeConfig.burnAddress) {
    return { success: false, message: "Cannot deduct from burn address" }
}
```

3. **Existing "remove" GCREdits in `handleNativeOperations.ts`** for TLSN operations become `remove` from sender + `add` to burn/treasury/rpc using `generateSpecialOpsFeeEdits()`.

### Benefits over current "remove" approach:
- O(1) query to see total burned (check burn address balance)
- Transparent: any user can monitor burn address
- Audit trail: all transfers are standard GCREdits

---

## 8. Special Operations (TLSN) Fee Distribution

### File: `/home/user/node/src/libs/blockchain/gcr/gcr_routines/handleNativeOperations.ts`

**Full rewrite needed.** The TLSN operations currently burn fees via `operation: "remove"`. Replace with `generateSpecialOpsFeeEdits()`.

**Current `tlsn_request` block (lines 53-79):**
```typescript
case "tlsn_request": {
    const [targetUrl] = nativePayload.args as [string]
    // ... URL validation ...
    const burnFeeEdit: GCREdit = {
        type: "balance",
        operation: "remove",
        isRollback: isRollback,
        account: tx.content.from as string,
        txhash: tx.hash,
        amount: TLSN_REQUEST_FEE,
    }
    edits.push(burnFeeEdit)
    break
}
```

**Replace with:**
```typescript
case "tlsn_request": {
    const [targetUrl] = nativePayload.args as [string]
    log.info(`[TLSNotary] Processing tlsn_request for ${targetUrl} from ${tx.content.from}`)

    // Validate URL format
    try {
        extractDomain(targetUrl)
        log.debug(`[TLSNotary] URL validated: ${targetUrl}`)
    } catch {
        log.error(`[TLSNotary] Invalid URL in tlsn_request: ${targetUrl}`)
        throw new Error("Invalid URL in tlsn_request")
    }

    // Distribute fee: 25% burn, 50% RPC operator, 25% treasury
    const rpcAddress = tx.content.transaction_fee.rpc_address
    const feeEdits = generateSpecialOpsFeeEdits(
        tx.content.from as string,
        rpcAddress,
        TLSN_REQUEST_FEE,
        tx.hash,
        isRollback,
    )
    edits.push(...feeEdits)
    break
}
```

**Similarly for `tlsn_store` (lines 82-147):**

Replace the `burnStorageFeeEdit` block with:
```typescript
// Distribute storage fee: 25% burn, 50% RPC operator, 25% treasury
const rpcAddress = tx.content.transaction_fee.rpc_address
const storageFeeEdits = generateSpecialOpsFeeEdits(
    tx.content.from as string,
    rpcAddress,
    storageFee,
    tx.hash,
    isRollback,
)
edits.push(...storageFeeEdits)
```

**Add import at top of file:**
```typescript
import { generateSpecialOpsFeeEdits } from "./feeDistribution"
```

---

## 9. Validation & Balance Check

### Where gas fees become GCREdits

Currently, gas fee handling is mostly **commented out** in `validateTransaction.ts` (see the `/* REVIEW */` block at lines 58-72). The `defineGas()` function exists but is not called — the comment says "GCREdits take care of the gas operation."

The actual GCREdits for gas must be generated somewhere before the transaction enters the mempool. Looking at the flow:

1. `server_rpc.ts` receives TX → calls `confirmTransaction()` in `validateTransaction.ts`
2. `confirmTransaction()` validates signature, creates `ValidityData`
3. `broadcastVerifiedNativeTransaction()` calls `executeNativeTransaction()`
4. At mempool entry, `HandleGCR.applyToTx()` applies `tx.content.gcr_edits`

**The gas fee GCREdits must be injected into `tx.content.gcr_edits` during validation.**

### File: `/home/user/node/src/libs/blockchain/routines/validateTransaction.ts`

In `confirmTransaction()`, after validation succeeds (around line 103), **calculate fees and inject GCREdits**:

```typescript
import { calculateFeeBreakdown } from "src/libs/blockchain/routines/calculateCurrentGas"
import { generateFeeDistributionEdits } from "src/libs/blockchain/gcr/gcr_routines/feeDistribution"

// ... inside confirmTransaction(), after line 103 (validityData.data.valid = true):

// Calculate separated fees
const feeBreakdown = await calculateFeeBreakdown(tx)

// Set fee fields on transaction
tx.content.transaction_fee.network_fee = feeBreakdown.network_fee
tx.content.transaction_fee.rpc_fee = feeBreakdown.rpc_fee
tx.content.transaction_fee.additional_fee = feeBreakdown.additional_fee

// Set RPC address (this node validated the tx)
const rpcPubKeyHex = uint8ArrayToHex(
    (await ucrypto.getIdentity(getSharedState.signingAlgorithm)).publicKey as Uint8Array
)
tx.content.transaction_fee.rpc_address = rpcPubKeyHex

// Check sender can afford total fees
const senderAddress = typeof tx.content.from === "string" ? tx.content.from : forgeToHex(tx.content.from)
const senderBalance = await GCR.getGCRNativeBalance(senderAddress)
if (senderBalance < feeBreakdown.total && getSharedState.PROD) {
    validityData.data.message = `[Tx Validation] Insufficient balance for fees. Required: ${feeBreakdown.total}, Available: ${senderBalance}`
    validityData.data.valid = false
    validityData = await signValidityData(validityData)
    return validityData
}

// Generate fee distribution GCREdits and prepend to tx's gcr_edits
const feeEdits = generateFeeDistributionEdits({
    senderAddress,
    rpcAddress: rpcPubKeyHex,
    networkFee: feeBreakdown.network_fee,
    rpcFee: feeBreakdown.rpc_fee,
    additionalFee: feeBreakdown.additional_fee,
    txHash: tx.hash,
    isRollback: false,
})

// Prepend fee edits so they are applied BEFORE the tx's own operations
tx.content.gcr_edits = [...feeEdits, ...tx.content.gcr_edits]
```

**Important:** The `defineGas()` function (lines 126-230) is currently unused (the call is commented out at lines 58-72). It can be removed or left as-is since we're replacing it with the new fee calculation logic above.

### Balance check remains as total

The balance check validates `senderBalance < feeBreakdown.total` — a single check against the sum of all components, as agreed.

---

## 10. SDK Changes (External)

The SDK source code lives at `../sdks` (relative to the node repo root). The compiled SDK is referenced in the node via `@kynesyslabs/demosdk`. Changes needed:

### 1. `TransactionContent` type — add `rpc_address` to `transaction_fee`

Find the type definition for `TransactionContent` in the SDK source. The `transaction_fee` object needs:
```typescript
transaction_fee: {
    network_fee: number | null
    rpc_fee: number | null
    additional_fee: number | null
    rpc_address: string | null    // NEW: RPC node's ed25519 public key hex
}
```

### 2. `RawTransaction` type — add `rpcAddress` field

```typescript
rpcAddress?: string  // NEW
```

### 3. `GCREdit` type — verify it supports `account` as string and `amount` as number

The current GCREdit type (from SDK) should already support this based on usage in the codebase:
```typescript
interface GCREdit {
    type: string
    operation: string
    isRollback?: boolean
    account: string
    txhash: string
    amount?: number
    data?: any
}
```

### 4. After SDK changes, rebuild and update `package.json` dependency version

---

## 11. File-by-File Change Summary

| File | Action | Lines Affected |
|------|--------|---------------|
| `data/genesis.json` | Add `fee_config` block | New section |
| `src/utilities/sharedState.ts` | Add `feeConfig` field | ~165 |
| `src/libs/blockchain/chain.ts` | Load fee config, create burn/treasury accounts in genesis | ~600-660 |
| `src/libs/blockchain/transaction.ts` | Add `rpc_address` to `transaction_fee` in constructor, `toRawTransaction()`, `fromRawTransaction()` | 67-71, 461-463, 497-501 |
| `src/model/entities/Transactions.ts` | Add `rpcAddress` column | After line 59 |
| `src/libs/blockchain/routines/calculateCurrentGas.ts` | Full rewrite: export `FeeBreakdown` and `calculateFeeBreakdown()` | Entire file |
| `src/libs/blockchain/routines/validateTransaction.ts` | Inject fee calculation, balance check, and fee GCREdits into `confirmTransaction()` | After line 103 |
| `src/libs/blockchain/gcr/gcr_routines/feeDistribution.ts` | **NEW FILE**: `generateFeeDistributionEdits()`, `generateSpecialOpsFeeEdits()` | New file |
| `src/libs/blockchain/gcr/gcr_routines/handleNativeOperations.ts` | Update constants to 9 decimals; replace `remove` burns with `generateSpecialOpsFeeEdits()` | 8-11, 66-75, 113-122 |
| `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` | Add burn address spend prevention | After line 22 |
| `src/libs/libs/utils/demostdlib/deriveMempoolOperation.ts` | No changes needed (fees are set from DerivableNative, which is populated externally) | — |
| `src/libs/blockchain/gcr/handleGCR.ts` | No changes needed (applies GCREdits generically) | — |
| `src/libs/consensus/v2/PoRBFT.ts` | No changes needed (applies GCREdits generically via HandleGCR) | — |
| `../sdks/.../TransactionContent` | Add `rpc_address` to `transaction_fee` type | SDK source |
| `../sdks/.../RawTransaction` | Add `rpcAddress` field | SDK source |

### Database Migration

A TypeORM migration is needed to add the `rpcAddress` column to the `transactions` table:

```sql
ALTER TABLE transactions ADD COLUMN "rpcAddress" varchar NULL;
```

---

## 12. Testing Checklist

- [ ] Genesis creates burn address account with balance 0
- [ ] Genesis creates treasury address account with balance 0
- [ ] `feeConfig` is populated in `SharedState` from genesis
- [ ] `calculateFeeBreakdown()` returns correct `network_fee`, `rpc_fee`, `additional_fee`
- [ ] `rpc_address` is set on transaction during `confirmTransaction()`
- [ ] Fee GCREdits are prepended to `tx.content.gcr_edits`
- [ ] For a regular tx: `network_fee` split 50/50 burn/treasury, `rpc_fee` 100% to RPC, `additional_fee` 75/25 treasury/burn
- [ ] For `tlsn_request`: 1 DEM (with 9 decimals = 1_000_000_000 base units) split 25/50/25 burn/rpc/treasury
- [ ] For `tlsn_store`: Size-based fee split 25/50/25 burn/rpc/treasury
- [ ] Burn address balance increases correctly (not spendable)
- [ ] Treasury address balance increases correctly
- [ ] RPC operator address balance increases correctly
- [ ] Sender balance decreases by exact total fee amount
- [ ] Attempting to spend from burn address fails
- [ ] Rollbacks correctly reverse all fee distribution edits
- [ ] `toRawTransaction()` and `fromRawTransaction()` preserve `rpc_address`
- [ ] Transaction entity saves and loads `rpcAddress` from DB
- [ ] Balance check rejects tx when sender cannot afford total fees
- [ ] Non-PROD mode allows negative balance (existing behavior preserved)

---

## Execution Order

1. **SDK changes first** (add `rpc_address` to types, rebuild)
2. **Genesis config** (genesis.json + SharedState + chain.ts loading)
3. **DB migration** (add `rpcAddress` column)
4. **calculateCurrentGas.ts** refactor (export `FeeBreakdown`)
5. **feeDistribution.ts** (new file — core distribution logic)
6. **transaction.ts** (add `rpc_address` field)
7. **Transactions.ts** entity (add column)
8. **validateTransaction.ts** (wire everything together)
9. **handleNativeOperations.ts** (TLSN fee distribution + 9-decimal constants)
10. **GCRBalanceRoutines.ts** (burn address protection)
11. **Testing**
