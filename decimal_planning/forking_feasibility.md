# Block-Height-Gated Hard Fork Feasibility Report

**Objective**: Assess the feasibility of adding a hard-fork mechanism to the Demos Network node to gating rule changes (specifically the DEM → OS denomination wire format migration: `amount` field changing from `number` to `string`).

**Executive Summary**: A hard-fork mechanism is **feasible and recommended**. The codebase has all required infrastructure at the right abstraction levels. Estimated effort: **Medium (M)** — a few days of focused work.

---

## 1. Existing Version/Upgrade Machinery

**Finding**: No hard-fork machinery exists today.

Grep results for fork/version keywords across the codebase:
- `forkHeight` — not found
- `hardFork` — not found
- `protocol_version` — mentioned only in L2PS proofs metadata, not used for rule gating
- `chainVersion`, `epoch`, `consensusVersion` — not found

The node currently has **no mechanism for gating behavior changes by block height**. This is a blank slate for design.

---

## 2. Block Height Availability at Validation/Serialization Sites

**Key Finding**: Block height is **readily available at all critical sites**. This is the strongest positive signal.

### 2.1 Transaction Validation Entry Points

**File**: `/Users/tcsenpai/kynesys/node/src/libs/blockchain/routines/validateTransaction.ts`

In `confirmTransaction()` at line 30-35:
```typescript
const referenceBlock = await Chain.getLastBlockNumber()
// ...
let validityData: ValidityData = {
    data: {
        valid: false,
        reference_block: referenceBlock,  // <-- Block height is already captured
        // ...
    }
}
```

**Status**: Block height (`referenceBlock`) is already fetched and available in the validation context. It's even stored in `ValidityData` for reference.

### 2.2 Block Proposal/Creation

**File**: `/Users/tcsenpai/kynesys/node/src/libs/consensus/v2/routines/createBlock.ts`

At line 12-18:
```typescript
export async function createBlock(
    orderedTransactions: Transaction[],
    commonValidatorSeed: string,
    previousBlockHash: string,
    blockNumber: number,  // <-- Block height is a formal parameter
    peerlist: Peer[],
): Promise<Block>
```

The function receives `blockNumber` as an explicit parameter. The block object is then constructed with `block.number = blockNumber` at line 34.

**Status**: Block height is fully threaded through block creation.

### 2.3 Serialization (Hash/Signature) Sites

**Files**: 
- `/Users/tcsenpai/kynesys/node/src/libs/blockchain/transaction.ts` (lines 108, 192, 269)
- `/Users/tcsenpai/kynesys/node/src/libs/consensus/v2/routines/createBlock.ts` (line 38)
- `/Users/tcsenpai/kynesys/node/src/libs/blockchain/chainGenesis.ts` (lines 45, 61)

All serialization sites hash with `Hashing.sha256(JSON.stringify(...))`:
- **Transaction**: `Hashing.sha256(JSON.stringify(tx.content))` at line 108
- **Block**: `Hashing.sha256(JSON.stringify(block.content))` at line 38 in createBlock

At transaction hash computation, the block number is accessible via `await Chain.getLastBlockNumber()` (already shown to be available).
At block hash computation, `block.number` is a field in the block object being hashed.

**Status**: Block height is available at all hashing/signing sites. No plumbing needed.

### 2.4 mempool Operations

**File**: `/Users/tcsenpai/kynesys/node/src/libs/utils/demostdlib/deriveMempoolOperation.ts`

The `createTransaction()` function (line 149) computes the hash with:
```typescript
transaction.hash = Hashing.sha256(JSON.stringify(transaction.content))
```

The block height would need to be passed in via `DerivableNative` data structure or fetched from chain at the time of derivation. This is a minor addition.

---

## 3. Serialization Layer Analysis

**Key Finding**: Single choke point for transaction and block serialization. This is ideal for a fork gate.

### 3.1 Where Serialization Happens

**Single call site for transaction hashing**:
- `Hashing.sha256(JSON.stringify(tx.content))` — appears in ~6 locations across:
  - `transaction.ts` (static methods for signing/hashing)
  - `deriveMempoolOperation.ts` (deriving new transactions)
  - `chainGenesis.ts` (genesis tx)
  - `gcr.ts` (internal GCR transactions)

All routes converge on `JSON.stringify(tx.content)`. The `content` object structure is defined in the TypeScript `TransactionContent` type from the SDK (`@kynesyslabs/demosdk/types`).

**Single call site for block hashing**:
- `Hashing.sha256(JSON.stringify(block.content))` — appears in ~2 locations:
  - `createBlock.ts` (consensus block creation)
  - `chainGenesis.ts` (genesis block)

All routes use `JSON.stringify(block.content)`. The `content` object is `BlockContent` from the SDK.

### 3.2 Fork Gate Placement

A fork gate for serialization can be inserted **before the `JSON.stringify()` call**, wrapped in a utility function:

```typescript
// New file: src/libs/blockchain/serialization/serializerGate.ts
export async function serializeTransactionContent(
  content: TransactionContent,
  blockNumber?: number
): Promise<string> {
  const height = blockNumber ?? await Chain.getLastBlockNumber()
  
  if (height >= FORK_HEIGHTS.osDenomination) {
    // Use new format (amount as string)
    return JSON.stringify(transformToNewFormat(content))
  } else {
    // Use old format (amount as number)
    return JSON.stringify(content)
  }
}
```

**Effort**: Replace 6 call sites with calls to `serializeTransactionContent()`. Low mechanical effort.

---

## 4. Genesis / Chain Config

**Finding**: Genesis config exists but is minimal. Easily extensible.

**File**: `/Users/tcsenpai/kynesys/node/data/genesis.json`

Current structure:
```json
{
  "properties": { "id": 1, "name": "DEMOS", "currency": "DEM" },
  "mutables": { "minBlocksForValidationOnlineStatus": 4 },
  "balances": [[pubkey, amount], ...],
  "timestamp": "...",
  "status": "confirmed"
}
```

**Proposed extension**:
```json
{
  "properties": { ... },
  "mutables": { ... },
  "forks": {
    "osDenomination": {
      "activationHeight": 12345,
      "description": "DEM→OS denomination change, amount field becomes string"
    }
  },
  "balances": [...],
  ...
}
```

**Loading in Shared State**:

Modify `/Users/tcsenpai/kynesys/node/src/utilities/sharedState.ts` to add:
```typescript
export default class SharedState {
    // ... existing fields ...
    forkHeights: Map<string, number> = new Map()
}
```

Load during node startup in genesis initialization:
```typescript
const genesisData = JSON.parse(fs.readFileSync(genesisPath))
if (genesisData.forks) {
    for (const [forkName, forkConfig] of Object.entries(genesisData.forks)) {
        getSharedState.forkHeights.set(forkName, forkConfig.activationHeight)
    }
}
```

**Effort**: ~1 hour to add config loading and thread fork heights into `SharedState`.

---

## 5. Database / State Implications (Block Sync & Dual Rules)

**Key Challenge**: After upgrade, the node must validate historical blocks (pre-fork) with old rules and new blocks (post-fork) with new rules.

### 5.1 Block Sync of Historical Blocks

When a node syncs, it replays blocks sequentially:

**File**: `/Users/tcsenpai/kynesys/node/src/libs/blockchain/routines/Sync.ts` (28919 bytes)

The sync routine fetches blocks from peers and calls `Chain.insertBlock()`. The block's `number` field is preserved from the peer.

**Scenario**: Node A at height 10000 syncs from Peer B at height 15000 (fork height 12000). Node A needs to:
1. Apply blocks 10001-11999 using **old serialization rules**
2. Apply blocks 12000+ using **new serialization rules**

The hash verification in `Transaction.isCoherent()` (line 269 in transaction.ts) recomputes hashes:
```typescript
const derivedHash = Hashing.sha256(JSON.stringify(tx.content))
const coherence = derivedHash === tx.hash
```

If block height is **passed into** `serializeTransactionContent()`, the coherence check will use the correct serializer for each block's height. **This works without needing schema migration**.

### 5.2 Validator Validation Flow

When a block is received and validated:

**File**: `/Users/tcsenpai/kynesys/node/src/libs/blockchain/routines/validateTransaction.ts`

At line 35, `referenceBlock` is captured. The block being proposed/validated has a number. Pass this to the serializer:

```typescript
// In confirmTransaction():
const blockNumber = block?.number ?? referenceBlock
const isCoherent = await Transaction.isCoherent(tx, blockNumber)
```

Then in `Transaction.isCoherent()`:
```typescript
static async isCoherent(tx: Transaction, blockNumber?: number) {
    const serialized = await serializeTransactionContent(tx.content, blockNumber)
    const derivedHash = Hashing.sha256(serialized)
    // ... rest
}
```

### 5.3 Storage Layer Implications

**Good news**: The storage layer (TypeORM + PostgreSQL) stores the `content` as a JSONB field. The serialization gate sits **above** the database layer, so:

- **Pre-fork blocks in DB**: Store the old serialized content (amount as number)
- **Post-fork blocks in DB**: Store the new serialized content (amount as string)
- **No schema migration needed**: The `content` column is agnostic to the inner structure

When reading from DB and revalidating, pass the block height to the serializer — it will use the correct format.

**Effort**: Add optional `blockNumber` parameter to validation functions; thread through 3-4 call sites.

---

## 6. Effort Estimate (T-Shirt Sizing)

Based on findings (1)-(5):

| Task | Effort | Notes |
|------|--------|-------|
| Add `forks` config to genesis.json | S | 10 min — simple JSON extension |
| Load fork heights into `SharedState` | S | ~1 hour — trivial initialization code |
| Create serialization gate function | M | ~2 hours — wrap `JSON.stringify()`, thread block height |
| Update transaction hashing sites | S | ~1 hour — ~6 call sites, mechanical replacements |
| Update block hashing sites | S | ~30 min — ~2 call sites |
| Update validation/coherence checks | M | ~2 hours — pass blockNumber through call chain |
| Testing (unit + integration) | M | ~4-6 hours — dual-format validation, sync regression |
| **Total** | **M** | **~12-15 hours (~2 person-days)** |

**Rating: MEDIUM (M)**. No showstoppers. Block height is already available at all critical sites. Serialization is a single choke point. Database is format-agnostic.

---

## 7. Alternative: Dual-Format Acceptance Window

This approach asks: "Can the node accept both wire formats (amount as number OR string) during a transition window?"

### 7.1 Feasibility Assessment

**Idea**: SDK ships new format (amount as string). Node accepts both. Old SDK clients keep working (send amount as number). New SDK clients send amount as string. After all clients upgrade, drop number support.

**Problem — Fatal Flaw**: Hash mismatch.

When a transaction is received with `amount: "100"` (string), the node must validate the signature. The signature was computed by the client as:

```
signature = sign(sha256(JSON.stringify({..., amount: "100", ...})))
```

If the node deserializes the same bytes differently (parsing `"100"` as `100` before stringifying):

```
// In Node validation:
derivedHash = sha256(JSON.stringify({..., amount: 100, ...}))  // Different!
// Signature verification fails
```

The transaction hash and signature become **incompatible with the new format**. The node cannot round-trip — it cannot verify the same transaction in two different formats.

### 7.2 Why Dual-Format Fails

**Byte-level commitment**: Signatures commit to the exact bytes of the serialized content. Changing serialization changes those bytes. There is no "accepting both formats" for hashing/signing — only one canonical form per block height.

### 7.3 Why Hard Fork Works

A hard fork sets a height N:
- **Height < N**: Node uses old serializer → verifies old-format signatures.
- **Height ≥ N**: Node uses new serializer → verifies new-format signatures.

All nodes switch at height N in lockstep. No dual-format acceptance needed. No hash ambiguity.

**Conclusion**: Dual-format window is **not viable for this migration**. Only the hard-fork approach works.

---

## 8. Recommendation

### **Hard Fork (RECOMMENDED)**

**Why**:
1. **Block height is available everywhere** — no threading pain.
2. **Serialization has a single choke point** — clean integration.
3. **Database is format-agnostic** — no schema migration.
4. **Dual-format is infeasible** — signature/hash incompatibility.
5. **Moderate effort** — 2 person-days, not a major undertaking.
6. **Cleaner than network reset** — preserves historical state; users see continuous ledger.
7. **Upgradeable pattern** — once proven, can be extended for future forks.

### **Sketch of Implementation**

**File Structure**:
```
src/libs/blockchain/forks/
├── forkConfig.ts           # Load fork heights from genesis
├── forkGates.ts            # Helper functions like isForkActive(name, height)
└── serializerGate.ts       # Conditional serialization based on block height

src/utilities/
└── sharedState.ts          # Add forkHeights: Map<string, number>
```

**Core Gate Function**:
```typescript
// src/libs/blockchain/forks/serializerGate.ts
import { FORK_HEIGHTS } from './forkConfig'
import Hashing from '@/libs/crypto/hashing'

export async function serializeTransactionContent(
  content: TransactionContent,
  blockHeight?: number
): Promise<string> {
  const height = blockHeight ?? await Chain.getLastBlockNumber()
  
  if (height >= FORK_HEIGHTS.osDenomination) {
    // Post-fork: amount is already string in content (or convert if needed)
    return JSON.stringify(content)
  } else {
    // Pre-fork: ensure amount is number for backward compat
    const legacyContent = { ...content }
    if (typeof legacyContent.amount === 'string') {
      legacyContent.amount = parseFloat(legacyContent.amount)
    }
    return JSON.stringify(legacyContent)
  }
}

export function isForkActive(forkName: string, blockHeight: number): boolean {
  const height = FORK_HEIGHTS[forkName]
  return height !== undefined && blockHeight >= height
}
```

**Genesis Config Extension**:
```json
{
  "forks": {
    "osDenomination": {
      "activationHeight": 12345
    }
  }
}
```

**Call Sites (Example)**:
```typescript
// Before:
const hash = Hashing.sha256(JSON.stringify(tx.content))

// After:
const serialized = await serializeTransactionContent(tx.content, block?.number)
const hash = Hashing.sha256(serialized)
```

### **Not Recommended: Network Reset**

A full network reset is **unnecessary and destructive**:
- Loses historical state and audit trail.
- Forces all users to resync genesis.
- More operationally complex than a coordinated fork.

Only resort to this if:
- A critical consensus bug prevents soft fork.
- The chain has been compromised beyond recovery.

Neither applies here.

---

## 9. Conclusion

**The node has all infrastructure necessary for a block-height-gated hard fork.**

| Criterion | Status | Impact |
|-----------|--------|--------|
| Existing fork machinery | ✗ None | Start fresh (low risk) |
| Block height at validation | ✓ Available | Can gate without threading |
| Block height at serialization | ✓ Available | Can gate serializers directly |
| Single serialization point | ✓ Yes | Clean integration site |
| Database flexibility | ✓ Format-agnostic | No schema migration |
| Dual-format viability | ✗ Infeasible | Hard fork is the only path |
| **Effort** | **MEDIUM** | **2 person-days** |

**Recommended path**: Implement hard fork. Expected effort 12-15 hours. No blockers.

---

## Appendix: Key File Locations

| File | Lines | Purpose |
|------|-------|---------|
| `src/libs/blockchain/transaction.ts` | 583 | Transaction class, signing, hashing, validation |
| `src/libs/consensus/v2/routines/createBlock.ts` | 74 | Block creation, receives blockNumber |
| `src/libs/blockchain/routines/validateTransaction.ts` | 274 | Tx validation, fetches current block height |
| `src/utilities/sharedState.ts` | 409 | Singleton config state |
| `src/libs/blockchain/chainGenesis.ts` | 142 | Genesis block generation |
| `data/genesis.json` | 42 | Genesis config file |
| `src/libs/crypto/hashing.ts` | 27 | Hashing utility (sha256) |

