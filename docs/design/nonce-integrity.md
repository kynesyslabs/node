# Nonce integrity: one nonce per sender step, spent and paid for even on failure

Status: implemented behind the `nonceIntegrity` fork (dormant until a height
is set; the devnet genesis sets 0, a mainnet genesis must too).

## Problem

Two gaps let a sender's account nonce stop describing the transactions that
reached a block.

1. A failed transaction gave its nonce back. Apply restores the snapshot of
   every entity a failed transaction touched, the nonce included, and apply
   never compared a transaction's nonce with the account's. So with the
   account at n, a block carrying n+1 (fails) and n+2 (applies) leaves the
   account at n+1 while n+2 is on chain. Nonce n+1 is free again: the sender
   can sign another transaction for it, and the failed one can be replayed
   once its hash check is passed by a different body.
2. The nonce edit was not bound at gossip. Before `editBinding`, a type other
   than native, identity and Work is checked at gossip ingest and consensus
   merge only for value edits nobody derived (`verifyNoUnexplainedValueEdits`),
   which ignores nonce edits. Apply adds whatever amount a nonce edit names
   to whatever account it names, and a shipped `isRollback: true` turns the
   add into a decrement. A peer could bump or wind back any account's nonce.

## Rules under the fork

Activation at height H binds the block applied on tip H, which is block
H + 1, like `editBinding`.

### Shape of the nonce edit (admission and apply)

`verifyNonceEditBinding` holds for every transaction type, on either side of
`editBinding`:

- A transaction that spends a nonce ships exactly one nonce edit:
  `{type: "nonce", operation: "add", account: <sender>, amount: 1,
  isRollback: false, txhash}` and no other keys. The sender is
  `from_ed25519_address`, else `from`, `0x`-prefixed, the account the SDK
  names.
- `content.nonce` is a safe integer of at least 1.
- Transactions that spend no nonce ship no nonce edit: `l2psBatch`,
  `genesis`, an `instantMessaging` with no edits (the node's own), and the
  incentive award (it always carries nonce 1 and only identity edits).

It runs at gossip ingest and consensus merge (`verifyAdmissionEdits`), at
RPC intake (`verifyRpcEdits`), and again as a pre-pass of block apply. A
transaction refused there is reported failed, changes nothing and spends no
nonce: the account it would charge is not proven.

### Apply

For a transaction that ships a nonce edit, in block order on the state the
earlier transactions of the block left:

- The nonce must be exactly `account.nonce + 1`. Otherwise the transaction
  is failed with no state change and no charge.
- If the transaction then fails, every account its edits name is put back
  as it was before the transaction, and the failure is charged on that state
  (see "Failure charge"). The nonce is always spent.
- A Work transaction that rolled back has already been charged its fee and
  nonce by its own settlement, and counts as applied; it is not charged
  again.
- `applyTransactions` reports the charged failures in `nonceChargedTxs`, in
  block order. The forger's nonce trace counts them like applied ones.

Every node reaches the same result: the forger and committee apply the same
merged set, and a syncing node runs every transaction of the block that did
not fail before apply through the same `applyTransactions`. The charge reads
only the transaction, the fork schedule and the state the block left, so a
forger, a validator and a syncing node charge alike.

Not charged at all: transactions refused before apply (shape, `editBinding`,
uniqueness, contended Work), a nonce that is not the next one, and a
transaction the apply-side forged-edit guard refuses (its edits are not the
ones its signed body implies, so the fee it would pay is unproven). A
refusal of this kind leaves the nonce free; the sender's later nonces of the
block are then refused as not next, also uncharged.

### Failure charge

Decision: a transaction that fails inside a block pays its fee, like a
successful one. A free failure is an unlimited retry, and spam built to
fail would otherwise cost nothing but a nonce.

What is charged, all or nothing, in this order:

1. The fee edits the node derives at apply from the signed
   `transaction_fee` (native transactions under `gasFeeSeparation`): the
   sender's debit and the burn, treasury and RPC credits.
2. The gas: the balance `remove` on the sender that every SDK builder puts
   right before the nonce edit, derived by the node rather than read from
   the shipped edits, so a sender cannot leave it out while `editBinding` is
   dormant. Identity and `d402_payment` transactions pay none.
3. The nonce edit.

Never charged: anything the type itself debits (a storage program's burn, a
stake, a transfer). Those are effects, and the failure discarded them.

If the account cannot pay the fee on the restored state, only the nonce is
spent. The sender still moves on, and every node judges the same balance.

Work:

- Rolled back after executing: charged once by its settlement
  (`settledEdits(..., "rolled-back")`), reported as applied.
- Refused inside the block (an expired deadline, a malformed envelope): it
  is charged like any failure, fee and nonce. This differs from the Work
  settlement table's `expired` row, which describes a Work that never
  reached a block: once included, the Work occupied the block.
- A replay that fails: nonce only. A replay recovers the receipt of a Work
  that already paid, and its settlement never charges the fee.

The restore before charging also closes a double refund. Without the fork
a failed transaction's account snapshot is restored and then its applied
type edits are reversed on top of it, so a balance edit before the failing
one (a storage burn) is refunded twice and the sender gains it. Under the
fork the pre-transaction copy is put back after that reversal, so the
reversal cannot leave a trace. Pre-fork apply is unchanged.

### Account history (`gcr_assigned_txs`)

A charged failure is recorded in `gcr_assigned_txs` for its sender, like a
successful transaction: it changed the account (fee and nonce), and the
table is the list of transactions that did. The table is not part of the
native table hash, so the record changes no consensus value.

Explorers: the rows do not say whether a transaction succeeded; the
transaction's status in its block does (`TX_EXECUTE_FAILED` for a failure).
An explorer counts the transactions that spent an account's nonces as its
rows whose transaction ships a nonce edit, failures included (rows also list
transactions that spend no nonce, such as the incentive award). Status alone
does not separate a charged failure from a failure refused before apply;
only the charged one has a row.

The orphan recovery in sync (`rollbackOrphanedGcrState`) undoes stamped
transactions by replaying every edit of their bodies in reverse. That is
wrong for a charged failure, whose type edits never applied, so for a block
applied under the fork it refuses and the node must resync. Stamps commit in
the block's own database transaction, so only an older binary can leave an
orphan stamp.

### Mempool admission

Inside the per-sender advisory lock, keyed by the account the nonce edit acts
on:

- the nonce must be above the confirmed one (as before);
- at most `MEMPOOL_MAX_NONCE_AHEAD` (16) past it;
- no other pending transaction of the sender may hold the same nonce.

The confirm step (`validateTransaction`) refuses the same window, so a
client learns it before the execute round-trip.

Gaps inside the window are kept: an SDK batch sent through several RPCs
arrives out of order, and the forger already leaves a nonce ahead of the
account in the pool until the gap is filled. The window is under the
per-sender pending cap (64), so a sender's own future nonces cannot lock out
the transaction that fills the gap. A duplicate is refused rather than
replaced: there is no fee-bump replacement, and at most one of the two could
take effect, the other reaching a block only as a failure.

The consensus merge does not apply these rules: every committee member must
end it holding the same pool, and apply decides.

## Wallets and explorers

After the fork a transaction that fails inside a block usually moves the
sender's nonce and costs its fee, but not always: a failure refused before
apply spends neither, and a charged failure spends only the nonce when the
account cannot pay the fee. Failure status alone does not tell these apart.
A wallet therefore reads the sender's confirmed nonce and balance after a
failure and signs its next transaction from them, rather than inferring
either from the status.
