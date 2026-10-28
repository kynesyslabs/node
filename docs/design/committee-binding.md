# Committee binding

## Problem

A block at height h is signed by a committee drawn from the eligible pool
at h - 1 (the parent's committed peerlist intersected with the staked
validators). Before this fork the committee was the ranked pool filtered by
the forger's own view of who is online, and sync accepted a block with
q = floor(2n/3) + 1 verified signatures (n = shardSize) from any pool
member. With a pool larger than 2q, two network partitions can each fill a
committee from the members they see, each reach q, and finalize different
blocks at one height. Sync accepts both. No key signs twice, so the
per-key signing journal does not catch it.

## Rule (fork `committeeBinding`)

For block h the committee C is a function of the chain up to h - 1:

1. Pool: the eligible pool at h - 1; if it holds fewer than q identities,
   the whole staked validator set at h - 1, sorted (recovery fallback).
   If the chain defines no pool at all (no committed peerlist and no
   active validators), there is no committee and no block at h: the
   local peer view that development networks fall back to differs
   between nodes, so it is never used.
2. Seed: the common validator seed of block h - 1 (hashes and numbers of
   h - 1, h - 2, h - 3 and the genesis hash). It does not depend on time or
   on the retry round, so it is stable across retries at h, and a syncing
   node derives it from the stored parent.
3. C = the pool ranked under the seed, pinned identities present in the
   pool moved to the front in pin order, first n entries.

The producer talks to the live members of C. It forges only when at least
q of them are live, and tallies pro votes against |C|: an offline member is
a missing vote, never replaced. Sync and the proposeBlockHash handler count
only verified signatures by members of C, and need q (pinned to n, as
under `quorumParity`). The handler also requires the proposer to be in C.

The producer computes C once when the round starts, from the seed's own
block, and reuses it for the shard, the tally and a last check before
committing: the block must carry at least q verified signatures by members
of C, counted by the same function sync uses. A producer therefore never
finalizes a block that sync would reject. If C cannot be computed or the
check fails, the round aborts; it does not stop the node.

## Assumptions

- At most f = floor((n - 1) / 3) Byzantine members inside C. C is a sample
  of the pool, so this is a sampling assumption: with a pool larger than n
  the share of Byzantine validators in C can exceed their share in the pool.
- The seed is computed from the last three block hashes, which their
  producers choose. A producer can grind a block's content to steer the
  committees that follow. This is a known limit of the seed, not addressed
  by this fork.

## Why two blocks at one height overlap

Both blocks share the parent, hence the same C with |C| <= n. Each needs at
least q signers in C, so they share at least 2q - |C| >= 2q - n members.
2q - n > floor((n - 1) / 3) = f for every n (for n = 10: 4 > 3), so a fork
needs an honest validator to sign two blocks at one height, which the
signing journal refuses. The safety suite checks this for n in {4, 7, 10}
and pools up to 2n + 4, with a pinned identity in the pool, with the staked
fallback, and for all 3432 splits of a pool of 14 into 7 + 7.

## Liveness trade-off

C for height h depends only on blocks h - 1, h - 2, h - 3 and genesis. A
height that cannot commit produces no next block, so every retry at h draws
the same C; there is no new committee until h commits.

With pool > n, where the old liveness filter substituted other pool
members, more than n - q offline members of C now stall the height until
they come back or operators intervene. Recovery is manual: restart the
offline members of C (the stalled producer logs the committee and which
members are not live); as a last resort, a coordinated restart of the
network. With pool <= n, C is the whole pool and the behaviour is
unchanged. With a pool even slightly larger than n it changes: the old
liveness filter would have substituted the few members outside C for
offline members of C, and now nothing does.

The fallback in step 1 covers a peerlist that shrank below q, which used to
stop the chain for good. It does not help when the pool holds q or more
members but fewer than q are online; that case needs an operator decision,
since who is online is not chain data.

An in-protocol escape, drawing a different committee after a timeout, needs
a round index carried in the block so sync can recompute which C signed
it, and the locking rule being designed for the same-height fork so that
two rounds at one height cannot both commit. Both are out of scope here.

## Pinned identities

`PINNED_SHARD_IDENTITIES` are applied to the ranked pool, independent of
liveness, so they are part of the deterministic rule and always occupy
their committee seats, offline or not. Decision for mainnet: consider an
empty pin list, so no fixed key holds a permanent seat and an offline pin
does not count against the quorum at every height.

## Known limits

`GCR.getGCRValidatorsAtBlock` reads validators by their current status, not
their status at the given height. Re-verifying an older block after one of
its validators unstaked can therefore compute a different pool, hence a
different C, and reject the block. This fails closed: no extra block is
accepted, but a node re-verifying old blocks may refuse a valid one.

## Activation

Dormant by default (`activationHeight: null`). A chain started from
genesis with this build sets it in `genesis.forks.committeeBinding`; for
mainnet that is block 0. The devnet genesis activates it from 0, like
`quorumParity`. A running chain needs a coordinated future height.
