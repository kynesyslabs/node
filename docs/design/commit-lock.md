# Commit lock: one certified block per height

Status: proposed, behind the `commitLock` fork (dormant until a height is set).

## Problem

A validator signs exactly one thing per round: its own candidate block hash.
That signature is both its vote and part of the block's certificate. A round
that fails at height H is retried with a new secretary timestamp, and the
signing record allows a different hash at H when the timestamp is later.

So a validator's signature on X can sit in a quorum that a cut-off member
holds and commits, while the validator itself retries H and signs Y. With
enough such validators, X and Y both carry a valid quorum: two certified
blocks at one height. Same-height adoption (ask the previous round's members
before retrying, push every commit) closes this when the committer is
reachable. It does not when the committer commits and is then cut off before
anyone learns of it; the conflicting-block alert then fires after the fact.

Refusing every second signature at H (one hash per height, whatever the
round) closes the fork but stalls the chain whenever a round fails with the
members split between different candidates: each is locked on its own
candidate and none reaches the quorum. Releasing the lock only when a
signature "never left the process" does not help, because every candidate
signature leaves the process in the vote exchange.

## Design: two phases with a lock on the second

The single signature is split into a prevote and a precommit, and only the
precommit locks. This is the Tendermint locking rule mapped onto the
existing round structure.

Definitions, per height H:

- round r: the secretary timestamp of the attempt. Retries of H use later
  timestamps; a round is never reused.
- committee: the bound committee of H (`getBoundCommittee(H-1)`), n members,
  quorum q = the producer's quorum for shardSize.
- prevote(X, r): signature over `demos-prevote:<H>:<r>:<X>`.
- precommit(X, r): signature over `demos-precommit:<H>:<r>:<X>`.
- POL(X, r): proof of lock, q valid committee prevotes for X in round r.
- certificate: q valid committee precommits for X in one round r. This is
  what the block carries (`validation_data.signatures`, plus
  `validation_data.round`) and what `verifyBlock` checks under the fork.

The domain prefixes keep a prevote from being replayed as a precommit and a
signature at one height or round from counting at another.

### Round, for a committee member

1. Candidate. If the member is locked on X with POL round p and knows no
   POL for a different block with a round above p, its candidate is X,
   rebuilt from the lock's persisted inputs (ordered transaction hashes,
   peerlist, block timestamp). Otherwise, if it knows a valid POL from any
   member (the highest round wins), its candidate is that block, rebuilt
   from the inputs carried with the POL. Otherwise it forges a fresh block
   as today.
2. Prevote. It prevotes its candidate in round r and exchanges prevotes in
   the existing proposeBlockHash flow (a member prevotes only a hash equal
   to its own candidate, as today).
3. Lock. When it holds POL(X, r), it durably writes the lock
   {H, X, r, POL, inputs} before signing anything else, then precommits X in
   round r and sends the precommit with the POL to the committee
   (precommitBlockHash).
4. A member receiving precommitBlockHash(X, r, POL) checks the POL against
   the committee, checks that X is its own candidate, applies the lock rule
   (below), writes its lock, precommits and answers with its precommit.
5. Commit. A member holding q precommits for X in round r commits X with
   that certificate through the existing commit path and pushes it.

Lock rule: a member locked on X with POL round p precommits only X. It may
move its lock to X' only on seeing POL(X', r') with r' > p. Prevotes are not
restricted by the signing record beyond what step 1 decides.

### Retry

Before forging a retry of H, a member asks every committee member for its
lock at H (getLock). The reply carries the lock with its POL and the block
inputs, or nothing; a member that already committed H answers with the
committed block as same-height adoption does today. Replies feed step 1. The
transactions named by a lock's inputs are fetched with the block if the
member's mempool lacks them.

### Why this is safe

Suppose X is committed in round r: q members precommitted X in round r, so
at least q - f honest members are locked on X with POL round r. A POL for
X' != X in a later round r' needs q prevotes in r'. Any two sets of q
members of an n-member committee share at least 2q - n > f members, so at
least one honest member locked on X prevoted X' in r'. By the lock rule it
did so only after seeing a POL for X' in a round between r and r'. Taking r'
as the earliest such round gives a contradiction, so no POL and therefore no
certificate for X' exists at H.

Precommits in different rounds are never mixed into one certificate, and
the prevote round is inside the signed message, so an old prevote cannot be
presented as a newer POL.

### Why it does not stall

A split round (members on different candidates, no POL) locks nobody, so
the retry forges fresh blocks as today. Once some member holds a POL, the
getLock exchange spreads it, every member's next candidate is the
highest-round POL block, and the round completes with q online members. The
only stall is the inherent one: fewer than q committee members online.

## What changes

- `forkConfig`: `commitLock`, dormant.
- `createBlock` and the proposeBlockHash flow: prevote domain with height and
  round under the fork.
- A precommit phase after a successful prevote tally in `consensusRoutine`,
  and a precommitBlockHash handler.
- A lock store next to the signing record, written with the same
  durability (`writeFileDurably`) and bound to the genesis hash.
- getLock RPC and the candidate choice of step 1 in the retry path.
- `verifyBlock`, `producerCommitRefusal`, sync and the own-signature check:
  the certificate is q precommits in one round under the fork.
- Metrics: `demos_commit_lock_total`, `demos_lock_moved_total`, and an
  equivocation counter for two precommits by one key at one height.

Before the fork height nothing changes, so testnet history still verifies.

## Cost

One more exchange per block (the precommits), about one network round trip.
A lock file write per block. Blocks carry precommits instead of prevotes.

## Decisions needed

- Activation: `commitLock` at 0 in the mainnet genesis, with
  `committeeBinding` and `quorumParity` (it relies on the bound committee for
  q and for the 2q - n > f overlap).
- This replaces the choice between the strict one-hash-per-height rule
  (stalls on split rounds) and the released-signature variant (does not
  close the fork).
