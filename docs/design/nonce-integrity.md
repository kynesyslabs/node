# Nonce integrity: one nonce per sender step, spent even on failure

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
- If the transaction then fails, its other edits are rolled back as before,
  and the nonce edit is applied on the restored state: the nonce is spent.
  A Work transaction that rolled back has already been charged its fee and
  nonce by its own settlement and is not charged twice.
- `applyTransactions` reports the charged failures in `nonceChargedTxs`, in
  block order. The forger's nonce trace counts them like applied ones.

Every node reaches the same result: the forger and committee apply the same
merged set, and a syncing node runs every transaction of the block that did
not fail before apply through the same `applyTransactions`.

Not charged: transactions refused before apply (shape, `editBinding`,
uniqueness, contended Work), and a nonce that is not the next one.

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

## Open decisions

- Fee on failure. A failed non-Work transaction spends its nonce but pays no
  fee; Work keeps its existing fee-and-nonce charge. Charging the fee too
  would make spam that is built to fail cost something, but changes what a
  failed transfer costs users. Not done here.
- `gcr_assigned_txs` lists the transactions that changed an account. A
  charged failure is not recorded there, although it moved the nonce. Block
  apply is atomic, so state is unaffected; explorers that derive the nonce
  history from that table need to count failed transactions of the block.
- Explorers and wallets: after the fork a failed transaction moves the
  sender's nonce. A wallet signs its next transaction with the next nonce
  either way.
