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

## Why two blocks at one height overlap

Both blocks share the parent, hence the same C with |C| <= n. Each needs at
least q signers in C, so they share at least 2q - |C| >= 2q - n members.
2q - n > floor((n - 1) / 3) = f for every n (for n = 10: 4 > 3), so a fork
needs an honest validator to sign two blocks at one height, which the
signing journal refuses. The safety suite checks this for n in {4, 7, 10}
and pools up to 2n + 4, and all 3432 splits of a pool of 14 into 7 + 7.

## Liveness trade-off

With pool > n, more than n - q offline members of C stall the height,
where the old liveness filter substituted other pool members. The next
height draws a new C (new seed), but the pool only changes when a block
commits a new peerlist. With pool close to n, C is the whole pool and the
behaviour is unchanged. The fallback in step 1 covers a peerlist that
shrank below q, which used to stop the chain for good. It does not help
when the pool holds q or more members but fewer than q are online; that
case needs an operator decision, since who is online is not chain data.

## Pinned identities

`PINNED_SHARD_IDENTITIES` are applied to the ranked pool, independent of
liveness, so they are part of the deterministic rule and always occupy
their committee seats, offline or not. Decision for mainnet: consider an
empty pin list, so no fixed key holds a permanent seat and an offline pin
does not count against the quorum at every height.

## Activation

Dormant by default (`activationHeight: null`). A chain started from
genesis with this build sets it in `genesis.forks.committeeBinding`; for
mainnet that is block 0. The devnet genesis activates it from 0, like
`quorumParity`. A running chain needs a coordinated future height.
