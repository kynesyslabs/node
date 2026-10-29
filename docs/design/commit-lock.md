# Commit lock: one certified block per height

Status: implemented behind the `commitLock` fork (dormant until a height is set).

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
restricted by the signing record beyond what step 1 decides, but a member
never prevotes or precommits in a round lower than one it already prevoted
in (see Prevote record under Implementation notes).

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

## Implementation notes

Clarifications made while implementing the design:

- Round. The secretary timestamp as forging starts, captured once per
  attempt; a later greenlight may raise the manager's timestamp, not the
  attempt's round. Every member forges with the same secretary timestamp,
  so the members of one attempt share its round.
- Wire. proposeBlockHash carries the round as a fifth param, and a member
  whose candidate is for another round answers 409. precommitBlockHash
  takes [hash, round, height, POL, precommits] and answers with every
  precommit the member holds for that block and round, its own included.
  getLock takes [height]. Both new methods are answered outside the
  consensus window and never start a round; both check the authenticated
  sender against the bound committee and cap vote maps at its size; a
  height already committed is answered with the block (410), as for a
  proposal.
- Step 3 gate. Under the fork the producer moves on when its candidate
  holds a POL (q verified committee prevotes), in place of counting the
  members that answered 200.
- Step 4, "X is its own candidate", is narrowed to: X is the block of the
  member's latest prevote, in that round, and the member has not yet begun
  choosing the candidate of its next attempt. The next attempt closes the
  prevote under the same mutex as the lock decision. Without this a member
  could prevote X' in r' and afterwards precommit X in an earlier round,
  and the safety argument relies on an honest member's precommit in r
  never following its own prevote in a later round. A late precommit
  request after a failed tally is still served until then, which is what
  lets the others lock on a block one member already committed.
- Signing record. Under the fork it records precommits only, keyed by
  (height, round); its rule (no earlier round, one block per round) agrees
  with the lock rule, so it is a second guard. The own-signature check
  compares a block's round with the record.
- Prevote record. A member never acts in a round lower than one it already
  acted in. Without this a secretary could gather prevotes for Y in round
  r2 and hide them, drive a lower round r1 < r2 to a certificate for X,
  and on the retry the hidden proof of lock from r2 would outrank the
  locks on X from r1 and certify Y too. The latest prevote (height, round,
  block) is written durably to `<identity>.prevote.json`, next to the
  lock, before the prevote is signed, under the lock mutex. A prevote in a
  lower round or height, or for another block in the same round, is
  refused, and so is a precommit in a round below the recorded prevote.
  An unreadable record refuses both. Prevotes are also refused while
  signing is stopped (halt, marker, lease). Honest retries carry later
  secretary timestamps, so their rounds rise anyway; a member asked to
  vote in a lower round sits that round out.
- Lock store. `<identity>.commitlock.json` next to the real signing record
  (following its symlink), written with writeFileDurably before the
  precommit is signed. A lock that exists but cannot be read stops
  precommits instead of reading as absent.
- Retry. getLock is asked when this process's previous attempt at H
  failed, or when its own lock binds H (which covers a restart). A first
  attempt asks nobody: a member that missed earlier attempts forges fresh,
  which an unlocked member may, and learns the locks on its next retry.
- Candidate fallback. Locked on X: blocks with a POL from a round above the
  lock's, highest first, then X; never a fresh block. If none can be
  rebuilt, the attempt ends without prevoting. Unlocked: reported blocks
  by POL round, then a fresh block. A reported POL is kept only if it
  verifies against the committee. Every set of inputs reported for a block
  is tried, and the rebuilt block must hash to it before anything is
  signed. The transactions are fetched from the members that reported the
  block when missing, admitted through the mempool's own validation, and
  must pass the same mempool filters unchanged.
- Certificate. The committed block is a copy of the candidate whose
  validation data is exactly the round's verified committee precommits and
  the round; the candidate keeps its prevotes, which inbound proposals may
  still be merging into.
- Equivocation. Counted for two precommits by one key at one height in the
  same round for different blocks. Different blocks in different rounds
  are what a lock move looks like and are only logged.
- Round bound. A lock outranks every lower round, so a lock taken in a
  far-future round would refuse every honest round until the clocks caught
  up. A member neither prevotes, precommits nor follows a reported lock in
  a round more than COSIGN_TIMESTAMP_MAX_LEAD_SECONDS (5 s) ahead of its
  network clock, the bound it applies to any timestamp it signs.
- Lost lock. A signing record at H with no lock at H means the lock file
  was lost after a precommit; the member refuses to precommit at H instead
  of reading as unlocked.
- Precommit exchange. It returns as soon as the book holds q precommits for
  the block, whether they came back from our sends or arrived in the other
  members' own requests; the other sends finish in the background, and a member marked
  offline gets one attempt, so a dead member does not delay each block.
  getLock still waits for every reply (one attempt, 3 s at most): a
  missing report can change the candidate, and it runs only on retries.
- Activation. A genesis that schedules commitLock without committeeBinding
  active at or below the same height is refused at boot; fork state set
  any other way is treated as inactive.

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
