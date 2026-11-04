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
- The seed is computed from the last three block hashes, and the secretary
  chooses part of what they cover. "Seed grinding" below measures how much
  choice that leaves and which parts are bounded; the seed rule itself is
  unchanged by this fork.

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

## Seed grinding

The seed for block h + 1 hashes `hash:number` of blocks h, h - 1, h - 2
and the genesis hash. Block h's hash covers its whole content, including
two values the secretary of round h picks: `content.timestamp` and the
merged `content.peerlist`. Each accepted value of either is another seed,
so another committee for h + 1 (and a share of the seeds for h + 2 and
h + 3). With n = 10, sixty consecutive integer timestamps for one block
give this many distinct committees (`seedGrinding.test.ts` pins them):

| Pool | Possible committees | Distinct over 60 timestamps |
| ---- | ------------------- | --------------------------- |
| 10   | 1                   | 1                           |
| 14   | 1001                | 57 to 59, by block content  |
| 20+  | 184756 and up       | 60                          |

So while the pool is no larger than n there is nothing to steer; from a
pool slightly above n every accepted timestamp is practically a fresh draw.

### Timestamp

Before: members checked only the floor (parent + `consensusTime`, which
`createBlock` clamps to), the greenlight handler took any larger value,
and sync accepts up to `BLOCK_TIMESTAMP_TOLERANCE` (60 s) ahead of the
verifier. Nothing required a whole number, so fractions made the choice
unbounded.

Now:

- Members sign only an integer timestamp at most
  `COSIGN_TIMESTAMP_MAX_LEAD_SECONDS` (5 s) ahead of their own network
  clock. The check runs when the greenlight or the `getBlockTimestamp`
  reply delivers the value, before `createBlock` signs, and in the
  proposeBlockHash handler before it merges or hands out a signature. An
  honest secretary stamps its own clock at round start, so only clock skew
  puts it ahead. This is signing policy, not a validity rule, so it needs
  no fork.
- Under `committeeBinding`, sync rejects a non-integer timestamp
  (`checkTimestampAgainstParent`).

What is left: any integer from the floor up to the members' clock + 5 s.
When a round starts on time that is about six values; it grows by one per
second the round starts late, and the secretary decides when it starts.
A parent stamped ahead of real time (up to the sync tolerance, on history
signed before this policy) can push the floor past every member's
clock + 5 s; members then refuse until their clocks catch up, a delay of
at most that lead.

### Peerlist

The committed peerlist is the pool the next committee is drawn from
(`getEligiblePool` / `getBoundPool`). Members used to accept any entry
that some member had observed at the parent block, so with k identities
observed below quorum the secretary could choose among 2^k pools.

Under `committeeBinding` a member accepts a dictated list only when every
entry reaches quorum in its own view of the contributions, and every
staked identity at quorum is present, so the list is fixed by the shard's
observations. The voters are the bound committee and the quorum is the
block's signature bar (2/3 + 1 of shardSize), both chain data: a quorum
counted from the members each node sees live would differ between the
secretary and its members and make them disagree on an honest list. Sync does not re-run this check
(contributions are not chain data), so it is gated for the rollout rather
than for history: it makes a member's view agree exactly with the
secretary's, and a member that missed a contribution another member gave
the secretary now refuses an honest list and sits the round out.

What is left: Byzantine members can send different observation tables to
different members. For an identity whose honest observation count is
within f of quorum, a secretary colluding with them can still decide which
honest members see it at quorum, at the price of splitting the honest
signers.

## Pinned identities

`PINNED_SHARD_IDENTITIES` are applied to the ranked pool, independent of
liveness, so they are part of the deterministic rule and always occupy
their committee seats, offline or not.

The secretary is the first live member of the shard, and pins sit at the
front. So whenever a pin is in the pool and online, it is the secretary of
every round. The secretary sets the round's pace (greenlights), the
timestamp and the dictated peerlist, within the bounds above. With pins,
those choices belong to one fixed key at every height: the grinding
surface is not spread over the validator set but held by whoever runs the
first pin. An offline first pin is also a missing vote at every height and
a dead secretary until members fail over.

The launch trust model is therefore: the operators of the pinned keys are
trusted not to grind the timestamp window or to stall rounds; sync does
not limit what they choose beyond the bounds above.

## Open decisions

- Seed rule. Keep a predictable seed from block content (a digest that
  leaves out timestamp and peerlist removes those channels but makes
  committees on empty blocks known in advance), or move to a VRF or
  commit-reveal beacon. Either changes the seed for every node, so it
  needs a fork.
- `BLOCK_TIMESTAMP_TOLERANCE`: lower it from 60 s to about 15 s, so sync
  no longer accepts timestamps honest members refuse to sign by a wide
  margin. Changing which blocks verify needs a coordinated height.
- Pins: an empty list for mainnet, a removal height after which the pins
  stop applying, or a rotating secretary instead of the first pin.
- Lower signing bound: refusing a timestamp far behind the member's clock
  would shrink the window when a round starts late, at the cost of
  rounds that genuinely run long (and secretary failover, which keeps the
  original timestamp).

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
