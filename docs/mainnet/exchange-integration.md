---
type: guide
title: Exchange and custodian integration
date: 2026-11-17
status: draft
---

# Exchange and custodian integration

How an exchange, custodian or payment service credits DEM deposits and sends
DEM withdrawals on Demos mainnet. It covers the native send only. It uses the
read calls in [finality-read-api.md](../runbooks/finality-read-api.md); read
that page for the exact request and reply shapes. Fees per transaction type
are in INSTALL.md, "Fees charged per native send"; the short crediting rule
for operators is INSTALL.md, "Crediting deposits" ([INSTALL.md](../../INSTALL.md)).

All calls are `{ "method": "nodeCall", "params": [{ "message": <name>, "data": {...} }] }`
over HTTP POST to a node's RPC port, or the same `nodeCall` over OmniProtocol.

## Network facts

| Item | Value |
|---|---|
| Chain id | `8587492` (check with `getChainIdentity`, see below) |
| Block time | about 10 seconds outside heavy load |
| Validators | every staked validator (about 30 expected at launch); each block has a committee of 10 drawn from them and needs 7 of those 10 signatures |
| Smallest unit | 1 DEM = 1,000,000,000 OS |
| Fee on a native send | 2 DEM (1 DEM network fee + 1 DEM RPC fee) |
| Memo or destination tag | none |

Pin the network once at startup. Call `getChainIdentity {}` and compare
`chainId`, `genesisHash` and `genesisDataHash` with the values in the release
announcement. Refuse to run if they differ.

## Addresses

- An address is `0x` followed by 64 lower-case hex characters. It is the
  account's ed25519 public key in hex.
- There is no checksum. Upper-case or mixed-case addresses are refused by the
  node: a native send to one is rejected at submission, and nothing is lost.
- Normalise every address you store or display to lower case. Validate with
  `^0x[0-9a-f]{64}$` before you accept a withdrawal address from a user.
- The SDK `pay()` call does not lower-case the recipient for you. Do it
  yourself before you build the transaction.

## No memo or destination tag

A native send carries a sender, a recipient, an amount, a nonce and a fee.
There is no memo, tag or payment reference field. Give each customer their
own deposit address. Do not run one shared deposit address with tags: you
cannot tell the senders apart.

## Amounts

- Balances and amounts are whole numbers of OS, the smallest unit. There are
  no fractions below 1 OS.
- On the wire, an amount in a transaction row can be a JSON number or a
  decimal string of OS, for example `2500000000` or `"2500000000"` for
  2.5 DEM. Accept both and parse them as big integers. Never use floating
  point. The amount in the signed transaction bytes from
  `getTransactionProof` is the one to credit (see below).
- `getAddressInfo {address}` returns the balance as a decimal OS string.

## Transaction states

`getTransactionStatus {hash}` takes the 64-hex transaction hash without `0x`.
The HTTP status of an RPC reply is 200 in every case below: read the outcome
from the JSON reply's `result` field (200, 400, 404, 500 or 503) and the
reason from `extra.reason`. The reply carries no amounts. It returns one of
five states:

| `state` | Meaning | What to do |
|---|---|---|
| `pending` | In the node's mempool, not in a block yet | Wait. |
| `included` | In a block and executed. `blockNumber` is set. | Credit after the finality rule below. |
| `failed` | In a block but not executed, or executed and refused. `code` and `message` say why. | Do not credit. See "Fee on a failed transaction". |
| `dropped` | This node no longer holds it in its mempool, and no block has taken it. `reason` says why. Not a terminal state. | Do not credit. Wait as for `unknown`: another node may still include it. Never re-sign it with a new nonce. |
| `unknown` | The node does not know the hash. `result` 404 (`extra.reason` `not_found`) when the node is synced, 503 (`node_not_synced`) when it is not. | Ask a synced node. If a synced node answers 404 after the expiry window below, the transaction is gone. |

`dropped` is per node and kept in memory for the 50,000 most recent drops,
so a node that restarted or never held the transaction answers `unknown`
instead. It is not a terminal state, whatever the `reason`
(`reference_block_expired`, `expired`, `evicted_fee`, `evicted_sender_cap`,
`seat_refused`, `refused_for_block`): do not treat it as "cannot execute".
Another node may still hold and include the transaction, and it can come
back to this node's pool. Keep checking; only a block is final. A block
always wins: if one later carries the transaction, the node answers
`included` or `failed`.

A malformed or `0x`-prefixed hash gets `result` 400. A lookup error gets
`result` 500; retry on another node.

## Detecting a deposit

Use one of these. Both are safe if you check each candidate by hash.

1. Per address: `getTransactionHistory {address, type, start, limit}`.
   `limit` is at most 100. Rows come newest first and include failed
   transactions, so always check each hash with `getTransactionStatus`.
2. Per block: walk `getBlockByNumber {blockNumber}` up to the finalized head
   (see below), take the transaction hashes, and fetch them in batches with
   `getTxsByHashes {hashes}`. Send at most 1,000 hashes per call: the node
   reads only the first 1,000 and drops the rest without an error. A row
   marked `pending: true` came from the mempool, not from a block; skip it.
   Block 0 is the genesis: `getBlockByNumber {blockNumber: 0}` returns only
   `number` and `hash`, and it holds no transactions to scan.

For each native send to one of your addresses:

1. `getTransactionStatus {hash}` must say `included`.
2. The finality rule below must hold for its `blockNumber`.
3. Read the recipient and amount from the proof, not from a history row:
   `getTransactionProof {hash}` returns the signed transaction bytes
   (`tx.contentBytes`). Take `to`, `amount`, `from` and `nonce` from there.
   The reference verifier `verifyTransactionProof` in
   `src/libs/blockchain/finality/verify.ts` does this offline and returns
   `final-executed`, `final-failed`, `invalid` or `indeterminate`. Credit only
   on `final-executed`.
4. Credit the amount once per transaction hash. Keep the hash as the unique
   key in your ledger.

## Finality rule

A block is final when it carries signatures from at least 7 of the 10
members of its committee (the committee is drawn per block from all staked
validators). `getFinalizedHead {}` returns the newest final block (`number`,
`hash`, `ageSeconds`, `signatureCount`, the signatures and the committee).
The proof for a transaction's result is committed in the next block.

Rule for the first weeks after launch: credit a deposit when the finalized
head is at least 3 blocks past the transaction's block (about 30 seconds).

```
credit if status.state == "included"
      and finalizedHead.number >= status.blockNumber + 3
      and verifyTransactionProof(...) == "final-executed"
```

Ask more than one node, run by different operators, before a large credit.

## Fee on a failed transaction

There are two kinds of `failed`:

- Executed and refused (for example, not enough balance for the amount).
  The sender pays the fee and the nonce is used. The amount does not move.
  If the sender cannot pay the fee either, only the nonce is used.
- Never executed (for example `TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE` or
  `TX_NONCE_INVALID_LOW`). It is recorded as failed and pays nothing. An
  expired transaction does not use its nonce.

### Expiry

Each transaction names a reference block. Counting back from the chain head
when the next block is built (the parent of the block that would include
it):

| Reference block is | Outcome |
|---|---|
| up to 10 blocks behind | can execute |
| 11 to 50 blocks behind | included as `failed` (`TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE`), no fee, nonce not used |
| more than 50 blocks behind | not included at all; a node that held it answers `dropped` (`reference_block_expired`, not terminal) for a while, others `unknown` |

Separately, a node drops a pending transaction 10 minutes after its signed
timestamp (`dropped`, `expired`: a peer that has not dropped it yet can still
include it), and refuses one whose timestamp is more than 5 minutes in its
future. Sign withdrawals with a fresh reference block and the current time.

Either way, never credit a failed transaction.

## Sending withdrawals

- Fund the hot wallet with the amount plus 2 DEM per send.
- `getAddressNonce {address}` returns the last nonce the account used. The
  next transaction takes that value plus 1. Keep your own nonce counter per
  hot wallet, start it from that value plus 1, and send one transaction per
  nonce.
- Keep at most 64 pending transactions per sender. The node refuses more, and
  refuses a nonce more than 16 ahead of the account.
- Store the transaction hash before you broadcast. Track it with
  `getTransactionStatus`.

### Never re-sign after a timeout

A timeout or a lost reply does not mean the send failed. If you sign a new
transaction with a new nonce, both can execute and you pay twice.

After a timeout:

1. Query the stored hash with `getTransactionStatus` on two or more nodes.
2. If it is `pending` or `included`, wait. Do nothing else. If it is
   `dropped`, whatever the `reason`, wait as well and keep checking: never
   sign a new transaction with a new nonce for it, since another node may
   still include it. Only a block is final.
3. Treat it as dead only when all of these hold:
   - a synced node returns `unknown` or `dropped` for the hash;
   - the chain head is more than 50 blocks past the transaction's reference
     block (see "Expiry");
   - more than 10 minutes have passed since its signed timestamp;
   - `getAddressNonce` for the hot wallet is still below its nonce (equal
     means that nonce is used).
4. If you must send again, sign with the same nonce
   (`pay(to, amount, { nonce })` in the SDK). The node holds only one
   pending transaction per nonce, so at most one of the two can execute.

## Halt notice

The chain can stop producing blocks, for example while validators recover.
Funds are not at risk during a halt, but new transactions do not finish.

- Watch `getFinalizedHead {}`. `ageSeconds` is about 10 in normal operation.
- If `ageSeconds` goes above 60, pause withdrawals and deposit credits. Do
  not re-sign pending withdrawals.
- Resume when `ageSeconds` is back near 10 and new blocks keep arriving.
- Halts and restarts are announced on the network status channels:
  TBD (owner). Check `getChainIdentity` again after any announced restart.

## Rate limits

Nodes limit requests per IP address (IPv6 by /64). The node defaults are
below; a public node's operator can change them.

| Requests | Default limit |
|---|---|
| `nodeCall` and every other HTTP POST | 200,000 per 24 hours |
| `GET /info`, `/version`, `/genesis` and the other fixed status routes | 2,000 per minute |
| other GET routes | 600 per minute |

Past a limit the address is refused for 60 seconds. Run your own node for
heavy scanning. Batch hash lookups with `getTxsByHashes` instead of one call
per hash.
