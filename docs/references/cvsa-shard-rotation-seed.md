---
type: reference
title: CVSA, the seed behind PoR-BFT shard selection
date: 2026-11-05
status: draft
tags: [consensus, porbft, shard, seed, cvsa]
author: agent
---

# CVSA, the seed behind PoR-BFT shard selection

This document describes what the node code at commit
`f8913fc7e` (branch `stabilisation`) does
when it derives the seed used to pick the validator shard for a block. It
answers parts (a) and (b) of issue #802 (the definition and whether it is
implemented); part (c), the published Yellow Paper specification, is not
answered here. It describes code; it is not the formal specification
from the Yellow Paper, and it does not replace one.

Where the repository does not answer a question, the text says "not
determined from the code".

## Summary

- The expansion of the acronym is in the repository, in one code comment:
  `CVSA (Common Validator Seed Algorithm)`
  (`src/libs/consensus/v2/routines/getCommonValidatorSeed.ts:2`).
- The code uses "CVSA" for two things: the algorithm (that comment) and the
  seed value it produces (`shard.CVSA`, `consensusInfo.cvsa`, and the
  `cvsa` argument in `bridges.ts`). Function and variable names say
  "common validator seed".
- The seed is the SHA-256 hash of a string built from the hashes and
  numbers of the last three blocks plus the genesis block hash. It is
  deterministic chain data, not a random value.
- The pseudorandom step is separate: the seed initialises an `Alea` PRNG,
  which orders the eligible validator pool; the first `shardSize` entries
  become the shard (three pinned identities are put at the front; where in
  the sequence depends on the fork, see section 3).
- The derivation and the draw are implemented and used on the consensus
  path. The one place that names the CVSA as a shard source for bridges is a
  stub that returns an empty list.

## Where the term appears at this commit

| Place | What it says |
| ----- | ------------ |
| `src/libs/consensus/v2/routines/getCommonValidatorSeed.ts:1-12` | Header comment: expansion, 5-step algorithm. |
| `src/libs/consensus/v2/types/shardTypes.ts:5` | `CVSA: string // The common validator seed used to generate the members` |
| `src/libs/consensus/v2/types/secretaryManager.ts:219-223` | `initializeShard(cVSA, lastBlockNumber)`; stores it as `this.shard.CVSA` (line 225). |
| `src/libs/network/manageConsensusRoutines.ts:375-401` | `setValidatorPhase`, when the call's `blockRef` is the one the round's shard was built for, compares the caller's seed with `manager.shard.CVSA` and answers "Invalid seed detected" on mismatch. |
| `src/utilities/sharedState.ts:568-571` | Exposes `cvsa` and `cvsaBlockRef` in the consensus info map. |
| `src/features/bridges/bridges.ts:8,105-110` | `seed: string // Seed (CVSA) of the controllers`; `getShardFromCVSA` is a TODO that returns `[]`. |

Not found in the repository:

- A file named `PoRBFT.md`. `documentation/new-consensus.md` mentions
  `PoRBFT.ts` (line 18) and does not mention the seed or CVSA.
- The phrase "pseudorandom seed from the CVSA". A search for
  "pseudorandom" and "pseudo-random" finds no match.
- The Yellow Paper table of contents. `README.md:11-13` links to a separate
  repository (`kynesyslabs/demos_yellowpaper`). That repository was not
  read for this document, so whether it contains a CVSA specification, and
  whether that specification is published, is not determined from the code.

## What the code does

### 1. Deriving the seed

`getCommonValidatorSeed(lastBlock = null, logger)` in
`src/libs/consensus/v2/routines/getCommonValidatorSeed.ts`:

1. Takes `lastBlock` if the caller passed one. Otherwise reads
   `Chain.getLastBlock()`, up to 3 attempts, 100 ms apart (lines 92-98). If
   it is still null, it throws (lines 100-104).
2. Collects up to 3 blocks: the last block, then the blocks numbered
   `lastBlockNumber - 1` and `lastBlockNumber - 2` (`blockCount = 3`, lines
   90 and 115-126). The loop stops at the first block it cannot find; the
   code comment says this should only happen when `lastBlockNumber < 3`.
3. Gets the genesis hash: the last block's own hash if its number is 0,
   otherwise `Chain.getGenesisBlockHash()`; it throws "Genesis block not
   found" if that returns nothing (lines 137-149). The value is kept in a
   module variable for the life of the process.
4. Builds the string
   `hash:number|hash:number|hash:number|genesis:<genesisHash>`, newest block
   first (lines 152-154).
5. Returns `Hashing.sha256(string)` (line 167) as `commonValidatorSeed`,
   with `lastBlockNumber`. `Hashing.sha256` is Node `crypto` SHA-256 over
   the string, hex-encoded (`src/libs/crypto/hashing.ts:15-17`).

Caching: when no `lastBlock` is passed and
`getSharedState.lastBlockHash` equals the hash of the block used last time,
the previous result is returned without recomputing (lines 82-88 and
177-181). A call with an explicit `lastBlock` never reads or writes the
cache (line 80).

Properties that follow from the code (not from the header comment):

- Two nodes that hold the same last three blocks and genesis compute the
  same seed. The seed depends on nothing else: no time, no round number
  (`src/libs/consensus/v2/routines/getShard.ts:338-341` says the same).

### 2. Where the seed is computed and used

| Use | Source |
| --- | ------ |
| Start of a consensus round: seed from the current tip, passed to the secretary manager | `PoRBFT.ts:847-860` |
| Shard stored on the round as `shard.CVSA` | `secretaryManager.ts:223-230` |
| Candidate block field `proposer` is set to the seed ("This is the shard identifier") | `createBlock.ts:90` |
| Candidate block field `next_proposer` is the seed computed from the candidate block itself | `createBlock.ts:149-153`; the prevote path of the commit-lock fork does the same at `createBlock.ts:252-255` |
| Genesis block `next_proposer` is the seed computed from the genesis block | `chainGenesis.ts:23-26` |
| Committee for block `n+1` recomputed from stored block `n` (sync, stall detection) | `getShard.ts:346-359`, `stallDetection.ts:95,117` |
| Peers reject `setValidatorPhase` calls carrying a different seed | `manageConsensusRoutines.ts:375-401` |
| RPC method `getCommonValidatorSeed`, omniprotocol opcode 0x34 | `manageConsensusRoutines.ts:353-357`, `omniprotocol/protocol/opcodes.ts:37`, `omniprotocol/protocol/handlers/consensus.ts:200-212`, `omniprotocol/protocol/registry.ts:256-261` |

### 3. From seed to shard

The pseudorandom step is in `src/libs/consensus/v2/routines/getShard.ts`.

1. Pool. The eligible pool after parent block `n` (the pool the block
   `n+1` committee is drawn from) is the peerlist committed in block `n`
   intersected with the staked validator set (`chainEligiblePool`,
   `getShard.ts:165-201`; `eligiblePoolFrom`, `poolRules.ts:37-56`). If the
   committed peerlist is empty, or at genesis, it is the whole staked set.
   If a peerlist is committed but there are no staked validators, the
   peerlist is used unfiltered. If the block commits no peerlist and there
   are no staked validators either, a local-view fallback is used.
   `DEMOS_REQUIRE_VALIDATORS=true` refuses both the fallback and the
   unfiltered-peerlist case (`getShard.ts:107-158, 179-186`). With
   `committeeBinding` the fallback never applies: no committee is drawn
   instead (`getBoundPool`, `getShard.ts:286-296`). The pool is
   deduplicated and sorted with `compareIdentities`, so every synced node
   sees the same list.

   Which staked set is used depends on the `finalityProofs` fork
   (`poolValidatorAddresses`, `getShard.ts:83-101`). Without the fork it is
   the active validator set at block `n` (`readActiveValidatorAddresses`,
   lines 58-69). When `finalityProofs` is active for block `n+1`, it is the
   validator-set snapshot after block `n-1` (height `max(n-1, 0)`). A
   validator that stakes in block `n` is therefore absent from the pool for
   block `n+1`: joins and exits reach the pool one block later than before
   the fork. A node that holds no snapshot that old throws instead of
   drawing a pool. `finalityProofs` is dormant by default
   (`activationHeight: null`, `src/forks/forkConfig.ts:714`). The
   `committeeBinding` and `stakeApplyChecks` forks do not change how the
   pool is formed from the staked set: `committeeBinding` reads the same
   set through the same function, and `stakeApplyChecks` (also dormant by
   default, `forkConfig.ts:732`) changes which stakes and unstakes are
   applied, that is, what the validator rows contain.
2. Ranking. `rankPool(seed, pool)` creates `Alea(seed)` (the `alea` npm
   package, `package.json:139`) and repeatedly removes the element at index
   `floor(random() * remaining)` until the pool is empty (`getShard.ts:251-261`).
   Equal seed and equal pool give the same order.
3. Pins. `PINNED_SHARD_IDENTITIES` holds three fixed validator identities
   (`src/utilities/constants.ts:78-87`). They are moved to the front of the
   order when they are in the pool (`pinRankedPool`, `getShard.ts:317-326`). The
   constant's comment says the first online pin acts as secretary. That is
   the order with `committeeBinding`. Before the fork, the pins are applied
   to the shard after it has been cut to `shardSize` from the online peers
   (`pinShardIdentities`, `getShard.ts:203-244, 431-438`); a pin is added
   only if it is an online candidate.
4. Size. The shard is the first `shardSize` entries. `shardSize` is read
   from the stored genesis block (`properties.shardSize`, an integer from 3
   to 100: `src/libs/consensus/genesisShardSize.ts:19-21, 63-84`) and pinned on the shared state
   (`sharedState.ts:121-140`). The repository's genesis files set 10
   (`docs/mainnet/genesis.template.json:6`, `data/genesis.json:6`); the
   value a running network uses is not determined from the code.

Two selection rules exist, chosen by the `committeeBinding` fork
(`getShard.ts:386`):

- Before the fork: the ranked pool is filtered to peers the local node sees
  as live, then cut to `shardSize` (`drawLiveShard`, `getShard.ts:268-275`,
  called at lines 431-436). A peer counts as live when it is this node, or
  when it is in the `PeerManager` online list, is not on a differing fork
  schedule (`forkScheduleDifferingPeers`), and its known height (the larger
  of its synced block and its gossiped height) is at least the tip minus
  one, so a peer more than one block behind the tip is dropped
  (lines 393-424).
- With `committeeBinding`: the committee is the first `shardSize` entries
  of the pinned ranking of the pool, computed from chain data only
  (`getBoundCommittee`, `getShard.ts:346-359`; `drawBoundCommittee`, lines
  329-335). Offline members stay in the committee and count as missing
  votes: the same liveness test is applied, but only to decide which
  committee members are reachable (`liveBoundMembers`, lines 464-489). If
  the pool holds fewer identities than the quorum and the staked set is
  larger than the pool, the whole staked set is used instead
  (`getBoundPool`, lines 286-310; `boundPoolFrom`, `poolRules.ts:64-71`).
  When the pool is below the quorum but the staked set is not larger, the
  pool is kept. The staked set here comes from the same
  `poolValidatorAddresses` as in step 1.

The fork is dormant by default (`activationHeight: null`,
`src/forks/forkConfig.ts:696`; description at lines 692-700); a chain
launched from genesis with this build is meant to set it
to 0 in its genesis file (`forkConfig.ts:693-695`); nothing sets it
automatically. The mainnet genesis template schedules it at height 0
(`docs/mainnet/genesis.template.json:31-33`), and `data/genesis.json` has
no `committeeBinding` entry, so there the fork stays dormant. Which rule a
running network uses is not determined from the code.

### 4. How often the shard changes

Every new block changes the seed, because the newest block hash is part of
it. A shard is therefore drawn again for each block. The code has no
separate "rotation" schedule or epoch; searching `src/libs/consensus` for
"rotat" finds only `SECRETARY_ROTATION_GRACE_SECONDS` (a timeout, 90 s, in
`src/libs/consensus/routines/consensusTime.ts:9`). "Shard rotation" in this
document means this per-block redraw.

With `committeeBinding`, retries at one height keep the same committee,
because the seed depends only on blocks up to the parent
(`src/libs/consensus/v2/routines/getShard.ts:338-341`).

## Implemented or only described

| Item | State at this commit | Evidence |
| ---- | -------------------- | -------- |
| Seed derivation (SHA-256 over last 3 blocks plus genesis) | Implemented, used on the consensus path | `getCommonValidatorSeed.ts`, `PoRBFT.ts:847-860` |
| Seeded pool ranking with Alea and pinned identities | Implemented | `getShard.ts:251-335` |
| Committee derived from chain data only (`committeeBinding`) | Implemented; dormant unless a genesis schedules it | `getShard.ts:346-359`, `forkConfig.ts:692-700` |
| Seed comparison between peers in a round | Implemented | `manageConsensusRoutines.ts:375-401` |
| `BridgesControls.getShardFromCVSA` (bridge controllers from the seed) | Not implemented: TODO, returns `[]`; `bridges.ts` is not imported from other files under `src/` | `bridges.ts:105-110` |
| Formal specification of CVSA | Not in this repository | see "Not found" above |
| Whether the Yellow Paper contains or publishes a CVSA specification | Not determined from the code | `README.md:11-13` only links to it |

Tests that exercise this code exist (`boundCommittee.test.ts` and
`secretaryManager.committee.test.ts`). They were not run for this document
(unrun).

## Open questions for the maintainers

1. Should "CVSA" name the algorithm, the value, or both? The code uses both
   senses (see Summary).
2. Where does the sentence "pseudorandom seed from the CVSA" live? It is
   not in this repository.
3. Is the Yellow Paper specification of CVSA the same as the five steps in
   the header comment (last three blocks, genesis hash, SHA-256)? This
   needs a reader of the Yellow Paper; it cannot be settled from this code.
4. Which running networks have `committeeBinding` active, and what is their
   `shardSize`? The repository only gives the intended values (mainnet
   template: `shardSize` 10, `committeeBinding` at height 0).

## Sources

- `src/libs/consensus/v2/routines/getCommonValidatorSeed.ts`
  (1-12, 80, 82-88, 90, 92-98, 100-104, 115-126, 137-149, 152-154, 167,
  177-181)
- `src/libs/consensus/v2/routines/getShard.ts` (58-69, 83-101, 107-158,
  165-201, 203-244, 251-335, 338-341, 346-359, 386, 393-424, 431-438, 464-489)
- `src/libs/consensus/v2/routines/poolRules.ts` (37-56, 64-71)
- `src/libs/consensus/v2/PoRBFT.ts` (847-860)
- `src/libs/consensus/v2/types/secretaryManager.ts` (219-263)
- `src/libs/consensus/v2/types/shardTypes.ts` (5)
- `src/libs/consensus/v2/routines/createBlock.ts` (90, 149-153, 252-255)
- `src/libs/consensus/v2/routines/stallDetection.ts` (95, 117-132)
- `src/libs/blockchain/chainGenesis.ts` (23-26)
- `src/libs/network/manageConsensusRoutines.ts` (353-357, 375-401)
- `src/libs/omniprotocol/protocol/handlers/consensus.ts` (200-212), `src/libs/omniprotocol/protocol/registry.ts` (256-261), `src/libs/omniprotocol/protocol/opcodes.ts` (37)
- `src/libs/consensus/genesisShardSize.ts` (19-21, 63-84)
- `src/libs/consensus/routines/consensusTime.ts` (9)
- `src/utilities/sharedState.ts` (121-140, 568-571)
- `src/utilities/constants.ts` (78-87)
- `src/forks/forkConfig.ts` (692-700, 714, 732)
- `src/libs/crypto/hashing.ts` (15-17)
- `src/features/bridges/bridges.ts` (8, 105-110)
- `docs/mainnet/genesis.template.json` (6, 31-33), `data/genesis.json` (6, 11-19)
- `documentation/new-consensus.md` (18)
- `README.md` (11-13), `package.json` (139)
