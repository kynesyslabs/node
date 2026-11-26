# Peerlist floor and pool refresh (`peerlistFloor`)

Status: implemented behind the `peerlistFloor` fork, at height 0 in the
mainnet genesis set.

## Threat

Every block commits `content.peerlist`, the merge of its committee's
observations of who is online at the parent block. The next committee is
drawn from that list intersected with the staked set
(`getShard.ts`, `chainEligiblePool` / `getBoundPool`). Before this fork an
identity enters the list only when at least `q` members report it
(`q` = 2/3 + 1 of `shardSize`, 7 of 10), and a member refuses a dictated
list that names anyone below `q` in its own view.

So `n - q + 1` members (4 of 10) that leave an honest validator out of their
reports drop it: the 6 honest reports are below 7, every honest member
computes the same result, and the block is valid. Repeated, the pool loses
every honest validator the coalition omits. Once the pool is coalition-only
and holds at least `q` identities, every later committee is drawn from it
and the capture is permanent; the staked-set fallback only applies below
`q`. Sync cannot catch it: contributions are not chain data, so a block with
a quorum of signatures carries whatever peerlist they signed
(`docs/mainnet/validator-concentration.md`, "What sync cannot re-check").

With seats limited only by NFT count, a party holding a third of the set
has 4 or more seats in about 44% of committees (binomial, 10 seats), so
the purge would start within a few blocks of launch.

## Rule

From the block at the fork height on:

1. **Floor.** An identity observed at the parent block enters the merged
   peerlist when at least `m - q + 1` voters report it, and at least 1:
   4 of a full committee of 10. `m` is the round's real committee size and
   `q` the block's signature bar the round already uses (the quorum of
   `shardSize` under `committeeBinding`, else of the round's voters). A
   committee short of `shardSize` (a pool of 9, say) still needs `q`
   signatures, so `m - q` colluders cannot sign alone and leave `m - q + 1`
   honest members; a floor fixed at 4 would let 6 of 9 drop an honest
   validator that only the other 3 report. Under `committeeBinding` a
   member accepts a dictated list only when every entry has at least that
   many reports in its view and
   every staked identity with that many is present, the same symmetric check
   as before at the new bar. Dropping an honest validator observed by the
   honest members then needs `q` colluding members, which can sign any block
   alone anyway.

2. **Pool refresh.** For a block `h` with `h % POOL_REFRESH_INTERVAL == 0`
   the committee is drawn from the parent's committed peerlist united with
   the committed peerlists of blocks `h - j * POOL_REFRESH_INTERVAL` for
   `j = 1 .. POOL_REFRESH_DEPTH` (those at height 1 or more), then filtered
   by the staked set as usual. While that window reaches back past block 1
   (the first `POOL_REFRESH_DEPTH` refreshes) the genesis validator set
   takes the place of the missing samples: genesis commits no peerlist, and
   a coalition that captured the lists before block 720 would otherwise find
   only its own lists at every later refresh. The genesis set is the one
   recorded after block 0, so it needs `finalityProofs` from block 1 (mainnet
   and devnet); on a chain without that record the sample is left out rather
   than read from the live table, which changes once a genesis validator
   leaves. It reads only hashed block content and the
   validator set, so every node, sync included, draws the same committee,
   and verifyBlock already checks signatures against that committee. A
   committee that gathered `q` colluders and committed coalition-only lists
   holds the chain only until the next refresh height, when validators the
   earlier refresh committees saw come back into the pool.

Parameters (`src/libs/consensus/v2/routines/poolRules.ts`):

| Name | Value | Why |
|---|---|---|
| floor | `m - q + 1`, at least 1 = 4 of 10 | the smallest count that always holds an honest report when at most `m - q` members collude |
| `POOL_REFRESH_INTERVAL` | 720 blocks (about 84 min at 7 s) | the longest a captured committee keeps the chain; each refresh is one draw from a wider pool (see the trade-off below) |
| `POOL_REFRESH_DEPTH` | 3 (2160 blocks, about 4.2 h) | a refresh restores the honest set unless all 3 sampled refresh blocks were signed by captured committees: about `p^3` for a per-committee capture chance `p`, 8e-6 for a third of the set, 2e-4 for 40%. A depth of 6 would give 6e-11 and 3e-8, but it reaches back 8.4 h and brings back twice as many validators that have since gone offline (see the liveness trade-off) |

The refresh never removes anyone the parent's list holds. With no
committed peerlist at the parent (genesis, bootstrap) the existing staked
fallback applies unchanged.

## Why not the full staked set

A refresh to every staked identity also restores the honest set, but the
staked set keeps validators that stopped running: nothing ejects them.
Under `committeeBinding` a committee with more than `n - q` offline members
stalls its height until they return (`docs/design/committee-binding.md`,
"Liveness trade-off"). With 10% of the staked set abandoned, 1.3% of
refreshes would stall; at 20%, 12%. The sampled lists hold only validators
some committee saw online within the last 4.2 hours.

## Liveness trade-off

- The floor keeps an identity while 4 members report it. Honest members
  report a peer only while its last sync state sits at their tip, so an
  offline validator leaves the list once its state falls behind, as
  before. A coalition of 4 or more seats
  can keep identities the honest members do not see, for instance its own
  offline keys; an offline member of a bound committee counts as a missing
  vote, which that coalition can already cause by withholding its own.
- A refresh may bring back validators that went offline within the
  sampled window. The refresh committee stalls only if 4 or more of its
  10 members are among them: zero with fewer than 4 such validators, about
  0.2% per refresh with 4 of 40 and 1% with 5 of 40. Recovery is the
  existing one for a stalled bound committee: bring its offline members
  back (the stalled producer logs them).
- Byzantine members can still send different observation tables to
  different members, now around the floor instead of the quorum: that
  splits honest signers, as before, and is not a way to drop an identity.

## What sync and clients check

- Sync re-derives the committee of every block from chain data, including
  the refresh, so a block signed by any other committee fails
  verifyBlock. It cannot re-check the floor itself, since contributions
  are not chain data: a committed list remains what a quorum signed. The
  floor binds honest members; the refresh bounds what a quorum of
  colluders can do with that.
- A sampled block missing from the local chain is an error, never an
  empty list, so a node without history cannot draw a different committee.
- The offline finality verifier (`src/libs/blockchain/finality/verify.ts`)
  holds only the anchor's parent. At a refresh height it cannot rebuild the
  pool, so it needs the committee (`rules.committee`), or a staked set no
  larger than the shard, which is then used whole.

## Activation

`peerlistFloor` is a `BaseForkConfig` fork, dormant by default
(`activationHeight: null`), so a running chain keeps its rules until a
coordinated release schedules it. The mainnet genesis template, the devnet
genesis, `MAINNET_FORKS` in `scripts/launch-go-no-go.ts` and the
genesis-acceptance fixtures set it at 0.
