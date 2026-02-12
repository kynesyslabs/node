# L2PS PLONK Proof System

Zero-knowledge proof system for L2PS batch transactions using PLONK.

## Overview

Generates ZK-SNARK proofs for L2PS transaction batches. Supports up to **10 transactions per batch** with automatic circuit size selection (5 or 10 tx).

## Why PLONK?

| Feature | PLONK | Groth16 |
|---------|-------|---------|
| Trusted Setup | Universal (one-time) | Circuit-specific |
| Circuit Updates | No new ceremony | Requires new setup |
| Proof Size | ~1KB | ~200B |
| Verification | ~15ms | ~5ms |

**PLONK is ideal for L2PS** because circuits may evolve and universal setup avoids coordination overhead.

## Quick Start

### 1. Install circom (one-time)
```bash
curl -Ls https://scrypt.io/scripts/setup-circom.sh | sh
```

### 2. Generate ZK Keys (~2 minutes)
```bash
cd src/libs/l2ps/zk/scripts
./setup_all_batches.sh
```

This downloads ptau files (~200MB) and generates proving keys (~350MB).

### 3. Usage

The `L2PSBatchAggregator` automatically uses ZK proofs when keys are available:

```typescript
// Automatic integration - just start the aggregator
const aggregator = L2PSBatchAggregator.getInstance()
await aggregator.start()
// Batches will include zk_proof field when keys are available
```

Manual usage:
```typescript
import { L2PSBatchProver } from './zk/L2PSBatchProver'

const prover = new L2PSBatchProver()
await prover.initialize()

const proof = await prover.generateProof({
    transactions: [
        { senderBefore: 1000n, senderAfter: 900n, receiverBefore: 500n, receiverAfter: 600n, amount: 100n }
    ],
    initialStateRoot: 12345n
})

const valid = await prover.verifyProof(proof)
```

## File Structure

```
zk/
├── L2PSBatchProver.ts          # Main prover class (auto-selects batch size)
├── circuits/
│   ├── l2ps_batch_5.circom     # 1-5 transactions (~37K constraints)
│   └── l2ps_batch_10.circom    # 6-10 transactions (~74K constraints)
├── scripts/
│   └── setup_all_batches.sh    # Compiles circuits & generates keys
├── tests/
│   └── batch_prover_test.ts    # Integration test
├── snarkjs.d.ts                # TypeScript declarations
└── circomlibjs.d.ts            # TypeScript declarations
```

**Generated (gitignored):**
```
├── keys/                       # ~1GB proving keys
│   ├── batch_5/
│   ├── batch_10/
│   └── batch_20/
└── ptau/                       # ~500MB powers of tau
```

## Performance

| Batch Size | Constraints | Proof Generation | Verification |
|------------|-------------|------------------|--------------|
| 5 tx       | 37K         | ~20s             | ~15ms        |
| 10 tx      | 74K         | ~40s             | ~15ms        |
| 20 tx      | 148K        | ~80s             | ~15ms        |

## Graceful Degradation

If ZK keys are not generated, the system continues without proofs:
- `L2PSBatchAggregator` logs a warning at startup
- Batches are submitted without `zk_proof` field
- Run `setup_all_batches.sh` to enable proofs

## Circuit Design

Each circuit proves batch of balance transfers:
- **Public inputs**: initial_state_root, final_state_root, total_volume
- **Private inputs**: sender/receiver balances before/after, amounts
- **Constraints**: Poseidon hashes for state chaining, balance arithmetic

Unused slots are padded with zero-amount transfers.
