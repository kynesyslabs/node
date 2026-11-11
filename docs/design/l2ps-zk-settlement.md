# L2PS settlement with validator-checked zero-knowledge proofs

Status: in implementation. Ships behind a new `l2psSettlement` fork, active
from mainnet block 0. The binding formats are in "Interface v1" and "Interface v1.1" below.

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

The statement: a Poseidon hash over the N commitments, each commitment's
signer and nonce, the M account addresses, their balances before the batch
and their net changes. Its one public input is a hash of the statement
("Interface v1.1"), which every validator computes from its own values.

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

Measured for N = 9, M = 18 (`l2ps_settlement.circom`, Interface v1.1,
2026-11-11, 32-core host shared with other load):

| | |
|---|---|
| R1CS | 18,642 non-linear + 17,482 linear constraints, 35,931 wires, 1 public input |
| PLONK | 65,388 constraints, domain 2^16 (Hermez ptau 16), 148 rows to spare |
| Proving key | 101 MB zkey, 4.0 MB wasm |
| Key build | about 5 s and 3.3 GB for the PLONK setup; byte-identical zkey from the setup path and a separate manual build |
| Proof | 33-40 s per batch in the prover subprocess (Bun, one core), whatever the number of transfers; peak 1.0 GB (1.3 GB without the GC hint the pool sets) |
| Verify | 16 ms median, 17 ms worst of 20 warm runs; the first call also builds the curve once per process |

Batch size options, measured the same way (time per proof in the Bun
prover subprocess, one core):

| Option | PLONK rows | Domain | zkey | Proof | Peak | Transfers/s per core |
|---|---|---|---|---|---|---|
| v1: N = 10, 171 public inputs | 55,860 | 2^16 | 1.88 GB | 44-59 s | 4 GB | 0.2 |
| v1.1: N = 7 | 58,955 (before the trims below) | 2^16 | 101 MB | 33 s | 1.0 GB | 0.21 |
| **v1.1: N = 9** | 65,388 | 2^16 | 101 MB | 33-40 s | 1.0 GB | **0.24** |
| v1.1: N = 10 | 74,821 | 2^17 | 201 MB | 74 s | about 1.7 GB | 0.14 |
| v1.1: N = 14 | 106,953 | 2^17 | 203 MB | 73 s | 1.75 GB | 0.19 |
| v1.1: N = 24, 32 | about 222,000 and 312,000 | 2^18, 2^19 | not built | | | |

Proving time follows the domain, not the number of transfers, so the batch
is the largest N that fits a domain. N = 9 is the largest at 2^16; at 2^17
the largest is N = 16 (the commitments hash, `Poseidon_N`, stops at 16
inputs in circomlib and poseidon-lite), which proves twice as long for at
most 16/9 the transfers. N = 32 would need another commitments hash (an
Interface v1 change), a 2^19 domain and about 8 times the proving time per
proof. With 4 GB of prover memory a node runs four N = 9 provers for about
0.95 transfers/s; v1 ran one for 0.2.

Multi-threaded proving: snarkjs worker threads never finish under Bun (no
proof after 150 s at 1% CPU). Under Node.js the N = 9 batch proves in 28 s
with worker threads (2.6 GB, 2.3 cores busy) against 46 s single-threaded
(0.6 GB): 1.4 times faster per proof but 0.14 transfers/s per core against
Bun's 0.24, so the pool scales with single-threaded Bun processes. Witness
generation alone takes about 60 ms.

Range checks: witness values (amount, fee, nonce) and every running balance
are range-checked inside the circuit, so the balance arithmetic cannot wrap.
Balances before, net change magnitudes and account limbs are hashed as whole
field elements, so they are exactly the verifier's values, and the verifier
accepts none outside its declared range (`verifySettlementProof` rejects any
public signal outside it, which also rules out aliases at or above the field
order, and `settlementPublicHash` refuses to hash one). The circuit alone
accepts a magnitude or a balance of p - x; the tests show both, and that no
verifier hashes them. Checking them in the circuit as well would cross 2^16
rows and double the proving time. The account ordering keeps accounts unique
for any limb values (the argument is in the circuit). Every active account
must be touched by an active transfer, so the account list is exactly the
touched set.

### Validation (every validator, block and Sync)

For each `l2psBatch` in a block, once `l2psSettlement` is active:

1. Each commitment's signature verifies against its public signer, and its
   public nonce is fresh (nonce rule as for L1 transfers). The circuit ties
   both to the commitment, so a replay with another nonce needs a commitment
   the signer never signed.
2. The public inputs are rebuilt from the transaction and the validator's own
   working state at that transaction, never taken from the transaction.
3. The PLONK proof verifies against the committed key, with the hash of the
   rebuilt signals as its public input (about 20 ms).
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
- Throughput is about one core and 1 GB per 0.24 transfer/s (a full batch of
  9 in about 38 s). A configurable pool of prover subprocesses
  (`L2PS_SETTLEMENT_PROVERS`) scales it per node; a native PLONK prover is
  the next step if one core per subnet is not enough.

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

- Sizes: N = 9 transfer slots, M = 18 account slots per proof
  (`SETTLEMENT_TRANSFERS`; see "Circuit" for why 9).
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
- Commitments hash: `Poseidon_N(c_0 .. c_(N-1))` (Poseidon9 for N = 9),
  inactive slots 0.
- Nonce: the sender's L1 account nonce. The transfers of one signer in a
  batch carry consecutive nonces from the account's nonce + 1, in batch
  order, and settlement spends them. An L1 transaction that takes a nonce
  first makes the transfer void; the subnet drops it.
- Fee: per transfer, public, at least the node's native transfer fee. The
  sender pays `amount + fee`. The fee is distributed as an L1 native fee
  (`generateFeeDistributionEdits`, network fee = `fee`).

### Public signals (1 + 5N + 6M = 154)

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
- the commitment opens with the sender account's limbs at `senderIndex`
  and the receiver's at `receiverIndex`, indices below M and pointing at
  active accounts; the signer is bound to the sender through the public
  hash (Interface v1.1);
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
   every receiver-side account named in `changes`;
2. each signature over its message; per-signer nonces consecutive from the
   working-state nonce + 1; each fee at least the native transfer fee;
3. public signals from the working state; PLONK verify, with their
   `settlementPublicHash` as the one public input, against the committed key
   `src/libs/l2ps/zk/keys/settlement/verification_key.json`;
4. apply each delta, add the transfer count to each signer's nonce, credit
   each fee's distribution edits without their sender debit (the delta
   already holds it).

The local `l2ps_proofs` path (`L2PSConsensus.applyPendingProofs`) and
`L2PSProofManager.createProof` stop when the fork is active, and members
refuse old-format transfers at admission.

## Interface v1.1

Replaces the public signal list of v1 as the circuit's public input; the
encoding above, the transaction and `settlementPublicSignals` are unchanged.
Node code: `settlementPublicHash` in `encoding.ts`; the circuit computes the
same value from its inputs and checks it against its one public input.

The circuit takes the v1 signals as private inputs except `signerHi` and
`signerLo`: it opens each commitment with the limbs of the account at
`senderIndex`. The verifier rebuilds the v1 signals as before, range-checks
them, and computes:

1. For each transfer slot i: if active, `senderIndex_i` = the slot of the
   active account whose `(hi, lo)` equals the signer's; no such account
   rejects the statement. If idle, the signer limbs must be 0 (else reject)
   and `senderIndex_i` = 0.
2. Packed elements, in order (2 + N + 4M = 83 for N = 9):
   - `commitmentsHash`;
   - per transfer i: `fee_i + nonce_i * 2^128 + senderIndex_i * 2^192 +
     transferActive_i * 2^200`;
   - per account j: `accountHi_j`, `accountLo_j`, `balanceBefore_j`,
     `deltaMagnitude_j`;
   - `sum_j (accountActive_j * 4^j + deltaNegative_j * 2 * 4^j)`.
3. Sponge: `h = 0`; for each chunk of 7 elements, the last padded with
   zeros: `h = Poseidon8(h, e_7k, .., e_7k+6)` (circomlib Poseidon,
   poseidon-lite). `publicHash` is the final `h`.

The packing is injective on range-checked values: fee < 2^128 and nonce <
2^64 are range-checked in the circuit, `senderIndex` < M <= 126 by its
selector, the flags are bits, and everything else is a whole element. Each
value of the statement therefore changes the hash; the tests change every
one of the 154 signals in turn and check that the proof fails or the
statement is refused.

Why packed Poseidon8 rather than one element per signal: absorbing the 154
signals one by one costs about 45,000 PLONK rows with Poseidon8 (294 per
element) or 54,000 with Poseidon16 (328 per element, 15 per chunk), which
would put N = 9 at 2^17 and double its proving time. Packed, the hash costs about 24,700 rows
for N = 9. One public input instead of 154 shrinks the proving key from
1.88 GB to 101 MB (PLONK keeps a Lagrange polynomial per public input) and
the prover's memory from 4 GB to 1 GB.

Example (pinned in `encoding.test.ts`): transfers A -> B (10, fee 1, nonce
3, salt 9) and C -> A (4, fee 2, nonce 7, salt 8), A = 0x11..11, B =
0x22..22, C = 0x33..33, balances before A 100, B 0, C 50, deltas -7, +10,
-6: `publicHash = 0x06e69393040f0b0be0b77a589cb51dc8d89beb42f28b4a26eec431cb8b544c27`.

## Launch stance

`l2psSettlement` is active from mainnet block 0. Old-format L2PS transfers
are refused from the start, so DEM-816 never exists on mainnet.

## Plan

| Step | Work | Estimate |
|------|------|----------|
| 1 | Circuit `L2PSSettlement(9, 18)`, witness builder, constraint and proving-time check against the budget | 2 days |
| 2 | SDK: transfer commitment, signature domain, encrypted payload carries the salt | 1 day |
| 3 | Aggregator: settlement record, real witness, no fallback, prover pool | 2 days |
| 4 | Validation and apply in block and Sync behind the fork, remove the local apply path | 2 days |
| 5 | Tests: forged proof, wrong settlement, overdraft, replayed commitment, member not in subnet, Sync from scratch; DEM-816 divergence repro with `EXPECT=fixed` on a 4-validator devnet | 2 days |
| 6 | Load: main-chain TPS, L2PS TPS, block times, time to GCR, proof time, on 3 hosts | 1 day |

About 10 working days in total, before review.
