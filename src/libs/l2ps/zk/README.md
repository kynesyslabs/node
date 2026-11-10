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

### 1. Keys

The release image ships the proving keys, built at image build time by
`scripts/build-l2ps-zk-keys.ts`. On a source install, build them with the
setup wizard; it uses the circom2 and snarkjs in `node_modules`, so no native
circom is needed:

```bash
bun run setup --only zk --zk --zk-generate
```

This downloads the Hermez Powers of Tau files 16 and 17 (about 225 MB, from
circom.info) and writes about 90 MB of proving keys. The build fails unless
the derived verification keys equal the committed ones, which is also the
integrity check on the download.

### 2. Turn proofs on

Batch proofs are off by default, even when the keys are present: validators do
not check them yet (`docs/design/l2ps-zk-settlement.md`), and each proof takes
a core for seconds. The proof inputs are also placeholders: the aggregator
uses neutral balances and the batch hash as the initial root, so a proof shows
only that each amount fits in 64 bits, not that the batch's transfers are
correct. The settlement design replaces them with the real balances.

To turn them on, add `L2PS_ZK_ENABLED=true` to the node's `.env` (Docker) or
deployment environment, or export it before starting from a shell, then
restart the node:

```bash
export L2PS_ZK_ENABLED=true
```

### 3. Usage

With `L2PS_ZK_ENABLED=true`, the `L2PSBatchAggregator` starts the prover when
it starts, and its batches carry a `zk_proof`. A batch still goes out without
a proof when the prover cannot start (for example, the keys are missing; the
next start tries again) or when a proof fails after startup (the subprocess
exits, or the proof does not verify locally):

```typescript
const aggregator = L2PSBatchAggregator.getInstance()
await aggregator.start()
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
│   ├── l2ps_batch_5.circom     # 1-5 transactions (12,133 PLONK constraints)
│   └── l2ps_batch_10.circom    # 6-10 transactions (24,263 PLONK constraints)
├── scripts/
│   └── setup_all_batches.sh    # Compiles circuits & generates keys
├── tests/
│   └── batch_prover_test.ts    # Integration test
├── snarkjs.d.ts                # TypeScript declarations
└── circomlibjs.d.ts            # TypeScript declarations
```

**Generated (gitignored):**
```
├── keys/                       # about 90 MB proving keys
│   ├── batch_5/
│   └── batch_10/
└── ptau/                       # about 225 MB Powers of Tau (build input only)
```

## Performance

Measured 2026-11-10 in the v1.0.0-rc.6 image with `--cpus 1.5`, through
`L2PSBatchProver` in its subprocess, three runs each:

| Circuit  | Transactions | PLONK constraints | Proof (p50) | Verification |
|----------|--------------|-------------------|-------------|--------------|
| batch_5  | 1-5          | 12,133            | 7.8 s       | 50-230 ms    |
| batch_10 | 6-10         | 24,263            | 15.3 s      | about 50 ms  |

Proofs are built one at a time, so one node proves about 0.65 transactions
per second per subnet. The prover is single-threaded and takes one core while
it runs.

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
