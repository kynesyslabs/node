# Launch-week overload plan

Decided 2026-11-27 (mainnet-launch#13). Part of the war-room plan (mainnet-launch#7).

## Lever: flat fee plus block and pool caps

No surge fee and no throttle fork for launch week. The caps that bound a spike
are already consensus rules from block 0, so there is nothing to switch on or
tune on a running chain:

| Bound | Value | Where |
|---|---|---|
| Transactions per block | 1,000 | `BLOCK_MAX_TXS`, `blockCaps` fork at height 0 |
| Transaction content per block | 4 MiB | `BLOCK_MAX_CONTENT_BYTES`, `blockCaps` |
| Pending transactions per sender | 64 | `MEMPOOL_MAX_PENDING_PER_SENDER`, held in the consensus mempool merge under `blockCaps` |
| Pool per node | 10,000 transactions or 8 MiB | `MEMPOOL_MAX_TXS`, `MEMPOOL_MAX_BYTES` |
| RPC request body | 4 MiB | `rpcMaxBodyBytes` |

A block takes what fits and leaves the rest pooled for later blocks, chosen the
same way on every validator. The fee is flat (`docs/mainnet/parameters.env`).
A transaction that executes and is refused still pays its fee, so spam is not
free (`docs/mainnet/exchange-integration.md`, "Fee on a failed transaction").
A transaction that waits too long expires instead of executing late.

Why not a surge fee: it changes what every validator charges, so it is a fork,
and it has not run on any network. Why not a throttle: the caps above already
bound each block, and a lower limit for the first days would need a second
fork to lift it.

## Launch week

- No first-come-first-served airdrop, mint or claim on day 1. Distributions
  that week use a snapshot or a fixed list, so nobody gains by flooding the
  pool.
- During a spike, operators change nothing: no fee, cap or pool edit on a
  running node. The war room posts that the network is congested and that
  pending transactions are kept or expire, never lost silently.
- Watch `MempoolBacklog` and block times on the monitoring dashboards. A
  growing backlog with blocks still coming is load; no blocks for 5 minutes is
  a halt (`docs/runbooks/chain-halt-recovery.md`).
