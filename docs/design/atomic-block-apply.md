# Atomic block apply: state commits with the block

Status: implemented on the consensus path and both sync paths. No fork: the
change is to how a node writes its own database, not to what it accepts.

## Problem

A block used to reach the database in three commits: the state edits of its
transactions in one transaction, then the block and its transactions in a
second one, with the L2PS proof edits and the ZK writes in commits of their
own in between. A crash or an error between any two left balances and nonces
ahead of the chain with no block authorising them. The orphan detector only
sees assignment stamps, and after the first fix moved the stamps into the
state transaction, a crash before the block insert still left state the
detector could roll back only while the transaction bodies were in the
mempool. A re-synced block whose edits had already landed was applied again.

## Rule

One database transaction covers everything a block changes: the GCR entity
caches, the assignment stamps, the deferred writes that belong to the block
(ZK nullifiers and commitments, L2PS proof status), the fork activation hooks
and the block row with its transactions. Either all of it is on disk or none
of it is. Side effects that follow from the state (points awards, the L2PS
batch transaction and mempool cleanup) run once the transaction has
committed.

## Mechanism

- `HandleGCR.applyTransactions(txs, isRollback, clock, { defer: true })`
  applies in memory and returns the outcome as `pending`, a
  `PendingGCRWrite`, instead of committing it. `pending.write(em)` flushes
  the caches, the stamps and the deferred writes through the entity manager
  of the caller's transaction. `pending.afterCommit()` runs the side effects.
- `insertBlock(block, txs, position, pending)` opens the block transaction,
  writes `pending` first, then the fork hooks and the block, and runs
  `afterCommit` once the transaction has returned. The write holds the GCR
  write mutex for the whole transaction. A block already on disk is returned
  as is: its state was committed with it.
- Edit handlers that need their own database writes return them as
  `GCRResult.deferredWrite` rather than writing during the apply. The ZK
  attestation handler checks the proof during the apply
  (`ProofVerifier.checkIdentityAttestation`, which marks nothing) and, in
  the deferred write, verifies again under a lock on the nullifier, marks it
  and awards the points through the manager. The RPC acceptance path uses
  the same check, so a nullifier is only ever marked by the block that
  carries its transaction. The ZK commitment handler refuses a duplicate
  during the apply and inserts in the deferred write.
- The validator stake and governance routines write their own tables and
  take a repository argument. The dispatch hands them a staged repository
  whose `save` is collected into the edit's deferred write instead of
  issued. The row is copied as saved, so a later edit that changes it and
  then fails leaves the write as it was.
- A block with no transactions still carries an empty pending write, so its
  L2PS proofs commit with it too.

## Conflicts inside one block

A deferred write that throws fails the block transaction, and on the
consensus path that is a fatal error. So two transactions of one block
that would collide at commit must be resolved during the apply, where the
second fails alone:

- The entity caches carry what the block has staged so far: validator rows,
  proposal and vote rows, and the ZK commitment hashes and nullifiers it
  has claimed. The ZK routines refuse a hash or nullifier the block already
  claims, before they read the database. The nullifier is the one the
  verifier reads from the proof, not the one the payload states.
- The governance repositories read through the staged rows: a proposal id
  the block already carries is reported as persisted, a parameter an
  earlier proposal locked stays locked, the next version counts the staged
  proposals, and a second vote from one validator is reported as persisted.
- Every edit on one of these caches shares a partition key (`zk`,
  `validators`, `gov`), so such transactions apply in block order rather
  than in parallel groups, and every node resolves a conflict the same way.
- A transaction that fails part-way restores the staged caches along with
  its accounts, so the claims and rows of a failed transaction do not block
  a later one.

## Edit types and where they write

| Edit | During apply | In the block transaction |
|---|---|---|
| balance, nonce, identity (xm, web2, pqc, ud, nomis, ethos, human passport, tlsn) | entity cache | cache flush |
| storageProgram, tlsnotary, work-attempt, resource-slot-cas, storage-program-put | entity cache | cache flush |
| zk_commitmentadd, zk_attestationadd | reads only | deferred write |
| validatorStake | staged row | deferred write |
| networkUpgrade, networkUpgradeVote | staged row | deferred write |
| assign, subnetsTx, smartContract, escrow | nothing (not implemented) | nothing |

Points awards attached to identity edits are side effects and run after the
commit, as before.
- L2PS proofs applied at consensus join the block's pending state: a row
  the block already edited, of any cache, is read from `pending`, not the
  database, and every cache of the proof's result is written back into
  it. The proof is marked applied in the block transaction; its
  bookkeeping runs after the commit.
- Consensus: `applyGCREditsFromMergedMempool` applies deferred, the vote
  runs on the in-memory outcome, and `finalizeBlock` commits it with the
  block. A round that ends before the insert drops `pending`; there is
  nothing on disk to undo.
- Sync: `applyVerifiedBlock` applies deferred, compares the statuses the
  peer served with the local outcome, and only then commits with the block.
  A disagreeing status rejects the block without touching state. A failed
  insert leaves the state before the block and the block can be applied
  again.

## What remains

- `rollbackOrphanedGcrState` and the drift latch stay for stamps left by an
  older binary. They cannot be produced by this code.
- `syncGCRTables` and the rollback paths still commit through
  `saveGCREditChanges`; the orphan repair is the only caller.
- The nonce trace, enabled by `DEBUG_ASSERTIONS_ENABLED`, reads the nonces
  after apply from `pending` rather than from the database.

## Evidence

`src/libs/blockchain/blockApplyAtomicity.test.ts` injects a failure at each
write phase of the block transaction (state, stamps, deferred write, block
row, transaction rows) and checks that nothing is durable, no side effect
ran, the head did not move, and a retry applies cleanly. The sync and
adoption suites check that a rejected block and a failed insert both leave
state untouched and never call a rollback.

`testing/forks/rehearsal/scenarios/11-sigkill-replay.ts` runs the four-node
devnet with a funded wallet streaming transfers through the nodes that
stay up, kills node-4 and node-2 in turn with SIGKILL at a random point in
the block interval, restarts them, checks that the block in flight at the
kill carried transactions, and checks each restarted node for an
assignment stamp above its tip or a drift line in its logs. At the end
every node must hold the same block hash, the same balance and nonce for
each harness wallet, the same `gcr_main` sum, and every accepted transfer
in the same block. Each wallet sends through one node with the SDK's
client-side nonce sequencing on, so its transfers all confirm. It passed
on 2026-11-02 with four rounds, 125 transfers, and 9 to 54 confirmed
transfers in each block that was in flight at a kill:

```
DEVNET_PREBUILT_IMAGE=1 bun run testing/forks/rehearsal/scenarios/11-sigkill-replay.ts
```

The scenario stakes the four devnet identities in the staged genesis with
`shardSize` 4, hides the bundled snapshot behind an empty mount, and runs
with gossip off and `OMNI_MODE=HTTP_ONLY`, as the race and quorum harnesses
do. `DEVNET_PREBUILT_IMAGE=1` skips the compose build and uses an existing
`demos-devnet-node` image; on an arm64 host build that image without
lifecycle scripts, since `utf-8-validate` has no prebuilt binary there.
