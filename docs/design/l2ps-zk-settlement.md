# L2PS settlement with validator-checked zero-knowledge proofs

Status: design. Not implemented. Ships behind a new `l2psSettlement` fork,
dormant at launch.

## Problem

An L2PS subnet hides who paid whom and how much: each transfer is encrypted
with the subnet's AES-GCM key, and only member nodes hold that key. The
transfers still move L1 balances. Validators that are not members cannot
decrypt anything, so they need another way to know that the balance changes
a batch makes are the real result of its transfers.

The current code does not give them one. Checked on `stabilisation` at
`c7acb6b3`:

- Only the entry node applies a transfer's balance changes. It stores them in
  a local `l2ps_proofs` row (`L2PSBatchAggregator.ts:348`,
  `L2PSProofManager.ts:112-173`), and `L2PSConsensus.applyPendingProofs`
  (`L2PSConsensus.ts:160-237`) applies only rows the node holds itself. Every
  other validator never applies them, and the block hash does not cover
  balances, so the state diverges without anyone noticing (DEM-816).
- The PLONK proof in an `l2psBatch` transaction is checked only by the node
  that made it (`L2PSBatchAggregator.ts:685-715`). Block validation checks the
  relay signature, domain and hash (`validation/systemRelayTx.ts:62-124`) and
  never reads `zk_proof`.
- The proof's inputs are not the transfers. The aggregator reads the amount of
  the outer encrypted transaction, which the SDK always sets to 0
  (`demosdk/build/l2ps/l2ps.js:172`), and fills the balances with placeholders
  (`L2PSBatchAggregator.ts:534-573`). The proof states that zeros add up.
- A failed proof does not stop the batch: it is submitted without one
  (`L2PSBatchAggregator.ts:607-611`). A failed prover subprocess falls back to
  proving on the main thread (`L2PSBatchProver.ts:459-466`), which blocks the
  node for the length of a proof.

## Goal

1. Every validator applies the same balance changes for a batch, in the block
   that carries it, and Sync applies them the same way.
2. A validator applies those changes only if a proof shows they are exactly
   the net result of transfers that the senders signed, with no overdraft and
   no overflow.
3. Validators learn the net change per account, never the individual
   transfers.
4. The chain's liveness does not depend on proving: proving never runs on a
   node's main thread, and a batch without a valid proof never enters a block.

What stays public is the net change per touched account in a batch, because
it moves a public L1 balance. A batch with one transfer therefore reveals that
transfer. Hiding amounts from L1 entirely needs subnet-held balances with only
deposits and withdrawals on L1 (option C in DEM-816); that is a later, larger
change and this design does not close it off.

## Design

### Transfer commitment (SDK)

Each L2PS transfer carries, in plaintext on L1, a commitment

    c = Poseidon(from, to, amount, nonce, salt)

where `salt` is random and stays inside the encrypted payload. The sender
signs `c` with their account key, with a new signature domain. A validator
checks that signature against the public `from` without seeing `to` or
`amount`. Poseidon keeps the opening cheap in the circuit; proving SHA-256 of
the full transaction JSON instead would cost about 30K constraints per 64-byte
block, several hundred thousand per transfer.

### Settlement record (node)

The `l2psBatch` transaction gains, inside its signed content:

- `commitments`: the `c` of each transfer, in batch order.
- `settlement`: the net change per touched account, sorted by address, each a
  signed integer in OS.
- `proof`: the PLONK proof and its public signals.

### Circuit

`L2PSSettlement(N, M)`, N transfers and M touched accounts, M ≤ 2N.

Public inputs: a Poseidon hash over the N commitments, each commitment's
signer and nonce, the M account addresses, their balances before the batch
and their net changes.

Private inputs: each transfer's `from`, `to`, `amount`, `salt`, and the index
of its sender and receiver among the M accounts.

Constraints, per transfer:

- `Poseidon(from, to, amount, nonce, salt)` equals its public commitment, with
  the public nonce;
- `from` equals the commitment's public signer, so a member cannot sign a
  commitment that debits another account;
- `from` and `to` equal the accounts at the given indices (selector over M);
- the amount and the running balances are range-checked to 128 bits. 64 bits
  covers about 1.8 × 10^10 DEM at 10^9 OS per DEM, which a treasury account
  could exceed;
- the running sender balance does not go below zero, applied in batch order.

And for the whole batch: each account's balance after the last transfer minus
its balance before equals its public net change.

Balances before the batch are public L1 state, so validators supply them from
their own GCR instead of trusting the prover: the working state after every
earlier transaction in the block, L1 transfers and earlier batches included.
Two batches proven against the same parent balance cannot then both spend it.

Estimated size for N = 10: 30-40K PLONK constraints, against 24,263 for the
current `batch_10`. Proving time scales about linearly (15.3 s for 24K at 1.5
CPUs, measured in the rc.6 image), so about 20-25 s per batch. This is an
estimate to confirm on the first build.

### Validation (every validator, block and Sync)

For each `l2psBatch` in a block, once `l2psSettlement` is active:

1. Each commitment's signature verifies against its public signer, and its
   public nonce is fresh (nonce rule as for L1 transfers). The circuit ties
   both to the commitment, so a replay with another nonce needs a commitment
   the signer never signed.
2. The public inputs are rebuilt from the transaction and the validator's own
   working state at that transaction, never taken from the transaction.
3. The PLONK proof verifies against the committed key (about 50 ms).
4. The settlement is applied in block apply, in transaction order, by every
   validator and by Sync. A batch that fails any step makes the block invalid.

The local `l2ps_proofs` application path is removed once the fork is active.
That closes DEM-816.

Budget: at most 20 settlement batches per block, so proof checks add at most
about 1 s to block validation.

### Proving (subnet member nodes)

- The aggregator decrypts the batch (it is a member), builds the witness from
  the real transfers and the touched balances at its current tip, and proves
  in a subprocess. If any of those balances changes before the batch is
  included, validation fails and the batch goes back to the L2PS mempool to be
  proven again; an account that is busy on L1 can delay its subnet's batches.
- No main-thread fallback. A batch that cannot be proved stays in the L2PS
  mempool and is retried; it never goes out without a proof.
- Throughput is about one core per 0.5 transfer/s. A configurable pool of
  prover subprocesses scales it per node; a native PLONK prover is the next
  step if one core per subnet is not enough.

### Fork

`l2psSettlement`, added the same way as the other forks (`ForkName`,
`DEFAULT_FORK_CONFIG`, clone entry, `loadForkConfig`). Before activation the
current behaviour is unchanged. After activation, an `l2psBatch` without a
valid settlement is invalid, and old-format L2PS transfers are rejected at
admission.

## Launch stance

Until the fork is active, L2PS batch proofs stay off
(`L2PS_ZK_ENABLED=false`). The current proof shows nothing about the
transfers, so turning it on would cost CPU and claim a guarantee that is not
there. L2PS encryption works as before.

DEM-816 needs its own launch decision before the fork exists: either L2PS
transfers stop moving L1 balances until settlement ships (option 0 in
DEM-816), or the divergence is accepted and documented for the launch window.

## Plan

| Step | Work | Estimate |
|------|------|----------|
| 1 | Circuit `L2PSSettlement(10, 20)`, witness builder, constraint and proving-time check against the budget | 2 days |
| 2 | SDK: transfer commitment, signature domain, encrypted payload carries the salt | 1 day |
| 3 | Aggregator: settlement record, real witness, no fallback, prover pool | 2 days |
| 4 | Validation and apply in block and Sync behind the fork, remove the local apply path | 2 days |
| 5 | Tests: forged proof, wrong settlement, overdraft, replayed commitment, member not in subnet, Sync from scratch; DEM-816 divergence repro with `EXPECT=fixed` on a 4-validator devnet | 2 days |
| 6 | Load: main-chain TPS, L2PS TPS, block times, time to GCR, proof time, on 3 hosts | 1 day |

About 10 working days in total, before review.
