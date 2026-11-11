# L2PS settlement with validator-checked zero-knowledge proofs

Status: in implementation. Ships behind a new `l2psSettlement` fork, active
from mainnet block 0. The binding formats are in "Interface v1" below.

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
it moves a public L1 balance, and each transfer's signer and nonce, which
validators need to check the signature and freshness. A batch with one
transfer therefore reveals that transfer, and in any batch an observer can
count a signer's transfers and follow their nonce order. Larger batches hide
only what the net changes cannot separate: when each signer sends once and the
amounts differ (−4 and −9 out, +4 and +9 in), every transfer can still be
matched. Amount privacy on L1 holds only for transfers that net out against
others in the same batch. Hiding amounts from L1 entirely needs subnet-held balances with only
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
  signed integer in OS with magnitude below 2^128, sent as a sign and a
  magnitude. Validators reject any value outside that range before turning it
  into field elements, and apply the same signed integer they verified, so a
  field wrap (a 1 OS debit read as a credit of p − 1) cannot pass.
- `proof`: the PLONK proof and its public signals.

### Circuit

`L2PSSettlement(N, M)`, up to N transfers and up to M touched accounts,
M = 2N. A batch with fewer fills the tail with inactive slots: each slot has a
public `active` flag, active slots come first, an inactive account slot has
address, balance and change 0 and is never indexed by a transfer, and an
inactive transfer slot has commitment 0 and touches no account. The strict
address order applies to active slots only, so one circuit serves every batch
up to its size.

Public inputs: a Poseidon hash over the N commitments, each commitment's
signer and nonce, the M account addresses, their balances before the batch
and their net changes.

Private inputs: each transfer's `from`, `to`, `amount`, `salt`, and the index
of its sender and receiver among the M accounts.

Constraints, per transfer:

- `Poseidon(from, to, amount, nonce, salt)` equals commitment i, with the
  public nonce, and the Poseidon hash over the N commitments so computed
  equals the public commitments hash. Validators compute that hash from the
  transaction's `commitments`, so the proof covers exactly the signed
  transfers;
- `from` equals the commitment's public signer, so a member cannot sign a
  commitment that debits another account;
- `from` and `to` equal the accounts at the given indices (selector over M);
- the amount and the running balances are range-checked to 128 bits. 64 bits
  covers about 1.8 × 10^10 DEM at 10^9 OS per DEM, which a treasury account
  could exceed;
- the running sender balance does not go below zero, applied in batch order.

And for the whole batch: each account's balance after the last transfer minus
its balance before equals its public net change. The M addresses are strictly
increasing, which the circuit checks and validators check before verifying,
so one account cannot appear twice with the same balance spent from each.

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

### Admission and the queue (subnet member nodes)

A member admits a transfer only if a batch could still place it, and the
aggregator keeps transfers it cannot place from crowding out the rest. The
bounds are constants in the code, not configuration, so every member admits
and expires the same transfers.

- Nonce: above the sender's L1 account nonce and at most `MAX_NONCE_AHEAD`
  = 20 (two full batches) past it, and not a nonce this member already holds
  unsettled for the sender. So a sender has at most 20 unsettled transfers on
  one member.
- Balance: the sender's tip balance covers `amount + fee` of this transfer
  plus every unsettled transfer this member holds for it (amounts and nonces
  from the history, fees from the stored envelopes).
- Deferred: when the planner can place none of the transfers left in a
  cycle, they become `deferred`. Deferred rows are read in a window of their
  own next to the window of fresh rows, so they never keep fresh transfers
  from being read; each re-deferral moves a row to the back. A deferred
  transfer settles as soon as a batch can place it, and fails with a history
  reason `SETTLEMENT_DEFERRED_TTL_BLOCKS` = 300 blocks (about 35 minutes)
  after admission. The backlog cap counts deferred rows.
- Blame: a transfer whose batch failed twice, at proving or on L1, is proved
  alone from then on, so the transfers batched with it settle without it.
  One that also fails twice alone is dropped with a reason, but only once
  another proof (for proving failures) or another batch (for L1 failures)
  has worked since its first failure alone; a prover or verifier that fails
  everything drops nothing. A transfer whose account keeps moving on L1
  between proving and inclusion can be dropped this way and is signed again.
- The prover back-off is per subnet; other subnets keep settling.

### Fork

`l2psSettlement`, added the same way as the other forks (`ForkName`,
`DEFAULT_FORK_CONFIG`, clone entry, `loadForkConfig`). Before activation the
current behaviour is unchanged. After activation, an `l2psBatch` without a
valid settlement is invalid, and old-format L2PS transfers are rejected at
admission.

## Interface v1

Binding for the SDK, the circuit and the node. The node code is
`src/libs/l2ps/settlement/encoding.ts`; `__fixtures__/settlementVectors.json`
pins the commitment, the signed message and the signature, and the SDK
tests the same file.

### Encoding

- Sizes: N = 10 transfer slots, M = 20 account slots per proof.
- Account: `0x` + 64 lowercase hex. In the circuit it is two 128-bit limbs,
  `hi` = first 16 bytes, `lo` = last 16 bytes, both big-endian.
- Amount, fee, balance and net change magnitude: below 2^128. Nonce: below
  2^64. Salt: 31 random bytes, below 2^248.
- Commitment: `c = Poseidon8(from_hi, from_lo, to_hi, to_lo, amount, fee,
  nonce, salt)`, circomlib Poseidon (poseidon-lite on both sides).
- Signed message: UTF-8 of
  `l2ps-settlement:v1:<chainId>:<l2psUid>:<c as 0x + 64 hex>`, ed25519 by
  the sender's account key. It cannot be read as a transaction preimage
  (`demos-tx:v1:`) or a personal message.
- Commitments hash: `Poseidon10(c_0 .. c_9)`, inactive slots 0.
- Nonce: the sender's L1 account nonce. The transfers of one signer in a
  batch carry consecutive nonces from the account's nonce + 1, in batch
  order, and settlement spends them. An L1 transaction that takes a nonce
  first makes the transfer void; the subnet drops it.
- Fee: per transfer, public, at least the node's native transfer fee. The
  sender pays `amount + fee`. The fee is distributed as an L1 native fee
  (`generateFeeDistributionEdits`, network fee = `fee`).

### Public signals (171)

    commitmentsHash,
    transferActive[N], signerHi[N], signerLo[N], nonce[N], fee[N],
    accountActive[M], accountHi[M], accountLo[M], balanceBefore[M],
    deltaNegative[M], deltaMagnitude[M]

Active slots come first and inactive slots are all zero. `delta` is the
account's whole balance change, fees included, so `sum(delta) = -sum(fee)`.

Private per transfer slot: `toHi`, `toLo`, `amount`, `salt`, `senderIndex`,
`receiverIndex`.

Circuit constraints, in addition to "Circuit" above:
- `transferActive` and `accountActive` are bits and non-increasing (active
  prefix); an inactive slot has every public value 0 and touches nothing;
- signer limbs equal the sender account's limbs at `senderIndex`, the
  receiver's at `receiverIndex`, indices below M and pointing at active
  accounts;
- running balances in batch order: the sender is debited `amount + fee`,
  then the receiver credited `amount`; every running balance stays in
  [0, 2^128);
- `deltaNegative` is a bit, `deltaMagnitude` is below 2^128, magnitude 0
  has `deltaNegative` 0, and `balanceAfter - balanceBefore` equals the signed
  delta;
- active accounts strictly increasing by `(hi, lo)`.

### Transaction

The `l2psBatch` payload (`data[1]`) gains, inside the signed content:

    settlement: {
      version: 1,
      transfers: [{ commitment: "0x..", signer: "0x..", nonce: "<dec>",
                    fee: "<dec>", signature: "0x.." }],      // batch order
      changes:   [{ account: "0x..", delta: "<signed dec>" }], // sorted, unique
      proof: <snarkjs PLONK proof JSON>
    }

Balances before are never in the transaction: each validator reads them from
its working state at that transaction. Public signals are rebuilt, never
read from the transaction.

The encrypted inner transfer (SDK) is a native send whose `data[1]` carries
`settlement: { fee, salt, commitment, signature }` and whose `content.nonce`
is the settlement nonce. Members recompute `c` from the decrypted transfer
and refuse a mismatch.

### Apply

With the fork active, an `l2psBatch` is applied in `HandleGCR.applyTransactions`
(forge, block validation and Sync share it). Every check fails the
transaction (included as failed, no edits), never the block, because every
validator reaches the same verdict:

1. structure and limits; changes sorted and unique; every signer and
   every receiver-side account named in `changes`; the fee distribution
   credits exactly the fees (a fee floor that is not an amount, or a
   distribution that credits less, fails every batch of the block, not the
   block); every `changes` account, a zero delta included, is loaded and
   orders the batch with the block's other transactions over it;
2. each signature over its message; per-signer nonces consecutive from the
   working-state nonce + 1; each fee at least the native transfer fee;
3. public signals from the working state; PLONK verify against the
   committed key `src/libs/l2ps/zk/keys/settlement_10/verification_key.json`;
4. apply each delta, add the transfer count to each signer's nonce, credit
   each fee's distribution edits without their sender debit (the delta
   already holds it).

The local `l2ps_proofs` path (`L2PSConsensus.applyPendingProofs`) and
`L2PSProofManager.createProof` stop when the fork is active, and members
refuse old-format transfers at admission.

## Launch stance

`l2psSettlement` is active from mainnet block 0. Old-format L2PS transfers
are refused from the start, so DEM-816 never exists on mainnet.

## Plan

| Step | Work | Estimate | Status |
|------|------|----------|--------|
| 1 | Circuit `L2PSSettlement(10, 20)`, witness builder, constraint and proving-time check against the budget | 2 days | In progress (`feat/l2ps-settlement-circuit`) |
| 2 | SDK: transfer commitment, signature domain, encrypted payload carries the salt | 1 day | Open |
| 3 | Aggregator: settlement record, real witness, no fallback, prover pool | 2 days | Node side done: plan, prove in the subprocess, submit at the tip, follow each batch, re-plan a failed one; the planner and prover come with step 1 |
| 4 | Validation and apply in block and Sync behind the fork, remove the local apply path | 2 days | Done: block apply and Sync share `HandleGCR.applyTransactions`; caps of 10 transfers, 20 changes and 20 batches per block; the local proof path and the hash update stop under the fork |
| 5 | Tests: forged proof, wrong settlement, overdraft, replayed commitment, member not in subnet, Sync from scratch; DEM-816 divergence repro with `EXPECT=fixed` on a 4-validator devnet | 2 days | Unit tests done; the devnet repro waits for the real planner and prover |
| 6 | Load: main-chain TPS, L2PS TPS, block times, time to GCR, proof time, on 3 hosts | 1 day | Open |

About 10 working days in total, before review.
