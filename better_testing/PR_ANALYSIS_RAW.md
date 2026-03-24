===== coderabbitai[bot] (21 comments) =====
--- comment 1/2 ---
Time: 2026-03-23T12:32:19Z
Type: issue_comment
URL: https://github.com/kynesyslabs/node/pull/692#issuecomment-4110279864
Body:



[!NOTE]
Currently processing new changes in this PR. This may take a few minutes, please wait...


⚙️ Run configuration

Configuration used: Organization UI

Review profile: CHILL

Plan: Pro

Run ID: 01c9238a-e2ec-4f83-9b93-f64e3d8b3e00




📥 Commits

Reviewing files that changed from the base of the PR and between 5e9ded425fb6c4f9e570f5a6e99429f54fd23076 and 5d2fffd895dfa3d66e882dd17e7acc35a82d3eef.




📒 Files selected for processing (22)

* package.json
* petri/01-implementation-plan.md
* petri/03-secretary-coordinated-signing.md
* petri/VADEMECUM.md
* petri/architecture-diagram.md
* src/libs/consensus/petri/coordination/petriSecretary.ts
* src/libs/consensus/petri/utils/canonicalJson.ts
* testing/petri/benchmark.test.ts
* testing/petri/blockCompiler.test.ts
* testing/petri/byzantineFault.test.ts
* testing/petri/canonicalJson.test.ts
* testing/petri/classifier.test.ts
* testing/petri/conflictPath.test.ts
* testing/petri/continuousForge.test.ts
* testing/petri/deltaTracker.test.ts
* testing/petri/featureFlagRollback.test.ts
* testing/petri/finality.test.ts
* testing/petri/happyPath.test.ts
* testing/petri/liveness.test.ts
* testing/petri/routing.test.ts
* testing/petri/secretaryCoordination.test.ts
* testing/petri/speculativeExecutor.test.ts



ascii
 

 --------------------------------------------------------------------------------------------------------------------------------
  \
   \   \
        \ /\
        ( )
      .( o ).






Walkthrough

This pull request implements the "Petri Consensus" protocol as a comprehensive replacement for PoRBFT v2, introducing a feature-flagged continuous-forge consensus loop, delta-based transaction agreement tracking, speculative execution, BFT arbitration for conflicting transactions, and secretary-coordinated block signing. The implementation spans configuration wiring, new consensus modules, mempool/classification extensions, RPC dispatch routing, integration tests, and devnet test scenarios.

Changes

| Cohort / File(s) | Summary |
|---|---|
| Configuration & Environment  .env.example, src/config/defaults.ts, src/config/envKeys.ts, src/config/types.ts, src/config/loader.ts, src/config/index.ts | Added OMNI_ENABLED and OMNI_MODE configuration, plus new Petri consensus environment variables (PETRI_CONSENSUS, PETRI_FORGE_INTERVAL_MS, PETRI_BLOCK_INTERVAL_MS, PETRI_AGREEMENT_THRESHOLD, PETRI_PROBLEMATIC_TTL_ROUNDS, PETRI_SHARD_SIZE) with corresponding config types and loading logic. |
| Petri Consensus Core Types  src/libs/consensus/petri/types/* | New type definitions for Petri: TransactionClassification, ClassifiedTransaction, StateDelta, PeerDelta, ContinuousForgeRound, ForgeState, DeltaComparison, RoundDeltaResult, and PetriConfig with defaults. |
| Delta Tracking & Agreement  src/libs/consensus/petri/forge/deltaAgreementTracker.ts, src/libs/consensus/petri/forge/continuousForge.ts, src/libs/consensus/petri/forge/forgeInstance.ts | Implements the 2-second forge loop: DeltaAgreementTracker evaluates transaction agreement via per-member delta submissions; ContinuousForge orchestrates mempool sync, speculative execution, delta exchange with peers, and agreement evaluation; forgeInstance.ts provides singleton access for RPC handlers. |
| Transaction Classification & Execution  src/libs/consensus/petri/classifier/transactionClassifier.ts, src/libs/consensus/petri/execution/speculativeExecutor.ts | classifyTransaction categorizes transactions as PRE_APPROVED (fee-only edits), TO_APPROVE (state-changing), or PROBLEMATIC; executeSpeculatively runs GCR edits in simulation mode and deterministically computes delta hashes via canonical JSON serialization. |
| Block Compilation & Finalization  src/libs/consensus/petri/block/petriBlockCompiler.ts, src/libs/consensus/petri/block/petriBlockFinalizer.ts | compileBlock creates deterministic blocks with promoted transactions at 10-second boundaries; finalizeBlock handles secretary-based signature collection with BFT threshold validation (2/3+1) and member-side polling. |
| BFT Arbitration & Secretary Coordination  src/libs/consensus/petri/arbitration/bftArbitrator.ts, src/libs/consensus/petri/coordination/petriSecretary.ts | arbitrate resolves PROBLEMATIC transactions via re-execution and peer delta polling, promoting or rejecting based on BFT threshold; petriSecretary handles deterministic secretary election, signature collection with timeout, mismatch handling, and failover. |
| Shard Routing & Utilities  src/libs/consensus/petri/routing/shardMapper.ts, src/libs/consensus/petri/routing/petriRouter.ts, src/libs/consensus/petri/utils/canonicalJson.ts, src/libs/consensus/petri/finality/transactionFinality.ts | Single-shard testnet routing via getShardForAddress and selectMembers; relay to deterministically selected peers; deterministic canonical JSON serialization; transaction finality result lookup from chain/mempool. |
| Petri Entry Point & Orchestration  src/libs/consensus/petri/index.ts | Main petriConsensusRoutine(shard) launches the forge, executes block periods (pause forge, arbitrate, compile, finalize, clean mempool), and handles lifecycle/concurrency guards. |
| Mempool Extensions  src/libs/blockchain/mempool_v2.ts, src/model/entities/Mempool.ts | Added columns for Petri classification, delta hash, and soft finality timestamp; new query methods getByClassification(), getPreApproved(), updateClassification(); speculative classification and delta computation on transaction insertion when Petri is enabled. |
| Consensus v2 Petri Integration  src/libs/consensus/v2/routines/broadcastBlockHash.ts, src/libs/consensus/v2/routines/manageProposeBlockHash.ts, src/libs/consensus/v2/routines/ensureCandidateBlockFormed.ts, src/libs/consensus/v2/routines/orderTransactions.ts | Broadcast now sends to all peers; manageProposeBlockHash supports Petri mode (sign hash, return signature); ensureCandidateBlockFormed polls for Petri candidate block; orderTransactions adds deterministic tie-breaking by hash. |
| Deprecated Consensus v2 Classes  src/libs/consensus/v2/PoRBFT.ts, src/libs/consensus/v2/types/secretaryManager.ts, src/libs/consensus/v2/types/validationStatusTypes.ts, src/libs/omniprotocol/protocol/handlers/consensus.ts | Added deprecation notices indicating these PoRBFT v2 components are retained as fallback behind feature flag and planned for removal. |
| Network RPC Dispatch & Handlers  src/libs/network/manageConsensusRoutines.ts, src/libs/network/rpcDispatch.ts, src/libs/network/endpointExecution.ts, src/libs/network/endpointValidation.ts, src/libs/communications/broadcastManager.ts | Added Petri RPC methods (petri_exchangeDeltas, petri_submitBlockHash, getTransactionFinality); routed consensus startup to petriConsensusRoutine when enabled; gated legacy Secretary RPCs to no-ops; relay now routes through Petri when enabled; broadcast sends to all peers. |
| Chain & Block Persistence  src/libs/blockchain/chainBlocks.ts, src/libs/blockchain/l2ps_mempool.ts, src/model/entities/Transactions.ts | Refactored insertBlock to use savepoints per transaction for isolated rollback; added soft_finality_at column to Transactions; Petri mode bypasses Secretary reference for block numbers. |
| Shared State & Startup  src/utilities/sharedState.ts, src/utilities/mainLoop.ts, src/index.ts | Added petriConsensus boolean flag and petriConfig object to SharedState; main loop dispatches to petriConsensusRoutine when enabled; warmup wires Petri config from environment. |
| Metrics  src/features/metrics/MetricsCollector.ts | Added Petri consensus gauges (petri_enabled, petri_forge_running, petri_forge_paused, petri_forge_round, petri_pending_tx_count, petri_tracker_tx_count) and collection routine. |
| Petri Documentation  petri/00-codebase-mapping.md, petri/01-implementation-plan.md, petri/02-risks-and-considerations.md, petri/03-secretary-coordinated-signing.md, petri/consensus.md, petri/petri.md, petri/VADEMECUM.md | Comprehensive design documentation: phase mapping, implementation plan with task breakdowns, risk mitigation strategies, secretary-coordinated signing spec, runtime control flow reference, protocol overview, and operational playbook with testing/safety guardrails. |
| Agent & Team Mode Documentation  AGENTS.md, TEAM.md, .gitignore | Replaced AGENTS.md instructions with pointer to TEAM.md; added new TEAM.md defining "Team Mode" behavioral overlay with delegation-first workflow and tiered responsibilities; added /testing/runs to .gitignore. |
| Unit Tests – Petri Consensus  better_testing/petri/benchmark.test.ts, better_testing/petri/blockCompiler.test.ts, better_testing/petri/byzantineFault.test.ts, better_testing/petri/canonicalJson.test.ts, better_testing/petri/classifier.test.ts, better_testing/petri/conflictPath.test.ts, better_testing/petri/continuousForge.test.ts, better_testing/petri/deltaTracker.test.ts, better_testing/petri/featureFlagRollback.test.ts, better_testing/petri/finality.test.ts, better_testing/petri/happyPath.test.ts, better_testing/petri/liveness.test.ts, better_testing/petri/routing.test.ts, better_testing/petri/secretaryCoordination.test.ts, better_testing/petri/speculativeExecutor.test.ts | 186 comprehensive unit tests covering: performance benchmarks, BFT arbitration logic, Byzantine fault scenarios, canonical JSON determinism, transaction classification, conflict resolution, continuous forge lifecycle, delta agreement tracking, feature flag rollback, transaction finality, happy-path consensus flow, liveness/block production, shard routing, secretary coordination, and speculative execution. |
| Devnet Test Scenarios  testing/loadgen/src/features/consensus/petri_block_production.ts, testing/loadgen/src/features/consensus/petri_relay_flow.ts, testing/loadgen/src/features/consensus/petri_soak.ts, testing/loadgen/src/features/consensus/petri_tx_inclusion.ts, testing/loadgen/src/main.ts | Four end-to-end Petri consensus test scenarios: block production verification, transaction relay propagation, continuous soak testing with finality latency measurement, and transaction inclusion + finality tracking. |
| Test Infrastructure & Coverage  testing/TESTING_MAP.md, testing/scripts/run-suite.ts, package.json, testing/devnet/.env.example, testing/devnet/docker-compose.yml, data/genesis.json | Added test:petri npm script; registered new petri test suite with four scenarios; enabled Petri in devnet .env; updated docker-compose to wire Petri env vars and fix OMNI port mappings; added test genesis accounts. |

Sequence Diagram(s)

mermaid
sequenceDiagram
    participant MainLoop as Main Loop
    participant PetriRoutine as petriConsensusRoutine
    participant Forge as ContinuousForge
    participant BlockPeriod as runBlockPeriod
    participant Arbitrator as bftArbitrator
    participant Compiler as petriBlockCompiler
    participant Finalizer as petriBlockFinalizer
    participant Chain as Chain DB

    MainLoop->>PetriRoutine: petriConsensusRoutine(shard)
    PetriRoutine->>Forge: new ContinuousForge(config)
    PetriRoutine->>Forge: start(shard)
    activate Forge
    Forge->>Forge: forgeRound loop (2s intervals)
    note over Forge: mempool sync, classify, execute, delta exchange, evaluate agreement

    PetriRoutine->>BlockPeriod: runBlockPeriod()
    Forge->>Forge: pause()
    deactivate Forge

    BlockPeriod->>Arbitrator: arbitrate(shard)
    Arbitrator->>Arbitrator: re-execute PROBLEMATIC txs
    Arbitrator->>Arbitrator: poll peers for delta agreement
    Arbitrator->>BlockPeriod: { resolved, rejectedHashes }

    BlockPeriod->>Compiler: compileBlock(shard, resolved)
    Compiler->>Compiler: filter mempool by block interval
    Compiler->>Compiler: order transactions deterministically
    Compiler->>Chain: createBlock(ordered)
    Compiler->>BlockPeriod: { block, includedTxHashes }

    BlockPeriod->>Finalizer: finalizeBlock(block, shard)
    alt Secretary Node
        Finalizer->>Finalizer: broadcast block hash to shard
        Finalizer->>Finalizer: collect signatures from peers
        Finalizer->>Finalizer: check BFT threshold (2/3+1)
        Finalizer->>Chain: insertBlock(block)
    else Member Node
        Finalizer->>Finalizer: poll lastBlockNumber
        Finalizer->>Finalizer: await secretary finalization
    end
    Finalizer->>BlockPeriod: { success, votes }

    BlockPeriod->>Chain: cleanRejectedFromMempool(rejectedHashes)
    Forge->>Forge: reset()
    Forge->>Forge: resume()
    activate Forge

    PetriRoutine->>PetriRoutine: loop continues


Estimated code review effort

🎯 5 (Critical) | ⏱️ ~120 minutes

Possibly related PRs

- [kynesyslabs/node#517](https://github.com/kynesyslabs/node/pull/517): Both modify overlapping core networking, mempool, and shared-state code (e.g., src/utilities/sharedState.ts, src/libs/blockchain/mempool_v2.ts) and introduce competing relay/routing flows (DTR vs. Petri).
- [kynesyslabs/node#476](https://github.com/kynesyslabs/node/pull/476): Both modify consensus v2 broadcast and signature handling routines (src/libs/consensus/v2/routines/broadcastBlockHash.ts) and consensus startup/control logic.
- [kynesyslabs/node#514](https://github.com/kynesyslabs/node/pull/514): Both modify src/libs/blockchain/l2ps_mempool.ts including block number determination and mempool transaction handling.

Suggested labels

consensus, petri, feature, testing, breaking-change

Suggested reviewers

- cwilvx

Poem

🐰 A forge now burns with delta's light,  
Consensus blooms through endless night,  
Eight phases strong, the shards align—  
Byzantine faults shall never mine! ✨  
Secretary signs, the blocks take flight.







✨ Finishing Touches


📝 Generate docstrings

- [ ]  Create stacked PR
- [ ]  Commit on current branch



🧪 Generate unit tests (beta)

- [ ]    Create PR with unit tests
- [ ]    Commit unit tests in branch petri
















--- comment 2/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794049
Body:
_⚠️ Potential issue_ | _🟠 Major_

Use the real election logic in this suite.

This helper just returns shard[0], but the production coordinator elects from a sorted identity set that also includes the local pubkey. The tests can pass while the shipped code elects a different secretary, so they aren't validating the behavior this PR actually introduces.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/secretaryCoordination.test.ts around lines 17 - 19, The
test helper electSecretary currently returns shard[0]; replace it with the real
election logic used in production so tests reflect actual behavior: ensure
electSecretary constructs the full identity set (including the local pubkey),
sorts the identities deterministically the same way the coordinator does, and
selects the secretary from that sorted set (or call the production election
function if available) so the test suite elects the same secretary as the
running coordinator.








--- comment 3/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794054
Body:
_⚠️ Potential issue_ | _🟠 Major_

Validate Petri invariants before freezing the config.

This loader explicitly owns validation, but the new Petri section currently accepts values that can never make consensus progress: non-positive intervals, shardSize  shardSize, or negative TTL rounds.



Suggested fix

diff
     const config: AppConfig = {
         server: serverConfig,
         database: {
             host: envStr(EnvKey.PG_HOST, d.database.host),
@@
         petri: {
             enabled: envBool(EnvKey.PETRI_CONSENSUS, d.petri.enabled),
             forgeIntervalMs: envInt(EnvKey.PETRI_FORGE_INTERVAL_MS, d.petri.forgeIntervalMs),
             blockIntervalMs: envInt(EnvKey.PETRI_BLOCK_INTERVAL_MS, d.petri.blockIntervalMs),
             agreementThreshold: envInt(EnvKey.PETRI_AGREEMENT_THRESHOLD, d.petri.agreementThreshold),
             problematicTTLRounds: envInt(EnvKey.PETRI_PROBLEMATIC_TTL_ROUNDS, d.petri.problematicTTLRounds),
             shardSize: envInt(EnvKey.PETRI_SHARD_SIZE, d.petri.shardSize),
         },
     }
+
+    if (config.petri.forgeIntervalMs <= 0 || config.petri.blockIntervalMs <= 0) {
+        throw new Error("Petri intervals must be positive")
+    }
+    if (config.petri.shardSize <= 0) {
+        throw new Error("Petri shardSize must be positive")
+    }
+    if (
+        config.petri.agreementThreshold <= 0 ||
+        config.petri.agreementThreshold > config.petri.shardSize
+    ) {
+        throw new Error("Petri agreementThreshold must be between 1 and shardSize")
+    }
+    if (config.petri.problematicTTLRounds < 0) {
+        throw new Error("Petri problematicTTLRounds cannot be negative")
+    }
 
     return deepFreeze(config)
 }




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/config/loader.ts around lines 213 - 220, The Petri config currently
allows invalid values that break consensus; add validation in the loader before
the config is frozen to assert that petri.forgeIntervalMs and
petri.blockIntervalMs are > 0, petri.shardSize > 0, petri.problematicTTLRounds
= 0, petri.agreementThreshold > 0 and petri.agreementThreshold <=
petri.shardSize; if any check fails throw or return a descriptive error
(including the offending field and value) so the process cannot continue with an
invalid petri section (refer to the petri object and its keys: enabled,
forgeIntervalMs, blockIntervalMs, agreementThreshold, problematicTTLRounds,
shardSize).








--- comment 4/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794060
Body:
_🛠️ Refactor suggestion_ | _🟠 Major_

Unsafe type cast to access internal tracker property.

Using (forge as any).tracker bypasses TypeScript's type system and accesses what appears to be an internal implementation detail. If ContinuousForge refactors its internals, this will silently break.

Consider exposing a public method on ContinuousForge to retrieve tracker stats:




♻️ Recommended: Add public accessor to ContinuousForge

In ContinuousForge class:
typescript
public getTrackerCount(): number {
    return this.tracker?.trackedCount?.() ?? 0
}


Then in MetricsCollector:
diff
-            // Tracker count via the forge's internal tracker
-            const tracker = (forge as any).tracker
-            if (tracker && typeof tracker.trackedCount === "function") {
-                this.metricsService.setGauge("petri_tracker_tx_count", tracker.trackedCount())
-            }
+            this.metricsService.setGauge("petri_tracker_tx_count", forge.getTrackerCount())




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/features/metrics/MetricsCollector.ts around lines 763 - 767, The code in
MetricsCollector uses an unsafe cast (forge as any).tracker to read an internal
trackedCount, which can break if ContinuousForge internals change; add a public
accessor on ContinuousForge named getTrackerCount(): number that returns
this.tracker?.trackedCount?.() ?? 0, then update MetricsCollector to call
forge.getTrackerCount() (remove the any cast) and pass that value into
metricsService.setGauge("petri_tracker_tx_count", ...), ensuring a safe default
(0) when the tracker is absent.








--- comment 5/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794065
Body:
_⚠️ Potential issue_ | _🔴 Critical_

Deduplicate and filter the candidate transaction set before ordering.

This union can include the same transaction twice when an arbitrated resolvedTx is still present in the mempool, and it can still include hashes that arbitration just rejected because cleanup only happens after finalization. That means the block being finalized can hard-include a tx that was voted down. Build allTxs from a hash-keyed set and exclude rejected hashes before calling orderTransactions().


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/block/petriBlockCompiler.ts around lines 73 - 77,
The current allTxs concatenation can duplicate transactions (when a resolvedTx
is still in the mempool) and can include arbitration-rejected hashes; instead,
construct allTxs as a deduplicated hash-keyed set: iterate filteredMempoolTxs
and resolvedTxs, insert each Transaction by its unique hash (tx.hash) into a
Map/Object to de-duplicate, skip any hashes that are present in the arbitration
rejected set (the rejected hashes produced by arbitration), then build the final
array from the map values and pass that de-duplicated, filtered array to
orderTransactions(); ensure types match Transaction[] when converting the map
values.








--- comment 6/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794069
Body:
_⚠️ Potential issue_ | _🔴 Critical_


🧩 Analysis chain

🏁 Script executed:

shell
!/bin/bash
Check if broadcastBlockHash adds the caller's own signature
ast-grep --pattern $'async function broadcastBlockHash($_, $_) {
  $$$
}'

Also check the signature population logic
rg -nA 20 "validation_data.signatures" src/libs/consensus/v2/routines/broadcastBlockHash.ts


Repository: kynesyslabs/node

Length of output: 1240

---

🏁 Script executed:

shell
!/bin/bash
First, check if there's a petri-specific broadcastBlockHash
fd "broadcastBlockHash" src/libs/consensus/petri --type f

Check the full secretaryFinalize function in petriBlockFinalizer
rg -nB 5 -A 50 "secretaryFinalize" src/libs/consensus/petri/block/petriBlockFinalizer.ts | head -80

Also check if there's a signature adding logic for the secretary
rg -n "validation_data.signatures\[" src/libs/consensus/petri --type ts


Repository: kynesyslabs/node

Length of output: 2370

---

🏁 Script executed:

shell
!/bin/bash
Look for broadcastBlockHash in petri directory
fd "broadcastBlockHash" src/libs/consensus/petri -type f

If not found in petri, check imports in petriBlockFinalizer
rg -n "broadcastBlockHash\|import" src/libs/consensus/petri/block/petriBlockFinalizer.ts | head -20

Check if petri has its own manager or if it uses the v2 version
rg -n "broadcastBlockHash" src/libs/consensus --type ts | grep -i petri


Repository: kynesyslabs/node

Length of output: 1052

---

🏁 Script executed:

shell
!/bin/bash
Check if secretary signs within manageProposeBlockHash
rg -n "manageProposeBlockHash" src/libs/consensus/petri --type f

Look for where secretary might sign the block
rg -nB 3 -A 10 "manageProposeBlockHash" src/libs/consensus/petri/block/petriBlockFinalizer.ts

Check the full v2 broadcastBlockHash implementation to understand its flow
cat -n src/libs/consensus/v2/routines/broadcastBlockHash.ts


Repository: kynesyslabs/node

Length of output: 7543

---

🏁 Script executed:

shell
!/bin/bash
Find manageProposeBlockHash to see if secretary signs there
fd "manageProposeBlockHash" src/libs/consensus -type f

Check the petri implementation
rg -n "manageProposeBlockHash" src/libs/consensus/petri --type ts -A 30 | head -60

Also check if there's any signing logic in petriBlockFinalizer before/after broadcastBlockHash
rg -n "sign\|signature" src/libs/consensus/petri/block/petriBlockFinalizer.ts


Repository: kynesyslabs/node

Length of output: 5743

---

🏁 Script executed:

shell
!/bin/bash
Get the entire petriBlockFinalizer.ts file to see full context
wc -l src/libs/consensus/petri/block/petriBlockFinalizer.ts

Read the entire file
cat src/libs/consensus/petri/block/petriBlockFinalizer.ts


Repository: kynesyslabs/node

Length of output: 6631

---





Secretary must add their own signature to block.validation_data.signatures before the threshold check.

The threshold calculation at line 57 includes the secretary as a voting member (totalMembers = shard.length + 1), but broadcastBlockHash only broadcasts to shard peers and collects their signatures. The secretary never signs the block themselves.

This creates a mismatch: if shard.length = 8, the threshold becomes 7, but only 8 signatures maximum can be collected (from peers alone). The secretary's vote is counted in the threshold formula but never actually recorded, violating the Byzantine assumption that the threshold equals the minimum required signatures.

The secretary should sign the block (adding their signature to block.validation_data.signatures) before or immediately after calling broadcastBlockHash at line 88, or alternatively, the threshold formula should only account for shard peer signatures.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/block/petriBlockFinalizer.ts around lines 88 - 98,
The secretary's signature must be added to block.validation_data.signatures so
the threshold calculation matches actual recorded votes: after preparing the
block and before checking the BFT threshold in PetriBlockFinalizer (around where
broadcastBlockHash is called and signatureCount/threshold are used), have the
secretary generate/sign the block hash and insert its signature into
block.validation_data.signatures (the same signature shape used by peers) so
signatureCount includes the secretary; keep broadcastBlockHash as-is for peers'
signatures and then compute signatureCount and compare against threshold.








--- comment 7/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794071
Body:
_⚠️ Potential issue_ | _🟠 Major_

Make electSecretary() explicit about the local-secretary case.

When the elected identity is local, found is undefined and this falls back to shard[0], which is some other peer. handleSecretaryOffline() then probes/removes the wrong member, and a single-node shard gets undefined at runtime. Return an explicit self/null result instead of overloading Peer.





--- comment 8/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794077
Body:
_⚠️ Potential issue_ | _🔴 Critical_

Don't wipe buffered submissions when collection starts.

receiveBlockHashSubmission() is already buffering member responses as they arrive, but collectBlockHashes() immediately clears that inbox. Any submission that reaches the secretary before this function starts turns into a false timeout.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/coordination/petriSecretary.ts around lines 142 -
148, collectBlockHashes currently calls resetCollection() at the start which
clears the inbox and drops any submissions already buffered by
receiveBlockHashSubmission(); remove that initial resetCollection() call (or
change it to only initialize per-collection timers/state without clearing the
shared inbox) so previously received submissions are preserved when a new
collectBlockHashes run begins; ensure any collection-specific cleanup still
happens after the collection completes, keeping receiveBlockHashSubmission, the
inbox variable, and post-collection reset logic intact.








--- comment 9/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794083
Body:
_⚠️ Potential issue_ | _🔴 Critical_

Count each sender once during collection.

Only matching peers are recorded in signatures, so a mismatching or invalid submission stays in pendingSubmissions and gets re-counted on every poll iteration. That can push mismatchCount past the number of members, make timedOutCount negative, and incorrectly conclude that the threshold is unreachable.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/coordination/petriSecretary.ts around lines 177 -
217, The loop over pendingSubmissions in PetriSecretary currently only records
matching submissions in signatures, causing the same invalid/mismatched sender
to be re-counted each poll; update the logic so that every processed pubkey is
marked once regardless of outcome (either add pubkey to signatures with a
sentinel value or add to a new processed set) immediately after verification or
mismatch handling, then increment matchCount or mismatchCount accordingly and
ensure pendingSubmissions no longer re-counts that pubkey on subsequent
iterations; refer to pendingSubmissions, signatures, matchCount, mismatchCount,
expectedHash and the verify call (ucrypto.verify) to locate where to mark
senders as processed.








--- comment 10/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794092
Body:
_⚠️ Potential issue_ | _🔴 Critical_


🧩 Analysis chain

🏁 Script executed:

shell
!/bin/bash
Description: Identify all fields used across GCREdit types to verify which fields matter for determinism

Search for GCREdit type definitions in the demosdk or local codebase
rg -n "type.*GCREdit" --type=ts -A 20

Search for GCREdit interface/type usage patterns
ast-grep --pattern 'interface GCREdit { $$$ }'


Repository: kynesyslabs/node

Length of output: 27734

---

🏁 Script executed:

shell
Read the actual code around lines 99-110 to see full context
sed -n '85,125p' src/libs/consensus/petri/execution/speculativeExecutor.ts


Repository: kynesyslabs/node

Length of output: 1358

---

🏁 Script executed:

shell
Search for how editsForHashing is used after extraction
rg -n "editsForHashing" src/libs/consensus/petri/execution/speculativeExecutor.ts -A 5


Repository: kynesyslabs/node

Length of output: 538

---

🏁 Script executed:

shell
Search for how the StateDelta hash is computed
rg -n "canonicalJson\|delta\.hash\|Hashing\." src/libs/consensus/petri/execution/speculativeExecutor.ts -B 2 -A 2


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Look for other GCREdit field extractions in the codebase to see if there's a pattern
rg -n "\.map.*edit.*as unknown" src/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Find canonicalJson implementation
rg -n "canonicalJson" src/ --type=ts -B 2 -A 10


Repository: kynesyslabs/node

Length of output: 4806

---

🏁 Script executed:

shell
Look for tests of speculativeExecutor to understand the expected behavior
fd -e "\.test\.ts" -e "\.spec\.ts" | xargs rg -l "speculativeExecutor\|SpeculativeExecutor"


Repository: kynesyslabs/node

Length of output: 44

---

🏁 Script executed:

shell
Check if there are comments or documentation about GCREdit variants
rg -n "GCREdit.*variant\|GCREditBalance\|GCREditNonce\|GCREditIdentity" src/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Search for GCREdit type imports and see if SDK types are documented
rg -n "import.*GCREdit\|from.*demosdk" src/libs/consensus/petri/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Read the full canonicalJson function to understand how it processes objects
cat -n src/libs/consensus/petri/utils/canonicalJson.ts


Repository: kynesyslabs/node

Length of output: 1804

---

🏁 Script executed:

shell
Search for any comments or discussions about which GCREdit fields should be hashed
rg -n "editsForHashing\|delta hash\|determinism\|state.*hash" src/libs/consensus/petri/ --type=ts -B 3 -A 3


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check if there's documentation about GCREdit structure in comments or elsewhere
rg -n "GCREdit" src/types/nomis-augmentations.d.ts -B 5 -A 10


Repository: kynesyslabs/node

Length of output: 1448

---

🏁 Script executed:

shell
Look for test files that exercise the speculativeExecutor to understand intended behavior
find . -path ./node_modules -prune -o -name "*.test.ts" -o -name "*.spec.ts" | grep -i "petri\|executor" | head -5


Repository: kynesyslabs/node

Length of output: 278

---

🏁 Script executed:

shell
Look at the classifier test to see how GCREdit is used
cat -n better_testing/petri/classifier.test.ts | head -100


Repository: kynesyslabs/node

Length of output: 3798

---

🏁 Script executed:

shell
Look at the canonicalJson test to understand the hashing expectations
cat -n better_testing/petri/canonicalJson.test.ts


Repository: kynesyslabs/node

Length of output: 4602

---

🏁 Script executed:

shell
Check what the mock GCREdit definition includes
cat -n tests/mocks/demosdk-types.ts | sed -n '40,60p'


Repository: kynesyslabs/node

Length of output: 716

---

🏁 Script executed:

shell
Search for how StateDelta is consumed - check if the hash must match ALL edits or only certain fields
rg -n "delta\.hash\|edits.*hash\|StateDelta" src/libs/consensus/petri/ --type=ts -B 2 -A 2 | head -80


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check if there are multiple GCREdit type variants that might have different field structures
rg -n "type.*GCREdit\|interface.*GCREdit\|type GCREdit" tests/mocks/demosdk-types.ts -A 10


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Search for how GCREdit variants are handled in the codebase - look for type guards or discriminators
rg -n "edit\.type\s*===\|edit\.operation\|discriminat" src/libs/consensus/petri/ --type=ts -B 1 -A 1


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check if StateDelta.edits (storing full GCREdit) vs hash (from normalized) is intentional
cat -n src/libs/consensus/petri/types/stateDelta.ts


Repository: kynesyslabs/node

Length of output: 1205

---

🏁 Script executed:

shell
Search for if consensus verification compares hashes against normalized or full edits
rg -n "PeerDelta\|delta\.hash.*==\|hash.*agreement\|consensus.*hash" src/libs/consensus/petri/ --type=ts -B 2 -A 2


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Verify the actual comment in stateDelta.ts about what the hash represents
cat -n src/libs/consensus/petri/types/stateDelta.ts | sed -n '1,17p'


Repository: kynesyslabs/node

Length of output: 904

---

🏁 Script executed:

shell
Search for usage of StateDelta hash in consensus operations
rg -n "delta\.hash\|deltaHash\|delta.*==\|agreement.*hash" src/libs/consensus/petri/ --type=ts -B 1 -A 3


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Look for where the full edits vs normalized edits distinction matters
rg -n "edits.*==\|edits.*===\|deepEqual.*edits" src/libs/consensus/petri/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Find where StateDelta is stored/verified to understand if the hash must match exact edits
rg -n "StateDelta\|SpeculativeResult" src/libs/consensus/petri/ --type=ts | grep -v "import\|type.*=" | head -20


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check if there's a schema or consensus protocol that validates StateDelta
fd -e "\.ts" src/libs/consensus/petri/ | xargs grep -l "StateDelta" | head -5


Repository: kynesyslabs/node

Length of output: 465

---

🏁 Script executed:

shell
Read the file where StateDelta is used to see if verification compares against full edits or just hash
grep -r "delta\.hash\|editsForHashing" src/libs/consensus/petri/ --include="*.ts" -l


Repository: kynesyslabs/node

Length of output: 221

---

🏁 Script executed:

shell
Understand the design: does normalization happen by design or is it a bug?
Look at git history or comments around the editsForHashing code
sed -n '90,120p' src/libs/consensus/petri/execution/speculativeExecutor.ts


Repository: kynesyslabs/node

Length of output: 1073

---

🏁 Script executed:

shell
Check the arbitration/bftArbitrator to see how delta hashes are compared
cat -n src/libs/consensus/petri/arbitration/bftArbitrator.ts | head -80


Repository: kynesyslabs/node

Length of output: 3642

---

🏁 Script executed:

shell
Check the forge module to see if it validates deltas
cat -n src/libs/consensus/petri/forge/continuousForge.ts | head -100


Repository: kynesyslabs/node

Length of output: 4065

---

🏁 Script executed:

shell
Verify if there's logic that compares full edits vs normalized hash
rg -n "PeerDelta\|deltaHash\|delta\.hash" src/libs/consensus/petri/arbitration/ --type=ts -A 3 -B 2


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Critical: check if the StateDelta hash comment is accurate by examining all hash computations
rg -n "Hashing\.sha256.*edits\|deltaHash.*=" src/libs/consensus/petri/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check the bftArbitrator code more to see if it compares hashes from different deltas
sed -n '75,150p' src/libs/consensus/petri/arbitration/bftArbitrator.ts


Repository: kynesyslabs/node

Length of output: 3098

---

🏁 Script executed:

shell
Verify if the StateDelta comment is accurate
grep -n "SHA-256.*edits" src/libs/consensus/petri/types/stateDelta.ts


Repository: kynesyslabs/node

Length of output: 114

---

🏁 Script executed:

shell
Check if there are any reconciliation or verification steps that use the full edits vs hash
rg -n "specResult\.delta\.edits\|specResult\.delta\.hash" src/libs/consensus/petri/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Get the complete bftArbitrator context showing the hash comparison
cat -n src/libs/consensus/petri/arbitration/bftArbitrator.ts | sed -n '62,130p'


Repository: kynesyslabs/node

Length of output: 3537

---

🏁 Script executed:

shell
Look for the actual SDK GCREdit type definition reference
rg -n "@kynesyslabs/demosdk/types" src/libs/consensus/petri/execution/speculativeExecutor.ts -B 2 -A 2


Repository: kynesyslabs/node

Length of output: 266

---

🏁 Script executed:

shell
Search for any documentation or comments about GCREdit field selection
rg -n "discriminat\|variant\|union\|field.*matter\|normalize" src/libs/consensus/petri/execution/speculativeExecutor.ts -B 2 -A 2


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check if there's any SDK documentation or type stubs in the repo
find . -name "*.d.ts" -o -name "*demosdk*" | grep -v node_modules | head -10


Repository: kynesyslabs/node

Length of output: 418

---

🏁 Script executed:

shell
Verify the actual comment discrepancy between what's documented and what's computed
echo "=== StateDelta comment says: ===" && \
sed -n '14p' src/libs/consensus/petri/types/stateDelta.ts && \
echo "" && \
echo "=== But speculativeExecutor actually computes hash from: ===" && \
sed -n '99,113p' src/libs/consensus/petri/execution/speculativeExecutor.ts | grep -A 1 "editsForHashing\|canonicalEdits\|deltaHash"


Repository: kynesyslabs/node

Length of output: 432

---

🏁 Script executed:

shell
Search for any specification or design docs about GCREdit field handling
find . -name "*.md" -o -name "*.txt" | xargs grep -l "GCREdit\|delta.*hash\|consensus" 2>/dev/null | head -5


Repository: kynesyslabs/node

Length of output: 236

---

🏁 Script executed:

shell
Check if the normalization/field selection is documented elsewhere
rg -n "type.*operation.*account.*amount\|normalize.*edit\|extract.*field" src/libs/consensus/petri/ --type=ts -B 3 -A 3


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check the architecture and design docs for GCREdit handling strategy
grep -A 10 -B 2 "GCREdit\|delta.*hash\|determinism\|normalize" ./.planning/codebase/ARCHITECTURE.md


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Check concerns doc
grep -A 10 -B 2 "GCREdit\|hash\|consensus\|field" ./.planning/codebase/CONCERNS.md


Repository: kynesyslabs/node

Length of output: 7658

---

🏁 Script executed:

shell
Look at the full speculativeExecutor context around the problematic code
sed -n '1,50p' src/libs/consensus/petri/execution/speculativeExecutor.ts


Repository: kynesyslabs/node

Length of output: 2000

---

🏁 Script executed:

shell
Final check: verify if there are other places that compute delta hashes differently
rg -n "canonicalJson\|sha256.*edit\|Hashing\.sha256" src/libs/consensus/petri/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Verify what fields the normalized editsForHashing actually includes
sed -n '99,110p' src/libs/consensus/petri/execution/speculativeExecutor.ts


Repository: kynesyslabs/node

Length of output: 466

---

🏁 Script executed:

shell
Check if there are variants of GCREdit that might have different critical fields
rg -n "type === \"balance\"\|type === \"nonce\"\|type === \"identity\"" src/libs/consensus/petri/ --type=ts


Repository: kynesyslabs/node

Length of output: 42

---

🏁 Script executed:

shell
Final verification: is the StateDelta comment actually documenting the code correctly?
echo "What comment says:" && \
grep "SHA-256 of canonicalJson" src/libs/consensus/petri/types/stateDelta.ts && \
echo "" && \
echo "What code actually does:" && \
sed -n '112,113p' src/libs/consensus/petri/execution/speculativeExecutor.ts


Repository: kynesyslabs/node

Length of output: 267

---





The StateDelta.ts comment misrepresents what fields are hashed for consensus.

The comment claims hash: string // SHA-256 of canonicalJson(edits), but the code normalizes GCREdit objects to only {type, operation, account, amount} before hashing (lines 99–110). This creates a critical documentation gap: different full GCREdit objects with identical type/operation/account/amount but differing txhash, pubkey, name, key, or value fields would produce the same delta hash, risking silent consensus divergence if those omitted fields affect state.

Either update the StateDelta.ts comment to accurately reflect the normalized representation, or verify through SDK documentation that the 4-field subset is sufficient for deterministic state agreement across all GCREdit variants. If omitted fields should affect the hash, expand editsForHashing to include them.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/execution/speculativeExecutor.ts around lines 99 -
110, The StateDelta.ts comment and hashing logic disagree: editsForHashing in
speculativeExecutor.ts normalizes GCREdit objects to only {type, operation,
account, amount} before computing the hash, so update the StateDelta.ts comment
to state "SHA-256 of canonicalJson(normalizedEdits) where normalizedEdits only
include type, operation, account, amount" or, if other GCREdit fields (txhash,
pubkey, name, key, value) must influence consensus, modify the editsForHashing
construction in speculativeExecutor.ts (the editsForHashing mapping of GCREdit)
to include those additional fields before hashing; ensure you reference the
GCREdit shape and the hash property in StateDelta.ts so the comment accurately
reflects the exact fields used for the hash.








--- comment 11/2 ---
Time: 2026-03-23T12:42:22Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794107
Body:
_⚠️ Potential issue_ | _🟠 Major_

Reset currentRoundDeltas at the start of every round.

If this round has no TO_APPROVE transactions, or exits before the later assignment, getCurrentDeltas() keeps serving the previous round's hashes. Peers can then record stale deltas against the wrong round.



🔧 Proposed fix

diff
 async runForgeRound(): Promise {
     this.state.currentRound++
     this.state.lastRoundStartedAt = Date.now()
     const round = this.state.currentRound
+    this.currentRoundDeltas = {}
 
     log.debug([ContinuousForge] Round ${round} starting)






📝 Committable suggestion

‼️ IMPORTANT
Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

suggestion
    async runForgeRound(): Promise {
        this.state.currentRound++
        this.state.lastRoundStartedAt = Date.now()
        const round = this.state.currentRound
        this.currentRoundDeltas = {}

        log.debug([ContinuousForge] Round ${round} starting)

        try {
            // Step 1: Sync mempools with shard
            const ourMempool = await Mempool.getMempool()
            await mergeMempools(ourMempool, this.shard)

            // Step 2: Get TO_APPROVE transactions
            const toApproveTxs = await Mempool.getByClassification(
                TransactionClassification.TO_APPROVE,
            )

            if (toApproveTxs.length === 0) {
                log.debug([ContinuousForge] Round ${round}: no TO_APPROVE txs)
                return
            }







🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/forge/continuousForge.ts around lines 147 - 167,
Reset the per-round delta cache at the start of runForgeRound so stale hashes
aren't served by getCurrentDeltas for the previous round: in the runForgeRound
method (function name: runForgeRound) assign/clear the currentRoundDeltas
storage (symbol: currentRoundDeltas) immediately after advancing
this.state.currentRound / before any early returns so every round begins with an
empty collection; ensure the same field is used by getCurrentDeltas so it
returns only deltas produced during the current round.








--- comment 12/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794127
Body:
_⚠️ Potential issue_ | _🔴 Critical_

Align the wait to the global block boundary, not routine start.

Sleeping for blockIntervalMs here makes each node compile relative to when its local Petri routine happened to start. Nodes that enter the loop a few seconds apart will still quantize to the same logical boundary in compileBlock(), but the later starter gets extra time to receive older mempool transactions, so candidate sets can diverge.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/index.ts around lines 82 - 83, The loop currently
awaits a fixed blockIntervalMs which aligns to routine start rather than the
global block boundary; replace await sleep(blockIntervalMs) with logic that
computes the time until the next global boundary (e.g., const now = Date.now();
const remainder = blockIntervalMs - (now % blockIntervalMs); await
sleep(remainder || blockIntervalMs)) so each iteration aligns to the same global
boundary used by compileBlock(), ensuring candidate sets are built from the same
temporal window; make sure the computed remainder is non-negative and handles
the zero case.








--- comment 13/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794132
Body:
_⚠️ Potential issue_ | _🔴 Critical_

Drain the active forge round before arbitration begins.

pause() only prevents future rounds from starting. If a timer callback has already entered runForgeRound(), this path arbitrates and compiles while that round can still call mergeMempools() and Mempool.updateClassification(), which makes the block-boundary snapshot nondeterministic.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/index.ts around lines 85 - 91, After calling
forge.pause() you must wait for any already-started runForgeRound() to finish
before running arbitrate() so mergeMempools() and Mempool.updateClassification()
cannot run concurrently; modify the code after forge.pause() to drain the active
forge round (e.g. await a promise representing the current round or call a
provided drain/stop-and-wait method on the forge instance) and only then proceed
to call arbitrate(shard) and the compilation steps, ensuring no in-progress
runForgeRound() can still call mergeMempools() or
Mempool.updateClassification().








--- comment 14/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794137
Body:
_⚠️ Potential issue_ | _🔴 Critical_


🧩 Analysis chain

🏁 Script executed:

shell
!/bin/bash
set -euo pipefail

echo "== Petri config references and possible validation points =="
rg -nP --type=ts -C3 'petriConfig|agreementThreshold|shardSize|forgeIntervalMs|blockIntervalMs|problematicTTLRounds'

echo
echo "== Loader/default files if present =="
fd 'defaults.ts|loader.ts|index.ts' src/config -t f


Repository: kynesyslabs/node

Length of output: 48004

---

🏁 Script executed:

shell
cat -n src/config/loader.ts | head -100


Repository: kynesyslabs/node

Length of output: 4637

---

🏁 Script executed:

shell
Check for validation functions or guards after config loading
rg -nP 'envInt|validate|guard|invariant' src/config/loader.ts -A2


Repository: kynesyslabs/node

Length of output: 5456

---

🏁 Script executed:

shell
Look for validation in the config module itself
fd -t f . src/config | head -20


Repository: kynesyslabs/node

Length of output: 165

---





Add validation to enforce consensus invariants when loading Petri config overrides.

The defaults are sound, but src/config/loader.ts (lines 215–220) loads Petri config fields directly via envInt() with no guards. Invalid overrides—agreementThreshold > shardSize, zero or negative intervals—will silently propagate to consensus logic and break liveness. Add post-load checks (or gate envInt() calls) to ensure agreementThreshold > 0, agreementThreshold <= shardSize, and all interval/TTL values are positive.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/types/petriConfig.ts around lines 16 - 23, The
Petri config loader currently allows invalid overrides to slip through (e.g.
agreementThreshold > shardSize or non-positive intervals); after loading into
the PetriConfig (defaults in DEFAULT_PETRI_CONFIG and runtime values produced by
envInt() in the loader that populates PetriConfig), add validation to assert
agreementThreshold > 0, agreementThreshold <= shardSize, and that
forgeIntervalMs, blockIntervalMs, and problematicTTLRounds are > 0; if a check
fails, either clamp to safe defaults from DEFAULT_PETRI_CONFIG or throw a clear
error so invalid env overrides cannot propagate into the consensus code paths
that consume PetriConfig.








--- comment 15/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794141
Body:
_⚠️ Potential issue_ | _🟠 Major_

Use a Petri-config-driven wait window here.

This loop hard-codes a 5s ceiling. If PETRI_FORGE_INTERVAL_MS or PETRI_BLOCK_INTERVAL_MS are configured above that, or the compiler is briefly behind, ensureCandidateBlockFormed() can return false for a still-valid round and make validators reject/stall consensus unnecessarily.


Suggested direction

Base the deadline on the active Petri timings instead of 50 * 100ms, and log an explicit timeout before returning false so callers can distinguish “still forging” from “timed out”.




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/v2/routines/ensureCandidateBlockFormed.ts around lines 12
- 20, The current polling in ensureCandidateBlockFormed uses a hard-coded
50×100ms loop which can prematurely time out; replace that fixed window with a
deadline derived from the active Petri timing config (use
PETRI_FORGE_INTERVAL_MS and/or PETRI_BLOCK_INTERVAL_MS from the Petri config
accessible via getSharedState.petriConsensus) and poll at a reasonable interval,
breaking early if getSharedState.candidateBlock becomes set; additionally log an
explicit timeout message via log (e.g., "[ensureCandidateBlockFormed] Petri wait
timed out after Xms") right before returning false so callers can distinguish
"still forging" from an actual timeout.








--- comment 16/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794145
Body:
_⚠️ Potential issue_ | _🟠 Major_

Potential transaction loss when relay fails.

When relaySuccess is false, the function still returns success: true with message "Transaction accepted locally (relay pending)", but the transaction is never added to the local mempool. If the relay subsequently fails to recover, the transaction is effectively lost.

Consider one of these mitigations:
1. Add the transaction to local mempool as a fallback when relay fails
2. Return success: false when relay fails to signal the client should retry
3. Implement a recovery queue for failed relays




🛡️ Suggested fallback to local mempool on relay failure

diff
         if (getSharedState.petriConsensus) {
             const { success: relaySuccess } = await petriRelay(validatedData)
+            
+            // Fallback: add to local mempool if relay failed
+            if (!relaySuccess) {
+                log.warning("[handleExecuteTransaction] Petri relay failed, adding to local mempool as fallback")
+                await Mempool.addTransaction({
+                    ...queriedTx,
+                    reference_block: validatedData.data.reference_block,
+                })
+            }
+            
             return {
                 success: true,
                 response: {
                     message: relaySuccess
                         ? "Transaction routed to shard members"
-                        : "Transaction accepted locally (relay pending)",
+                        : "Transaction accepted locally (added to mempool)",
                 },




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/network/endpointExecution.ts around lines 318 - 333, The current
petri relay branch calls petriRelay(validatedData) and returns success: true
even when relaySuccess is false, which can drop the transaction; modify the
branch handling of petriRelay to add a fallback: when relaySuccess is false,
push validatedData into the local mempool (use your project's mempool API, e.g.,
addToMempool/mempool.add/enqueueTransaction) and only return success: true after
that fallback succeeds, or alternatively return success: false to force client
retry; ensure you still populate confirmationBlock using
getSharedState.lastBlockNumber + 1 and include routing:"petri" in the response
so callers can distinguish relay vs local fallback.








--- comment 17/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794148
Body:
_⚠️ Potential issue_ | _🟠 Major_

Contain finality lookup failures in this RPC branch.

This new case is missing the local try/catch used by neighboring async handlers. If getTransactionFinality() throws, the dispatcher escapes without a structured 500 response.



Suggested fix

diff
         case "getTransactionFinality": {
             const txHash = payload.params?.[0] as string
             if (!txHash || typeof txHash !== "string") {
                 return {
                     result: 400,
@@
                     extra: null,
                 }
             }
-            const finality = await getTransactionFinality(txHash)
-            return {
-                result: 200,
-                response: finality,
-                require_reply: false,
-                extra: null,
-            }
+            try {
+                const finality = await getTransactionFinality(txHash)
+                return {
+                    result: 200,
+                    response: finality,
+                    require_reply: false,
+                    extra: null,
+                }
+            } catch (error) {
+                log.error([RPC Call] Error in getTransactionFinality: ${error})
+                return {
+                    result: 500,
+                    response: "Failed to resolve transaction finality",
+                    require_reply: false,
+                    extra: null,
+                }
+            }
         }




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/network/rpcDispatch.ts around lines 283 - 301, The
"getTransactionFinality" RPC branch can throw from getTransactionFinality() and
lacks the try/catch pattern used by neighboring handlers; wrap the call to
getTransactionFinality(txHash) in a try/catch inside the case in rpcDispatch.ts
(the "getTransactionFinality" branch), validate payload.params?.[0] as before,
and on error return a structured 500 response (result: 500, response: error
message or generic "Internal server error retrieving transaction finality",
require_reply: false, extra: error or null) so the dispatcher never escapes on
exceptions.








--- comment 18/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794154
Body:
_⚠️ Potential issue_ | _🔴 Critical_

Reset startingConsensus when Petri preflight fails.

startingConsensus is set just above this branch. If getCommonValidatorSeed() or getShard() throws, mainLoopCycle() exits before any Petri cleanup runs, so later iterations will never enter consensus again.



Suggested fix

diff
-        if (getSharedState.petriConsensus) {
-            // REVIEW: Petri Consensus dispatch — get shard and run Petri routine
-            const { commonValidatorSeed } = await getCommonValidatorSeed()
-            const shard = await getShard(commonValidatorSeed)
-            await petriConsensusRoutine(shard)
-        } else {
-            await consensusRoutine()
-        }
+        try {
+            if (getSharedState.petriConsensus) {
+                const { commonValidatorSeed } = await getCommonValidatorSeed()
+                const shard = await getShard(commonValidatorSeed)
+                await petriConsensusRoutine(shard)
+            } else {
+                await consensusRoutine()
+            }
+        } finally {
+            getSharedState.startingConsensus = false
+        }




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/utilities/mainLoop.ts around lines 130 - 137, The code sets
getSharedState.startingConsensus before entering the Petri branch but if
getCommonValidatorSeed() or getShard() throws the function exits and
startingConsensus remains true; wrap the Petri preflight (calls to
getCommonValidatorSeed and getShard and the call to petriConsensusRoutine) in a
try/catch/finally (or ensure a finally-like cleanup) inside mainLoopCycle so
that on any exception you reset getSharedState.startingConsensus = false and
rethrow or handle the error; specifically update the block that references
getSharedState.petriConsensus, getCommonValidatorSeed, getShard, and
petriConsensusRoutine so that startingConsensus is cleared on failure before
exiting the function.








--- comment 19/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794160
Body:
_🛠️ Refactor suggestion_ | _🟠 Major_

Clarify Team Mode source of truth to avoid contradictory behavior

Line 3 says Team Mode is on by default, but Lines 39–43 define marker-based activation (AGENTS.md) as authoritative. This creates ambiguity after fresh starts/compaction and can lead to incorrect mode selection.



Proposed doc fix

diff
-NOTE: By default, operate with /teammode on unless specified otherwise
+NOTE: Team Mode is active only when AGENTS.md contains the TEAM_MODE:START marker (or after explicit /teammode on in-session).




Also applies to: 39-43


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @TEAM.md at line 3, The docs currently conflict about default team mode: the
top note in TEAM.md claims "/teammode" is on by default while AGENTS.md
describes marker-based activation as the authoritative source, causing ambiguity
after restarts/compaction; reconcile this by choosing a single source-of-truth
(preferably explicitly stating that marker-based activation in AGENTS.md
overrides any default flag) and update both TEAM.md and AGENTS.md to state the
precedence and deterministic behavior for the "teammode" flag and marker-based
activation, including concrete language describing what happens on fresh
starts/compaction and which mechanism (marker-based activation vs default
/teammode) wins.








--- comment 20/2 ---
Time: 2026-03-23T12:42:23Z
Type: review_comment
URL: https://github.com/kynesyslabs/node/pull/692#discussion_r2974794165
Body:
_⚠️ Potential issue_ | _🟠 Major_

Require soft finality for a passing run.

The scenario description says it verifies softFinalityAt, but ok does not depend on softFinalityObserved. A regression that never promotes a tx to PRE_APPROVED would still pass this check.



🔧 Proposed fix

diff
     const ok = nonceWait.ok
         && blockAdvance.ok
         && (!txHash || !!txByHash?.ok)
+        && (finalityResult?.softFinalityObserved ?? false)
         && (finalityResult?.hardFinalityObserved ?? false)






📝 Committable suggestion

‼️ IMPORTANT
Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

suggestion
    const ok = nonceWait.ok
        && blockAdvance.ok
        && (!txHash || !!txByHash?.ok)
        && (finalityResult?.softFinalityObserved ?? false)
        && (finalityResult?.hardFinalityObserved ?? false)







🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @testing/loadgen/src/features/consensus/petri_tx_inclusion.ts around lines
178 - 181, The current overall ok boolean (constructed from nonceWait,
blockAdvance, txHash/txByHash, and finalityResult.hardFinalityObserved)
doesn't require soft finality, so add a dependency on
finalityResult?.softFinalityObserved (or explicitly compare against the
expected softFinalityAt) when computing ok so runs that never observe soft
finality fail; update the ok expression that references nonceWait,
blockAdvance, txHash, txByHash, and finalityResult to include
finalityResult?.softFinalityObserved ?? false (or use
finalityResult?.softFinalityObserved === true) so soft finality is required
for a passing run.








--- comment 21/2 ---
Time: 2026-03-23T12:42:26Z
Type: review
URL: https://github.com/kynesyslabs/node/pull/692#pullrequestreview-3991453379
Body:
Actionable comments posted: 19

[!NOTE]
Due to the large number of review comments, Critical, Major severity comments were prioritized as inline comments.


🟡 Minor comments (13)


TEAM.md-24-29 (1)

24-29: _⚠️ Potential issue_ | _🟡 Minor_

Add language identifiers to fenced code blocks

These fenced blocks are missing language tags and are flagged by markdownlint (MD040).



Proposed doc fix

diff
-
+text
 [TEAM MODE: ON]
 Operating as Tech Lead. I'll decompose, delegate, and verify.
 Persisted to AGENTS.md — compaction-safe.
 Standing by for a task or objective.
 

-
+text
 [TEAM MODE: OFF]
 Removed from AGENTS.md. Back to direct execution mode.
 

-
+text
 @junior TASK: [imperative steps]
 FILES: [exact paths]
 PATTERN: [code to mimic]
 CONSTRAINT: [explicit boundaries]
 DONE_WHEN: [observable criteria]
 

-
+text
 @senior OBJECTIVE: [what and why]
 SCOPE: [files/modules in play]
 CONTEXT: [architectural decisions, constraints]
 APPROACH: [suggested direction, not prescriptive]
 ACCEPTANCE: [what done looks like]
 

-
+text
 [PLAN] 3 subtasks: 1 Junior (scaffolding), 1 Senior (implementation), 1 Lead (integration)
 [DISPATCHED] @junior — scaffold endpoint files
 [DISPATCHED] @senior — implement auth middleware
 [VERIFIED] junior output ✓
 [VERIFIED] senior output — requested revision on error handling
 [INTEGRATING] assembling and running tests
 [DONE] feature complete, tests passing
 




Also applies to: 34-37, 74-80, 83-89, 112-120


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @TEAM.md around lines 24 - 29, The fenced code blocks in TEAM.md lack
language identifiers and trigger markdownlint MD040; update each triple-backtick
block (the ones containing the TEAM MODE snippets, the @junior/@senior blocks,
the PLAN/dispatch/verification block and the other ranges noted) to include a
language tag (e.g., change  to text) so every fenced block begins with
text; ensure you update all instances referenced (blocks around the TEAM MODE
ON/OFF snippets, the @junior/@senior templates, and the PLAN block) to make
markdownlint happy.






AGENTS.md-3-3 (1)

3-3: _⚠️ Potential issue_ | _🟡 Minor_

Use a proper file reference for TEAM.md

@TEAM.md is ambiguous in Markdown rendering and may not resolve as a file link. Prefer TEAM.md or [TEAM.md](TEAM.md) for reliable navigation.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @AGENTS.md at line 3, In AGENTS.md replace the ambiguous reference string
"@TEAM.md" with a proper file reference such as "TEAM.md" or a Markdown link
"[TEAM.md](TEAM.md)" so the link renders and resolves correctly; update the
occurrence of the literal "@TEAM.md" in that file to the chosen form to ensure
reliable navigation.






src/libs/consensus/petri/utils/canonicalJson.ts-32-34 (1)

32-34: _⚠️ Potential issue_ | _🟡 Minor_

Set sorting may be non-deterministic for numeric values.

Array.from(value).sort() uses lexicographic string comparison by default. For numeric Sets, this produces [1, 10, 2] instead of [1, 2, 10]. If Sets containing numbers are ever serialized, different insertion orders could yield different canonical strings—breaking the determinism guarantee.



🛡️ Suggested fix for numeric stability

diff
     if (value instanceof Set) {
-        return Array.from(value).sort()
+        return Array.from(value).sort((a, b) => {
+            const strA = String(a)
+            const strB = String(b)
+            return strA.localeCompare(strB)
+        })
     }


Using localeCompare ensures consistent string-based ordering. Alternatively, if numeric ordering is preferred:

typescript
return Array.from(value).sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b
    return String(a).localeCompare(String(b))
})




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/utils/canonicalJson.ts around lines 32 - 34, The
current Set handling in canonicalJson (the branch with "if (value instanceof
Set) return Array.from(value).sort()") uses default lexicographic sort which is
non-deterministic for numeric values; update this to use a comparator that
numerically compares when both elements are numbers (a - b) and otherwise falls
back to string comparison (String(a).localeCompare(String(b))) so Sets of mixed
types serialize deterministically.






src/libs/omniprotocol/protocol/handlers/consensus.ts-2-4 (1)

2-4: _⚠️ Potential issue_ | _🟡 Minor_

Swap the 0x36/0x37 labels in the deprecation header.

The handlers below still document getValidatorPhase as 0x36 and greenlight as 0x37, so the new header is reversed.



Suggested fix

diff
-// @deprecated — Secretary-related handlers (0x35 setValidatorPhase, 0x36 greenlight,
-// 0x37 getValidatorPhase, 0x38 getBlockTimestamp) replaced by Petri Consensus.
+// @deprecated — Secretary-related handlers (0x35 setValidatorPhase, 0x36 getValidatorPhase,
+// 0x37 greenlight, 0x38 getBlockTimestamp) replaced by Petri Consensus.




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/omniprotocol/protocol/handlers/consensus.ts around lines 2 - 4, The
deprecation header comment labels for the Secretary-related handlers are
reversed; update the header so 0x36 is labeled "greenlight" and 0x37 is labeled
"getValidatorPhase" to match the actual handler documentation below (referencing
the getValidatorPhase and greenlight handler names in this file). Edit the
header comment at the top of consensus.ts to swap the 0x36 and 0x37 labels
accordingly so they align with the implemented handlers.






petri/02-risks-and-considerations.md-142-142 (1)

142-142: _⚠️ Potential issue_ | _🟡 Minor_

Fix sentence fragment in the rationale.

Line [142] reads as a fragment; add a subject for clarity.




📝 Suggested wording

diff
-| 1 | Forge interval | 2 seconds | Conservative start. Gives ample time for delta exchange even on high-latency networks. Can be optimized to 1s later once benchmarked. |
+| 1 | Forge interval | 2 seconds | Conservative start. Gives ample time for delta exchange even on high-latency networks. It can be optimized to 1s later once benchmarked. |




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/02-risks-and-considerations.md at line 142, The rationale for the
"Forge interval" row is a sentence fragment; edit the table cell for "Forge
interval" (the row with subject "Forge interval" and value "2 seconds") to add a
clear subject to the rationale—e.g., change "Can be optimized to 1s later once
benchmarked." to "We can optimize this to 1s later once benchmarked."—so the
rationale reads as a complete sentence.






petri/02-risks-and-considerations.md-79-79 (1)

79-79: _⚠️ Potential issue_ | _🟡 Minor_

The L2PSMempool “no change needed” claim is now outdated.

Line [79] conflicts with this PR’s actual changes in src/libs/blockchain/l2ps_mempool.ts. Please soften to reflect that core execution logic is unchanged, but integration/timing/block-ref plumbing did change.




📝 Suggested wording

diff
-No change needed to L2PSMempool, L2PSTransactionExecutor, or L2PSConsensus core logic. Only the timing of applyPendingProofs() changes slightly.
+No core execution-model change needed to L2PSTransactionExecutor or L2PSConsensus. L2PSMempool integration paths were adjusted for Petri-aware block reference handling.




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/02-risks-and-considerations.md at line 79, Update the doc line
claiming "No change needed" for L2PSMempool to reflect that while core execution
logic in L2PSMempool, L2PSTransactionExecutor, and L2PSConsensus remains
unchanged, integration/timing and block-reference plumbing did change (notably
the timing of applyPendingProofs() in L2PSMempool). Replace the absolute "No
change needed" phrasing with a softened statement specifying that core logic is
unchanged but integration/timing/block-ref plumbing (see
L2PSMempool.applyPendingProofs()) was modified to accommodate this PR.






petri/petri.md-1-2 (1)

1-2: _⚠️ Potential issue_ | _🟡 Minor_

Remove leftover conversion artifact.

Line 1 appears to be a remnant from converting this document from another format. It should be removed as it's not part of the specification content.


🧹 Proposed fix

diff
-I'll convert this pitch deck into a clean text-only document for you.
-
 ---




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/petri.md around lines 1 - 2, Remove the stray conversion artifact
"I'll convert this pitch deck into a clean text-only document for you." from the
top of petri.md; delete that lone line so the document starts with the actual
specification content and contains no leftover conversion notes.






petri/petri.md-89-95 (1)

89-95: _⚠️ Potential issue_ | _🟡 Minor_

Add language identifier to fenced code block.

The ASCII diagram should have a language identifier for proper rendering and to satisfy markdown linting (MD040).


🧹 Proposed fix

diff
-
+text
 CLIENT → RPC → SHARD (Verify) → MEMPOOL SYNC → [STATE DELTA]




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/petri.md around lines 89 - 95, The fenced ASCII diagram in petri.md is
missing a language identifier which triggers MD040; update the opening fence for
the block containing "CLIENT → RPC → SHARD (Verify) → MEMPOOL SYNC → [STATE
DELTA]" to include a language label (e.g., use text) so the diagram renders
correctly and satisfies the markdown linter; ensure the closing fence remains
 and do not alter the diagram content itself.






src/libs/consensus/petri/classifier/transactionClassifier.ts-11-12 (1)

11-12: _⚠️ Potential issue_ | _🟡 Minor_

GCRGeneration is an undocumented export from the SDK.

The @kynesyslabs/demosdk/websdk subpath is correctly configured and exported. However, GCRGeneration does not appear in the SDK's public API documentation and is likely an internal or undocumented export. Verify with the SDK maintainers that this API is stable and intended for external use, or consider using an alternative documented export if available.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/classifier/transactionClassifier.ts around lines 11
- 12, The import of GCRGeneration from "@kynesyslabs/demosdk/websdk" in
transactionClassifier.ts references an undocumented SDK export; confirm with the
SDK maintainers whether GCRGeneration is a stable public API or replace its
usage with a documented alternative (or a supported factory/function) from the
SDK, and if unavailable remove the GCRGeneration import and refactor any code in
transactionClassifier.ts that calls GCRGeneration to use the supported API (or
add feature-flag/guarding and a TODO noting maintainer confirmation) so the file
no longer depends on an undocumented symbol.






petri/00-codebase-mapping.md-99-99 (1)

99-99: _⚠️ Potential issue_ | _🟡 Minor_

Table formatting issue — pipe characters in inline code break column structure.

The | characters inside the backtick code block are interpreted as table column separators, causing the table to render incorrectly.



🔧 Proposed fix — escape or restructure

diff
-| Classification result type | NEW | { status: 'PRE-APPROVED' | 'TO-APPROVE' | 'PROBLEMATIC', delta?: StateDelta } |
+| Classification result type | NEW | { status: 'PRE-APPROVED' \| 'TO-APPROVE' \| 'PROBLEMATIC', delta?: StateDelta } |


Or move the type definition outside the table:

diff
-| Classification result type | NEW | { status: 'PRE-APPROVED' | 'TO-APPROVE' | 'PROBLEMATIC', delta?: StateDelta } |
+| Classification result type | NEW | See type definition below |
+
+typescript
+{ status: 'PRE-APPROVED' | 'TO-APPROVE' | 'PROBLEMATIC', delta?: StateDelta }
+




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/00-codebase-mapping.md at line 99, The table cell containing the type
for "Classification result type" breaks the Markdown table because the inline
code contains pipe characters; fix it by either escaping the pipes (replace '|'
with '\|' inside the backticks) or move the entire type definition out of the
table into a fenced code block beneath the table (use the type { status:
'PRE-APPROVED' | 'TO-APPROVE' | 'PROBLEMATIC', delta?: StateDelta } and
reference it in the table cell), updating the table row for the "Classification
result type" header to point to the external/fenced code instead of embedding
pipes inline.






src/libs/consensus/petri/finality/transactionFinality.ts-54-54 (1)

54-54: _⚠️ Potential issue_ | _🟡 Minor_

Consider returning null instead of 0 when timestamp is missing.

Using 0 for a missing timestamp can be misleading since 0 represents a valid epoch timestamp (1970-01-01). Returning null would be more accurate for "timestamp not available".



🔧 Proposed fix

diff
-            result.hardFinalityAt = Number(confirmedTx.content?.timestamp ?? 0)
+            result.hardFinalityAt = confirmedTx.content?.timestamp 
+                ? Number(confirmedTx.content.timestamp) 
+                : null




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/finality/transactionFinality.ts at line 54, The
assignment to result.hardFinalityAt currently coerces a missing
confirmedTx.content?.timestamp to 0; change this so that when timestamp is
absent you assign null instead (i.e., set result.hardFinalityAt =
confirmedTx.content?.timestamp ?? null) and update the type/signature of
result.hardFinalityAt (and any related interfaces or return types in
transactionFinality.ts) from number to number | null so callers using
result.hardFinalityAt handle the null case appropriately.






testing/loadgen/src/features/consensus/petri_relay_flow.ts-137-144 (1)

137-144: _⚠️ Potential issue_ | _🟡 Minor_

Remove unnecessary as any casts for confirm() and broadcast() methods.

The SDK properly types these methods—other files in the codebase (e.g., transfer_loadgen.ts) call them directly without casts. The as any casts only serve to suppress type checking and should be removed:

typescript
const validity = await demos.confirm(signedTx)
const broadcast = await demos.broadcast(validity)



🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @testing/loadgen/src/features/consensus/petri_relay_flow.ts around lines 137
- 144, The code is using unnecessary "as any" casts when calling demos.confirm
and demos.broadcast in petri_relay_flow; remove the casts so the calls use the
SDK types directly (replace "(demos as any).confirm" with "demos.confirm" and
"(demos as any).broadcast" with "demos.broadcast"), keeping the existing await,
validity/result checks and error messages intact so TypeScript properly
type-checks confirm and broadcast.






src/libs/consensus/petri/forge/deltaAgreementTracker.ts-103-110 (1)

103-110: _⚠️ Potential issue_ | _🟡 Minor_

Edge case: Math.max(...hashCounts.values()) can return -Infinity for empty maps.

If hashCounts is empty (theoretically possible if a state exists but memberHashes is empty), Math.max() with no arguments returns -Infinity, producing a confusing log message.


🛡️ Suggested defensive fix

diff
             log.warn(
                 [DeltaTracker] TX ${txHash} FLAGGED: no agreement after ${state.roundsTracked} rounds  +
-                (best: ${Math.max(...hashCounts.values())}/${this.threshold} needed),
+                (best: ${hashCounts.size > 0 ? Math.max(...hashCounts.values()) : 0}/${this.threshold} needed),
             )




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/forge/deltaAgreementTracker.ts around lines 103 -
110, When checking TTL expiry in deltaAgreementTracker (variables:
state.roundsTracked, this.ttlRounds), defensively handle empty hashCounts so
Math.max(...hashCounts.values()) doesn't yield -Infinity; compute a safe
maxCount from hashCounts (e.g., default to 0 when hashCounts is empty or use
Math.max(0, ...values)) and use that maxCount in the log message instead of
calling Math.max directly on possibly-empty hashCounts.values(); keep the rest
of the logic (flagged.push(txHash)) unchanged.









🧹 Nitpick comments (27)


.gitignore (1)

293-293: Remove duplicate ignore entry for /testing/runs.

This pattern already exists at Line 289, so this addition is redundant.




Suggested cleanup

diff
-/testing/runs




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @.gitignore at line 293, Remove the duplicate ignore entry "/testing/runs"
from .gitignore (it already appears earlier in the file); locate the redundant
line containing the pattern "/testing/runs" and delete it so the file contains
only the single existing ignore entry.






src/libs/consensus/petri/execution/speculativeExecutor.ts (1)

78-82: Consider logging or validating unknown edit types.

The default case silently passes through for unrecognized edit types (storage, tls, etc.), which is documented. However, if a malformed or typo'd edit type arrives (e.g., "balancee"), it will succeed with "passthrough" rather than being caught.

Adding a debug log or maintaining an explicit allowlist would help surface unexpected edit types during development.



♻️ Suggested improvement

diff
             default:
-                // For other GCR edit types (storage, tls, etc.), we still produce a delta
-                // but skip simulation — the edit presence itself is the state change signal
+                // Known passthrough types: storage, tls, etc.
+                log.debug(
+                    [PetriSpecExec] Passthrough for edit type=${edit.type} on TX ${tx.hash},
+                )
                 result = { success: true, message: "passthrough" }
                 break




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/execution/speculativeExecutor.ts around lines 78 -
82, The default branch in speculativeExecutor.ts currently returns a silent
passthrough ({ success: true, message: "passthrough" }) for any unrecognized GCR
edit type; change this to validate the edit type against an explicit allowlist
of supported GCR edit types (e.g., storage, tls, etc.) and, if the incoming edit
type is not in the allowlist, emit a debug/warn log (using the module's logger)
and return a failure or a clearly flagged result instead of silently succeeding;
update the code around the switch/default handling in the speculative execution
function (the block assigning result = { success: true, message: "passthrough"
}) to perform the allowlist check and logging so malformed or typo'd edit types
are surfaced during development.






src/libs/consensus/petri/utils/canonicalJson.ts (1)

16-18: Consider handling circular references.

JSON.stringify throws on circular structures. If any state delta inadvertently contains a cycle, the entire consensus path will crash. Depending on trust in upstream data, you may want to catch this or use a cycle-safe serializer.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/utils/canonicalJson.ts around lines 16 - 18, The
canonicalJson function currently calls JSON.stringify(value, replacer, 0) which
will throw on circular structures; update canonicalJson to handle cycles by
using a cycle-safe serialization strategy (e.g., track seen objects with a
WeakSet inside the replacer or wrap the JSON.stringify call in try/catch and
fall back to a safe serializer) so circular references don't crash the consensus
path; reference the canonicalJson function and the replacer to add the WeakSet
tracking (or a fallback serializer) and ensure the output remains deterministic
for the same structural content.






src/libs/consensus/v2/routines/orderTransactions.ts (1)

31-33: Remove identity map—this is a no-op.

.map(transaction => transaction) returns the same array elements unchanged. This appears to be dead code, possibly a remnant from a previous implementation that performed transformation or stringification.



♻️ Suggested simplification

diff
-    // Stringify the transactions
-    const orderedTransactions = orderedTransactionsObjects.map(
-        transaction => transaction,
-    )
-    return orderedTransactions
+    return orderedTransactionsObjects




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/v2/routines/orderTransactions.ts around lines 31 - 33,
The map call that creates orderedTransactions is a no-op—replace the identity
mapping of orderedTransactionsObjects with either a direct reference to
orderedTransactionsObjects or, if an independent copy is required, use a shallow
copy (e.g., spread) instead; update the code where orderedTransactions is used
so it consumes orderedTransactionsObjects (or the shallow copy) and remove the
redundant .map(transaction => transaction) to simplify the logic.






src/features/metrics/MetricsCollector.ts (1)

739-742: Improve readability of petriEnabled check.

The variable petriEnabled is assigned 1 or 0 for the gauge, then used in a boolean check (!petriEnabled). While this works due to JavaScript's truthiness rules, it's clearer to use an explicit boolean check.




♻️ Clearer boolean handling

diff
-            const petriEnabled = getSharedState.petriConsensus ? 1 : 0
-            this.metricsService.setGauge("petri_enabled", petriEnabled)
-
-            if (!petriEnabled) return
+            const isPetriEnabled = !!getSharedState.petriConsensus
+            this.metricsService.setGauge("petri_enabled", isPetriEnabled ? 1 : 0)
+
+            if (!isPetriEnabled) return




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/features/metrics/MetricsCollector.ts around lines 739 - 742, The current
code mixes a numeric flag and boolean check for petriEnabled; change it to an
explicit boolean then derive the gauge value from it: create a boolean (e.g.,
petriEnabled = !!getSharedState.petriConsensus) and pass petriEnabled ? 1 : 0 to
this.metricsService.setGauge("petri_enabled", ...), then continue using the
boolean in the if (!petriEnabled) return check so the intent is clear; update
references around petriEnabled in MetricsCollector to match.






src/model/entities/Mempool.ts (1)

49-51: Consider using bigint type for soft_finality_at property.

The column is defined as "bigint" in the database, but the TypeScript type is number | null. If soft_finality_at stores Unix timestamps in milliseconds or other large values, JavaScript number loses precision beyond Number.MAX_SAFE_INTEGER (9,007,199,254,740,991). Consider using TypeScript's bigint type for type safety.




♻️ Proposed type alignment

diff
     // REVIEW: Petri Consensus soft finality timestamp (Phase 5)
     @Column("bigint", { name: "soft_finality_at", nullable: true })
-    soft_finality_at: number | null
+    soft_finality_at: bigint | null




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/model/entities/Mempool.ts around lines 49 - 51, The Mempool entity
defines the DB column as "bigint" but types the property as number | null;
change the TypeScript type to bigint | null for soft_finality_at and add a value
transformer on the @Column to serialize/deserialize between DB string and JS
BigInt (or store as string if your ORM expects it) so reads return BigInt and
writes convert BigInt to the DB format; update the property declaration
soft_finality_at and the @Column(...) decorator in src/model/entities/Mempool.ts
accordingly to ensure safe handling of large integer timestamps.






testing/scripts/run-suite.ts (1)

272-279: Consider adding petri suite to resolveLocalTargets for --local mode.

The resolveLocalTargets function handles special cases for several suites (startup-cold-boot, gcr-routine, cluster-health, etc.) but doesn't include petri. If the Petri suite requires specific target handling in local mode, add it here.




🔧 Potential addition if needed

diff
 async function resolveLocalTargets(suite: string, explicitTargets: string | null): Promise {
   if (explicitTargets) return explicitTargets
   if (suite === "startup-cold-boot") return defaultLocalTargets
   if (suite === "gcr-routine") return defaultLocalTargets
+  if (suite === "petri") return defaultLocalTargets
   if (suite === "cluster-health" || suite === "gcr-focus" || suite === "prod-gate") {
     return process.env.TARGETS ?? defaultLocalTargets
   }
   return null
 }




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @testing/scripts/run-suite.ts around lines 272 - 279, The resolveLocalTargets
function omits the "petri" suite, so update resolveLocalTargets to handle petri
in local mode by adding "petri" to the appropriate conditional branch (either
the branch that returns defaultLocalTargets alongside "startup-cold-boot" and
"gcr-routine" or the branch that returns process.env.TARGETS alongside
"cluster-health"/"gcr-focus"/"prod-gate" depending on which behavior petri
needs); locate the resolveLocalTargets function and modify the conditional
checks to include "petri" and ensure defaultLocalTargets and process.env.TARGETS
behavior remains consistent.






better_testing/petri/speculativeExecutor.test.ts (1)

11-32: Avoid duplicating hashing logic inside the test helper.

Keeping a local replica of the production algorithm can give false confidence when logic changes. Prefer extracting a shared computeDeltaHash utility from runtime code and importing it here.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/speculativeExecutor.test.ts around lines 11 - 32, The
test helper duplicates the production hashing logic (computeDeltaHash) which
risks divergence; instead extract the canonical hashing routine from the
runtime/speculativeExecutor module into a shared utility and import it in the
test. Update the test to remove the local computeDeltaHash and import the
exported function (e.g., computeDeltaHash or computeDeltaHashForTests) from the
runtime code (where speculativeExecutor performs canonicalJson + Hashing.sha256)
so the test uses the same implementation; ensure the shared utility handles
bigint/string normalization the same way as speculativeExecutor.






src/libs/consensus/petri/forge/forgeInstance.ts (1)

15-23: Avoid exporting mutable singleton state directly.

Expose only getPetriForgeInstance/setPetriForgeInstance and keep the backing variable module-private to prevent accidental external mutation.




🔧 Suggested refactor

diff
-export let petriForgeInstance: ContinuousForge | null = null
+let petriForgeInstance: ContinuousForge | null = null




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/forge/forgeInstance.ts around lines 15 - 23, The
exported mutable singleton petriForgeInstance should be module-private: remove
the export from the petriForgeInstance binding and keep only
setPetriForgeInstance and getPetriForgeInstance exported so external code can
only access it via the setter/getter; update the declaration of
petriForgeInstance (type ContinuousForge | null) to be non-exported while
leaving exported functions setPetriForgeInstance and getPetriForgeInstance
unchanged so callers use those accessors rather than mutating the variable
directly.






better_testing/petri/happyPath.test.ts (1)

18-29: Minor: Mock peer structure has unusual property name.

Line 22 uses connection: { string: ... } which appears to be a typo or placeholder. While harmless in tests, consider using a more realistic property name for clarity:

diff
-        connection: { string: localhost:${3000 + i} },
+        connectionString: localhost:${3000 + i},



🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/happyPath.test.ts around lines 18 - 29, The mockPeers
helper creates peer objects in mockPeers with an unrealistic property
connection.string; change that to a clearer property name (e.g.,
connection.address or connection.url) inside the mockPeers function so the peer
shape reads connection: { address: localhost:${3000 + i} }, and update any
tests that consume connection.string to use the new property (references:
mockPeers function and any assertions using connection.string).






src/libs/consensus/v2/routines/broadcastBlockHash.ts (1)

93-102: Clarify return value semantics.

The return value [signatureCount, shard.length - signatureCount] may not accurately represent pro/con votes:
- signatureCount includes all signatures in block.validation_data.signatures, potentially including pre-existing ones before this broadcast
- The second value assumes each shard member maps to exactly one signature, but signatures are keyed by identity (public key), not peer

The pro counter (line 79) tracks RPC successes, but isn't used in the return. If the caller expects [pro, con], consider:


🔧 Suggested clarification

diff
-    return [signatureCount, shard.length - signatureCount]
+    // Return actual signature count for BFT threshold validation
+    // Note: signatureCount may exceed shard.length if signatures accumulate across rounds
+    return [signatureCount, Math.max(0, shard.length - signatureCount)]




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/v2/routines/broadcastBlockHash.ts around lines 93 - 102,
The return currently uses signatureCount and shard.length - signatureCount which
misrepresents pro/con; update broadcastBlockHash to return accurate pro and con:
use the existing pro counter for the first element and compute con as
shard.length - pro; alternatively, if you must derive pro from signatures, map
block.validation_data.signatures keys (identities) to shard peers to count
unique shard signers and set pro to that count and con to shard.length - pro;
ensure you reference the pro variable, shard array, and
block.validation_data.signatures when making the change.






better_testing/petri/blockCompiler.test.ts (1)

173-195: Tests are trivial — consider removing or documenting intent.

These tests verify JavaScript ternary operator behavior rather than actual consensus dispatch logic. If the intent is to document expected behavior for future integration tests, consider adding a comment explaining this is a placeholder. Otherwise, these provide little value.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/blockCompiler.test.ts around lines 173 - 195, These
tests in the "Consensus dispatch switching" describe block (tests
"petriConsensus flag gates dispatch" and "dispatch function selection is
deterministic") only assert basic ternary behavior rather than exercising the
actual dispatch logic; either delete these trivial tests or replace them with
meaningful checks that import and invoke the real dispatch/select function from
mainLoop.ts (or add a clear comment that they are placeholders documenting
expected behavior until integration tests exist). Specifically, remove or update
the tests named "petriConsensus flag gates dispatch" and "dispatch function
selection is deterministic" in blockCompiler.test.ts, and if keeping them as
placeholders add a comment referencing the real selector (e.g., the
dispatch/chooseConsensus function in mainLoop.ts) and why the tests are present.






petri/consensus.md (1)

212-222: Consider moving soak test results to a separate file or CI artifact.

Embedding specific test results (dated 2026-03-22) in documentation may become stale. Consider referencing CI artifacts or a separate test results file that can be updated independently.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/consensus.md around lines 212 - 222, The "Soak Test Results
(2026-03-22)" section in petri/consensus.md (the heading and the results table)
should be removed from the static docs and instead referenced from a separate,
updatable artifact; extract the table and heading into a new file (e.g., a
soak-results markdown or CI artifact) and replace the block under the heading
"Soak Test Results (2026-03-22)" with a short pointer like "See latest soak test
results: [link to artifact]" or a CI badge; update any references in
petri/consensus.md that mention the soak results to point to the new file/CI
artifact and ensure the unique heading "Soak Test Results (2026-03-22)" and the
table rows (Devnet size, TXs submitted, Blocks produced, Block rate, Hard
finality observed, PoRBFT activity, Test verdict) are moved to the new artifact
so they can be updated independently.






better_testing/petri/benchmark.test.ts (2)

206-236: These tests assert design constants, not actual measurements.

The "finality latency design targets" tests verify arithmetic on hardcoded values rather than measuring actual latency. This documents design expectations but doesn't validate runtime behavior. Consider renaming to "Finality Design Constants" to clarify intent.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/benchmark.test.ts around lines 206 - 236, The tests
under describe("Benchmark — Finality Latency Design Targets") are asserting
hardcoded design constants rather than measuring runtime behavior; rename the
suite and/or individual tests to make intent explicit (e.g., describe("Finality
Design Constants") and test names like "soft finality design constant", "hard
finality design constant", "finality gap design constant") so readers know these
are static expectations, not live measurements; update the strings in the
describe and the three test(...) calls to the new names (referencing the
existing describe and the three test blocks) and keep the assertions unchanged.




---

268-286: Use dynamic import() instead of require() for consistency.

The test uses CommonJS require() while the rest of the file uses ESM imports. For consistency and better TypeScript support, use dynamic import():



♻️ Proposed fix

diff
 test("forge getCurrentDeltas returns copy (no reference leak)", async () => {
     const config = {
         forgeIntervalMs: 60000,
         blockIntervalMs: 10000,
         agreementThreshold: 7,
         problematicTTLRounds: 5,
     }
-    const forge = new (require("@/libs/consensus/petri/forge/continuousForge").ContinuousForge)(config)
+    const { ContinuousForge } = await import("@/libs/consensus/petri/forge/continuousForge")
+    const forge = new ContinuousForge(config)
     forge.start(mockPeers(3))




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/benchmark.test.ts around lines 268 - 286, Replace the
CommonJS require in the test with a dynamic ESM import: make the test async,
await import("@/libs/consensus/petri/forge/continuousForge"), pull
ContinuousForge from the imported module, then instantiate it (new
ContinuousForge(config)), call forge.start(...), call getCurrentDeltas twice and
assert as before, and finally call forge.stop(); ensure the test function
signature is updated to async so the dynamic import can be awaited and teardown
still runs.






petri/VADEMECUM.md (2)

32-34: Add language specifier to fenced code block.

The code block at line 32 is missing a language specifier. Since this shows a directory path, use an empty specifier or text:



📝 Proposed fix

diff
-
+text
 better_testing/petri/
 




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/VADEMECUM.md around lines 32 - 34, The fenced code block containing
the directory path better_testing/petri/ lacks a language specifier; update the
opening fence from  to include a neutral language such as text (e.g.,
text) so the snippet is properly marked as plain text and renders
consistently in the VADEMECUM.md markdown.




---

149-197: Add language specifiers to file path code blocks.

Multiple code blocks showing file paths are missing language specifiers (lines 149, 167, 179, 189). Add text to silence linter warnings and improve rendering consistency.



📝 Proposed fix for all path blocks

diff
-
+text
 src/libs/consensus/petri/
   index.ts                          # petriConsensusRoutine()


Apply the same change to code blocks at lines 167, 179, and 189.



🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/VADEMECUM.md around lines 149 - 197, The fenced code blocks that list
repository files (the blocks containing entries like index.ts, types/*.ts,
canonicalJson.ts, petriSecretary.ts and the other filenames shown) are missing a
language specifier; update each such triple-backtick block to use text so the
path listings render consistently and linter warnings are silenced, ensuring you
change all similar blocks in the document that show file/path listings.






better_testing/petri/routing.test.ts (1)

151-162: Flag gating tests are trivial and don't verify actual module behavior.

These tests only verify JavaScript ternary operator behavior, not the actual feature flag routing implementation. Consider importing and testing the actual routing logic from the implementation modules.



💡 Example of testing actual module behavior

typescript
// Instead of testing local ternary logic:
// const path = petriConsensus ? "petri" : "dtr"

// Consider importing and testing the actual routing function:
// import { getRoutingPath } from "@/libs/consensus/petri/routing/..."
// expect(getRoutingPath({ petriConsensus: true })).toBe("petri")




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/routing.test.ts around lines 151 - 162, Replace the
trivial ternary check with tests that call the real routing logic: import the
routing function (e.g., getRoutingPath or whichever function implements
flag-based routing in the consensus/petri routing module) and assert its return
for both { petriConsensus: true } and { petriConsensus: false } scenarios; if
the routing logic reads flags from a config or feature-flag service, either
inject a test config/mock or call the function with a param object to control
the flag, and update the test block in routing.test.ts to use those imports and
assertions instead of the local const path = petriConsensus ? "petri" : "dtr".






better_testing/petri/byzantineFault.test.ts (1)

24-48: Remove redundant type annotations from default parameter values.

ESLint correctly identifies that the type annotations on ttlRounds and currentRound are redundant since TypeScript can infer them from the default values.



🔧 Proposed fix

diff
 function simulateRound(
     shardSize: number,
     byzantineCount: number,
     txHash: string,
     correctDelta: string,
-    ttlRounds: number = 5,
-    currentRound: number = 1,
+    ttlRounds = 5,
+    currentRound = 1,
 ): { promoted: string[]; flagged: string[] } {




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/byzantineFault.test.ts around lines 24 - 48, The
function simulateRound has redundant TypeScript type annotations on parameters
with default values (ttlRounds: number = 5, currentRound: number = 1); remove
the explicit ": number" annotations so the defaults alone provide the inferred
types. Update the simulateRound signature to use ttlRounds = 5 and currentRound
= 1 (leave other params and body unchanged) so linting passes while preserving
behavior in the DeltaAgreementTracker/recordDelta/evaluate workflow.






better_testing/petri/finality.test.ts (1)

112-125: Test does not actually verify idempotency behavior.

The test claims to verify that "soft finality is only set once" but it only assigns the value once and then checks it wasn't changed. To test idempotency, you would need to simulate multiple promotion attempts or call the actual updateClassification function.



💡 Suggested improvement

typescript
test("soft finality is only set once (first PRE_APPROVED)", () => {
    const firstTime = 1700000000000
    const laterTime = 1700000002000

    // Simulate updateClassification behavior: only set if null
    let softFinalityAt: number | null = null
    
    // First promotion sets the timestamp
    if (softFinalityAt === null) {
        softFinalityAt = firstTime
    }
    
    // Second promotion attempt should NOT overwrite
    if (softFinalityAt === null) {
        softFinalityAt = laterTime
    }
    
    expect(softFinalityAt).toBe(firstTime)
})




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/finality.test.ts around lines 112 - 125, The test "soft
finality is only set once (first PRE_APPROVED)" is not exercising idempotent
behavior; replace the manual single assignment with a simulation of multiple
promotion attempts (or call into updateClassification if available) so the first
assignment sets softFinalityAt and subsequent attempts do not overwrite it;
specifically, in the test body use the softFinalityAt variable and perform two
promotion steps (e.g., conditional assignments that only set softFinalityAt when
it is null) or invoke the updateClassification path that implements that logic,
then assert softFinalityAt equals firstTime and not laterTime.






testing/loadgen/src/features/consensus/petri_relay_flow.ts (1)

186-193: Consider making finality propagation delay configurable.

The hardcoded 2000ms sleep may not be appropriate for all environments. Consider using an environment variable consistent with other timing configurations in this file.



🔧 Proposed fix

diff
     // Check finality consistency across all nodes
     const finalityChecks: NodeFinalityCheck[] = []
     if (txHash) {
         // Give finality a moment to propagate
-        await sleep(2000)
+        const finalityPropagationMs = envInt("CONSENSUS_FINALITY_PROPAGATION_MS", 2000)
+        await sleep(finalityPropagationMs)
         for (const url of rpcUrls) {
             finalityChecks.push(await checkFinalityOnNode(url, txHash))
         }
     }




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @testing/loadgen/src/features/consensus/petri_relay_flow.ts around lines 186
- 193, The hardcoded 2000ms delay before checking finality should be
configurable; replace the literal sleep(2000) used in the finality propagation
block (where txHash is present and you call checkFinalityOnNode for each
rpcUrls) with a configurable value read from an environment variable (e.g.,
FINALITY_PROPAGATION_MS) with a sensible default fallback (2000). Update the
code around the finalityChecks array and the await sleep(...) call to parse the
env var to a number and use that value so different environments can adjust the
delay without changing code.






better_testing/petri/liveness.test.ts (1)

214-227: Add explicit type annotation to avoid never[] inference.

The mempool array is initialized empty and then elements are pushed to it. Without a type annotation, TypeScript may infer never[] which can cause type issues.



🔧 Proposed fix

diff
 test("high volume: many PRE_APPROVED with some PROBLEMATIC", () => {
-    const mempool = []
+    const mempool: Array = []
     for (let i = 0; i < 50; i++) {




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/liveness.test.ts around lines 214 - 227, The mempool
variable is declared as an empty array which can infer never[]; update the
declaration in the "high volume: many PRE_APPROVED with some PROBLEMATIC" test
by giving mempool an explicit type such as { hash: string; classification:
TransactionClassification }[] (or Array<{ hash: string; classification:
TransactionClassification }>), then keep pushing the same objects so TypeScript
correctly types mempool and TransactionClassification usages.






better_testing/petri/featureFlagRollback.test.ts (1)

34-62: Dispatch logic tests are trivial — same pattern as routing tests.

These tests only verify JavaScript ternary operator behavior rather than the actual feature flag dispatch implementation. The value would be in testing the actual routing code path.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @better_testing/petri/featureFlagRollback.test.ts around lines 34 - 62, The
tests under the "Feature Flag — Dispatch Logic" describe block are only
verifying a ternary expression; replace them to call the real dispatch/routing
function (e.g., import and call your consensus dispatcher such as
chooseConsensusPath or dispatchConsensus) instead of in-test ternaries; update
each test (the "flag ON → petri path selected", "flag OFF → porbft path
selected", "flag toggle: ON → OFF → ON produces correct sequence", and "rapid
flag changes always resolve to current value") to set the feature flag, invoke
the actual dispatch function, and assert that the correct handler/path was
returned or the correct handler was invoked (use spies/mocks for the petri and
porbft handlers and verify calls) so the tests exercise real routing logic
rather than plain JS boolean expressions.






src/libs/blockchain/mempool_v2.ts (1)

318-335: Consider adding existence check or return value for updateClassification.

The method silently no-ops if the transaction hash doesn't exist. Consider returning a boolean indicating success, or logging when the update affects 0 rows to aid debugging.

Additionally, there's a minor TOCTOU window between findOne (line 329) and update (line 334) where another process could set soft_finality_at. In practice this is low-risk since the worst outcome is a slightly different timestamp, but if precision matters, consider using a conditional SQL update instead:

sql
UPDATE mempool SET soft_finality_at = ? WHERE hash = ? AND soft_finality_at IS NULL



🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/blockchain/mempool_v2.ts around lines 318 - 335, The
updateClassification method currently silently no-ops when the txHash doesn't
exist and has a TOCTOU between repo.findOne and repo.update; update it to return
a boolean (or throw) indicating whether the update affected any rows and log
when 0 rows are affected, and eliminate the TOCTOU by performing a conditional
update that sets soft_finality_at only when NULL (e.g., use repo.update with a
where clause that includes soft_finality_at IS NULL or execute a single
conditional SQL UPDATE) rather than relying on a separate findOne; reference
updateClassification, repo.findOne and repo.update when making the change.






src/libs/consensus/petri/arbitration/bftArbitrator.ts (1)

82-112: Consider a dedicated RPC method for BFT arbitration.

Using roundNumber: -1 as a sentinel to distinguish arbitration from regular forge exchange (as noted in the REVIEW comment) is pragmatic but couples arbitration behavior to the forge exchange handler's implementation details.

If the arbitration protocol diverges from forge exchange (e.g., different timeout, retry logic, or response format), a dedicated petri_arbitrateDeltas RPC method would make the intent clearer and avoid accidental breakage.

This is not blocking since the current approach works correctly, but worth tracking as technical debt.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @src/libs/consensus/petri/arbitration/bftArbitrator.ts around lines 82 - 112,
The code reuses the petri_exchangeDeltas RPC with roundNumber: -1 as a sentinel
inside the consensus_routine longCall (see peers.map / longCall usage) which
couples BFT arbitration behavior to the forge exchange handler; add a dedicated
RPC (e.g., petri_arbitrateDeltas) and update the caller in bftArbitrator.ts to
invoke consensus_routine with params.method set to "petri_arbitrateDeltas" (and
define its contract/response shape), implement a corresponding handler that
returns deltas regardless of roundNumber and handles arbitration-specific
timeouts/retries/response format, and then replace the sentinel-based checks
around roundNumber and data.deltas[tx.hash] so arbitration logic is isolated
from petri_exchangeDeltas.






testing/loadgen/src/features/consensus/petri_soak.ts (1)

154-160: Type casts suggest SDK type definitions may be incomplete.

The casts to (demos as any).confirm and (demos as any).broadcast suggest these methods might not be properly typed in the SDK. While acceptable for test code, consider updating the SDK type definitions if these are valid public methods.


🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @testing/loadgen/src/features/consensus/petri_soak.ts around lines 154 - 160,
The casts (demos as any).confirm and (demos as any).broadcast indicate missing
typings for the SDK methods; fix this by updating the demos client type instead
of using any — add confirm(...) and broadcast(...) signatures to the SDK's
client interface (or the local type used in petri_soak.ts) so the code can call
demos.confirm(signedTx) and demos.broadcast(result) with proper types, then
remove the casts in petri_soak.ts (referencing the demos variable and the
confirm/broadcast methods).






petri/03-secretary-coordinated-signing.md (1)

13-28: Add language specifier to fenced code blocks for lint compliance.

The markdownlint warnings flag code blocks without language specifiers. For ASCII diagrams and pseudocode, use text or plaintext:


📝 Suggested fixes

Line 13:
diff
-
+text
 All 10 shard members compile block independently (deterministic)


Line 123:
diff
-
+text
 if (isWeSecretary(shard)):


Line 180:
diff
-text
 Task 1 (petriSecretary.ts)




🤖 Prompt for AI Agents


Verify each finding against the current code and only fix it if needed.

In @petri/03-secretary-coordinated-signing.md around lines 13 - 28, Add a
language specifier (use "text") to the fenced code blocks in
petri/03-secretary-coordinated-signing.md to satisfy markdownlint: update the
block containing the ASCII diagram starting "All 10 shard members compile block
independently (deterministic)" to text, the pseudocode block containing "if
(isWeSecretary(shard)):" to text, and the block around "Task 1
(petriSecretary.ts)" to text so all fenced code blocks include a language
tag.








---


ℹ️ Review info


⚙️ Run configuration

Configuration used: Organization UI

Review profile: CHILL

Plan: Pro

Run ID: 21dc0966-9680-4ca0-a3e2-928029a2bf1b




📥 Commits

Reviewing files that changed from the base of the PR and between 530111b941174ae702a658adacc2a0d029148149 and 5e9ded425fb6c4f9e570f5a6e99429f54fd23076.




⛔ Files ignored due to path filters (2)

* .mycelium/mycelium.db is excluded by !/*.db
* petri/pitch.pdf is excluded by !/*.pdf




📒 Files selected for processing (84)

* .env.example
* .gitignore
* AGENTS.md
* TEAM.md
* better_testing/petri/benchmark.test.ts
* better_testing/petri/blockCompiler.test.ts
* better_testing/petri/byzantineFault.test.ts
* better_testing/petri/canonicalJson.test.ts
* better_testing/petri/classifier.test.ts
* better_testing/petri/conflictPath.test.ts
* better_testing/petri/continuousForge.test.ts
* better_testing/petri/deltaTracker.test.ts
* better_testing/petri/featureFlagRollback.test.ts
* better_testing/petri/finality.test.ts
* better_testing/petri/happyPath.test.ts
* better_testing/petri/liveness.test.ts
* better_testing/petri/routing.test.ts
* better_testing/petri/secretaryCoordination.test.ts
* better_testing/petri/speculativeExecutor.test.ts
* data/genesis.json
* package.json
* petri/00-codebase-mapping.md
* petri/01-implementation-plan.md
* petri/02-risks-and-considerations.md
* petri/03-secretary-coordinated-signing.md
* petri/VADEMECUM.md
* petri/architecture-diagram.md
* petri/consensus.md
* petri/petri.md
* src/config/defaults.ts
* src/config/envKeys.ts
* src/config/index.ts
* src/config/loader.ts
* src/config/types.ts
* src/features/metrics/MetricsCollector.ts
* src/index.ts
* src/libs/blockchain/chainBlocks.ts
* src/libs/blockchain/l2ps_mempool.ts
* src/libs/blockchain/mempool_v2.ts
* src/libs/communications/broadcastManager.ts
* src/libs/consensus/petri/arbitration/bftArbitrator.ts
* src/libs/consensus/petri/block/petriBlockCompiler.ts
* src/libs/consensus/petri/block/petriBlockFinalizer.ts
* src/libs/consensus/petri/classifier/transactionClassifier.ts
* src/libs/consensus/petri/coordination/petriSecretary.ts
* src/libs/consensus/petri/execution/speculativeExecutor.ts
* src/libs/consensus/petri/finality/transactionFinality.ts
* src/libs/consensus/petri/forge/continuousForge.ts
* src/libs/consensus/petri/forge/deltaAgreementTracker.ts
* src/libs/consensus/petri/forge/forgeInstance.ts
* src/libs/consensus/petri/index.ts
* src/libs/consensus/petri/routing/petriRouter.ts
* src/libs/consensus/petri/routing/shardMapper.ts
* src/libs/consensus/petri/types/classificationTypes.ts
* src/libs/consensus/petri/types/continuousForgeTypes.ts
* src/libs/consensus/petri/types/deltaComparison.ts
* src/libs/consensus/petri/types/petriConfig.ts
* src/libs/consensus/petri/types/stateDelta.ts
* src/libs/consensus/petri/utils/canonicalJson.ts
* src/libs/consensus/v2/PoRBFT.ts
* src/libs/consensus/v2/routines/broadcastBlockHash.ts
* src/libs/consensus/v2/routines/ensureCandidateBlockFormed.ts
* src/libs/consensus/v2/routines/manageProposeBlockHash.ts
* src/libs/consensus/v2/routines/orderTransactions.ts
* src/libs/consensus/v2/types/secretaryManager.ts
* src/libs/consensus/v2/types/validationStatusTypes.ts
* src/libs/network/endpointExecution.ts
* src/libs/network/endpointValidation.ts
* src/libs/network/manageConsensusRoutines.ts
* src/libs/network/rpcDispatch.ts
* src/libs/omniprotocol/protocol/handlers/consensus.ts
* src/model/entities/Mempool.ts
* src/model/entities/Transactions.ts
* src/utilities/mainLoop.ts
* src/utilities/sharedState.ts
* testing/TESTING_MAP.md
* testing/devnet/.env.example
* testing/devnet/docker-compose.yml
* testing/loadgen/src/features/consensus/petri_block_production.ts
* testing/loadgen/src/features/consensus/petri_relay_flow.ts
* testing/loadgen/src/features/consensus/petri_soak.ts
* testing/loadgen/src/features/consensus/petri_tx_inclusion.ts
* testing/loadgen/src/main.ts
* testing/scripts/run-suite.ts







===== qodo-code-review[bot] (2 comments) =====
--- comment 1/2 ---
Time: 2026-03-23T12:33:08Z
Type: issue_comment
URL: https://github.com/kynesyslabs/node/pull/692#issuecomment-4110284361
Body:
ⓘ You are approaching your monthly quota for Qodo. Upgrade your plan

Review Summary by Qodo

Petri Consensus Protocol: Complete Implementation with Byzantine Fault Tolerance and Dual Finality

✨ Enhancement 🧪 Tests 📝 Documentation



Walkthroughs


Description




• Petri Consensus Protocol Implementation: Complete implementation of a leaderless, Byzantine
  fault-tolerant consensus protocol with 9 phases spanning transaction classification, continuous
  forge loop, delta agreement tracking, BFT arbitration, block compilation, and secretary-coordinated
  finalization
• Core Consensus Components:
  - ContinuousForge (Phase 2): 2-second forge loop with speculative execution and delta exchange
  - DeltaAgreementTracker: Per-transaction agreement tracking with threshold-based promotion and
  TTL-based flagging
  - BFTArbitrator: Resolves delta disagreements via 2/3+1 member consensus
  - PetriBlockCompiler: Deterministic block compilation at 10-second boundaries
  - PetriBlockFinalizer: Secretary-coordinated block signing with verify-then-sign model
• Transaction Classification: Dual-path routing based on GCR edit analysis (PRE_APPROVED for
  read-only, TO_APPROVE for state-changing)
• Routing &amp; Coordination: Deterministic shard member selection via Alea PRNG, secretary election
  as first peer in shard
• Mempool Integration: Classification at insertion time, soft/hard finality tracking,
  speculative execution support
• RPC Endpoints: getTransactionFinality for dual finality queries, petri_exchangeDeltas for
  Phase 2, petri_submitBlockHash for Phase 9
• Comprehensive Test Suite: 186 unit and integration tests covering happy path, conflict
  resolution, Byzantine fault tolerance, liveness guarantees, performance benchmarks, and feature flag
  rollback
• Devnet Scenarios: 4 E2E test scenarios (block production, TX inclusion, relay flow, soak test)
  for performance validation
• Configuration System: Environment-based Petri config with sensible defaults (forge interval
  2s, block interval 10s, agreement threshold 7, shard size 10)
• Database Schema: Mempool and Transaction entities extended with classification, delta_hash,
  and soft_finality_at columns
• Documentation: Implementation plan, codebase mapping, operational guide, and consensus flow
  reference
• Backward Compatibility: Feature flag gating (petriConsensus) with PoRBFT v2 fallback,
  deprecation notices for replaced components




Diagram




mermaid
flowchart LR
  TX["Transaction Submitted"]
  CLASSIFY["Transaction Classifier"]
  ROUTE["Petri Router"]
  FORGE["Continuous Forge2s Loop"]
  DELTA["Delta AgreementTracker"]
  BFT["BFT Arbitrator2/3+1 Consensus"]
  COMPILE["Block Compiler10s Boundary"]
  FINALIZE["Block FinalizerSecretary Coordination"]
  CHAIN["Chain Insertion"]
  
  TX --> CLASSIFY
  CLASSIFY -->|PRE_APPROVED| ROUTE
  CLASSIFY -->|TO_APPROVE| ROUTE
  ROUTE --> FORGE
  FORGE --> DELTA
  DELTA -->|Agreement| COMPILE
  DELTA -->|Disagreement| BFT
  BFT --> COMPILE
  COMPILE --> FINALIZE
  FINALIZE --> CHAIN











File Changes


1. better_testing/petri/secretaryCoordination.test.ts
 🧪 Tests  +451/-0     



Secretary-Coordinated Block Signing Test Suite

• Comprehensive test suite for Petri Consensus Phase 9 secretary-coordinated block signing
• Tests secretary election logic (deterministic, first peer in shard)
• Validates BFT threshold calculations and collection agreement logic
• Tests hash matching/mismatching, submission receipt, and secretary failover scenarios
• Verifies verify-then-sign model and block finalization flows


better_testing/petri/secretaryCoordination.test.ts
 





2. src/libs/consensus/petri/coordination/petriSecretary.ts
 ✨ Enhancement  +363/-0     



Secretary-Coordinated Block Signing Implementation

• Implements secretary-coordinated block signing for Petri Consensus Phase 9
• Provides collectBlockHashes() for secretary to gather and verify member signatures
• Implements submitBlockHash() for non-secretaries to submit their block hashes
• Includes secretary election via electSecretary() and isWeSecretary() functions
• Handles secretary failover and mempool re-sync on hash mismatches


src/libs/consensus/petri/coordination/petriSecretary.ts
 





3. testing/loadgen/src/features/consensus/petri_soak.ts
 🧪 Tests  +291/-0     



Petri Consensus Soak Test with Performance Baseline

• Devnet soak test scenario for Petri Consensus measuring sustained load performance
• Tracks TX submission throughput, soft/hard finality latencies, and block production rates
• Polls transaction finality status and computes percentile latencies (p50, p95, p99)
• Generates JSON baseline summary for performance comparison across runs


testing/loadgen/src/features/consensus/petri_soak.ts
 




View more (80)

4. better_testing/petri/happyPath.test.ts
 🧪 Tests  +305/-0     



Happy-Path Integration Test for Petri Consensus

• Integration test for Petri Consensus Phase 6 happy-path lifecycle
• Simulates TX flow from TO_APPROVE → PRE_APPROVED (soft finality) → confirmed (hard finality)
• Tests delta agreement tracker, BFT voting, and finality result shapes
• Validates ContinuousForge state machine lifecycle (start, pause, resume, stop)


better_testing/petri/happyPath.test.ts
 





5. better_testing/petri/conflictPath.test.ts
 🧪 Tests  +275/-0     



Conflict Path and BFT Arbitration Test Suite

• Tests Petri Consensus conflict resolution for double-spend and delta disagreement scenarios
• Validates PROBLEMATIC TX flagging after TTL expiration and BFT arbitration
• Verifies mempool cleanup and chain liveness even with conflicting transactions
• Ensures block production continues regardless of conflicts


better_testing/petri/conflictPath.test.ts
 





6. better_testing/petri/byzantineFault.test.ts
 🧪 Tests  +266/-0     



Byzantine Fault Tolerance Test Suite

• Tests Byzantine fault tolerance with up to f &lt; n/3 malicious nodes
• Validates that honest majority (7/10) reaches agreement despite Byzantine interference
• Tests coordinated attacks, eclipse attempts, and omission faults
• Verifies BFT arbitration resolves PROBLEMATIC TXs when honest nodes agree


better_testing/petri/byzantineFault.test.ts
 





7. better_testing/petri/benchmark.test.ts
 🧪 Tests  +287/-0     



Petri Consensus Performance Benchmarking Suite

• Performance benchmarks for Petri Consensus components (DeltaAgreementTracker, routing, BFT)
• Validates throughput targets: 1000+ TXs per round, &lt;1ms routing decisions
• Tests finality latency design targets (soft &lt;2s, hard &lt;12s)
• Measures memory efficiency and cleanup behavior


better_testing/petri/benchmark.test.ts
 





8. src/libs/consensus/petri/forge/continuousForge.ts
 ✨ Enhancement  +288/-0     



Continuous Forge Loop Implementation for Petri

• Implements ContinuousForge: the 2-second forge loop for Petri Consensus Phase 2
• Syncs mempools, executes transactions speculatively, and exchanges delta hashes with shard
• Records deltas in DeltaAgreementTracker and promotes/flags TXs based on agreement
• Provides state management (start, stop, pause, resume, reset) and RPC delta exposure


src/libs/consensus/petri/forge/continuousForge.ts
 





9. testing/loadgen/src/features/consensus/petri_relay_flow.ts
 🧪 Tests  +248/-0     



Petri Consensus Relay Flow E2E Test

• E2E devnet scenario validating Petri consensus relay propagation across all nodes
• Submits TX to bootstrap node and verifies visibility on all other nodes
• Checks nonce advancement and transaction finality consistency across cluster
• Generates JSON summary of relay propagation results


testing/loadgen/src/features/consensus/petri_relay_flow.ts
 





10. better_testing/petri/liveness.test.ts
 🧪 Tests  +240/-0     



Liveness Guarantee Test Suite for Petri

• Tests Petri Consensus liveness guarantee: chain never stalls
• Validates empty block production when no TXs exist
• Verifies PROBLEMATIC TXs have bounded lifetime (TTL-based cleanup)
• Tests block production continues on schedule regardless of conflicts


better_testing/petri/liveness.test.ts
 





11. src/libs/blockchain/mempool_v2.ts
 ✨ Enhancement  +81/-0     



Mempool Integration with Petri Classification

• Adds Petri Consensus classification at TX insertion time (gated by feature flag)
• Implements classifyTransaction() and speculative execution for TO_APPROVE TXs
• Adds getByClassification(), getPreApproved(), and updateClassification() methods
• Records soft finality timestamp on first PRE_APPROVED classification


src/libs/blockchain/mempool_v2.ts
 





12. better_testing/petri/blockCompiler.test.ts
 🧪 Tests  +244/-0     



Petri Consensus Phase 3 block compilation and finalization tests

• Comprehensive test suite for BFT threshold calculation with various shard sizes
• Tests for CompilationResult, ArbitrationResult, and FinalizationResult data structures
• Validates consensus dispatch switching logic based on petriConsensus flag
• Tests block period lifecycle including forge pause/resume pattern and empty block handling


better_testing/petri/blockCompiler.test.ts
 





13. better_testing/petri/deltaTracker.test.ts
 🧪 Tests  +224/-0     



DeltaAgreementTracker agreement and flagging mechanism tests

• Unit tests for DeltaAgreementTracker promotion and flagging logic
• Tests threshold-based promotion when members agree on delta hashes
• Tests TTL expiry flagging when no agreement is reached
• Tests edge cases including late-arriving deltas, majority wins, and state cleanup


better_testing/petri/deltaTracker.test.ts
 





14. testing/loadgen/src/features/consensus/petri_tx_inclusion.ts
 🧪 Tests  +227/-0     



Petri Consensus TX inclusion and finality devnet scenario

• Devnet scenario testing TX inclusion and finality in Petri Consensus
• Verifies soft finality (softFinalityAt) and hard finality (hardFinalityAt) via RPC
• Tests transaction nonce advancement and block production
• Measures finality latency and validates getTransactionFinality RPC response format


testing/loadgen/src/features/consensus/petri_tx_inclusion.ts
 





15. better_testing/petri/featureFlagRollback.test.ts
 🧪 Tests  +227/-0     



Feature flag rollback and state isolation for Petri toggle

• Tests clean switching between PoRBFT v2 and Petri Consensus via feature flag
• Validates forge instance lifecycle (creation, deregistration, state isolation)
• Tests concurrent safety (double stop, reset after stop, null instance handling)
• Verifies mempool compatibility and classification enum consistency across toggles


better_testing/petri/featureFlagRollback.test.ts
 





16. better_testing/petri/finality.test.ts
 🧪 Tests  +216/-0     



Transaction finality result structure and RPC response tests

• Tests TransactionFinalityResult structure and field types for various classification states
• Validates finality state transitions (TO_APPROVE → PRE_APPROVED with soft finality timestamp)
• Tests RPC response shape for getTransactionFinality endpoint
• Verifies soft_finality_at timestamp behavior and validation logic


better_testing/petri/finality.test.ts
 





17. better_testing/petri/routing.test.ts
 🧪 Tests  +194/-0     



Petri routing and shard member selection tests

• Tests ShardMapper returning &#x27;default&#x27; shard in single-shard testnet mode
• Tests selectMembers determinism, count validation, and uniqueness guarantees
• Tests routing flag gating logic for Petri vs DTR paths
• Validates response shapes for both Petri and DTR routing modes


better_testing/petri/routing.test.ts
 





18. src/libs/consensus/petri/block/petriBlockFinalizer.ts
 ✨ Enhancement  +197/-0     



Petri block finalization with secretary coordination

• Implements secretary-driven block finalization using broadcast model
• Secretary broadcasts block hash to shard peers for verify-then-sign verification
• Collects signatures and checks BFT threshold before block insertion
• Non-secretary members wait for finalized block via broadcast/sync


src/libs/consensus/petri/block/petriBlockFinalizer.ts
 





19. src/libs/consensus/petri/index.ts
 ✨ Enhancement  +180/-0     



Petri Consensus protocol entry point and orchestration

• Entry point for Petri Consensus protocol implementation
• Orchestrates continuous forge loop with periodic block finalization at 10s boundaries
• Implements block period lifecycle: forge → arbitrate → compile → finalize → reset
• Re-exports all Petri phases (2-5) and coordinates consensus routine dispatch


src/libs/consensus/petri/index.ts
 





20. src/libs/network/manageConsensusRoutines.ts
 ✨ Enhancement  +118/-4     



Consensus routine dispatch and Petri RPC handlers

• Adds Petri Consensus dispatch logic gated by petriConsensus feature flag
• Implements petri_exchangeDeltas RPC handler for Phase 2 delta exchange
• Implements petri_submitBlockHash RPC handler for Phase 9 secretary-coordinated block signing
• Marks deprecated Secretary RPCs as no-ops when Petri is active


src/libs/network/manageConsensusRoutines.ts
 





21. src/libs/consensus/v2/routines/broadcastBlockHash.ts
 ✨ Enhancement  +63/-89     



Block hash broadcast refactoring with improved error handling

• Refactors to use Promise.allSettled for parallel RPC calls with better error handling
• Improves signature verification with inline error handling instead of nested promises
• Simplifies logging and response tracking for block hash broadcast
• Returns signature count and vote tallies for BFT threshold checking


src/libs/consensus/v2/routines/broadcastBlockHash.ts
 





22. src/libs/consensus/petri/block/petriBlockCompiler.ts
 ✨ Enhancement  +151/-0     



Petri block compilation with deterministic TX selection

• Compiles mempool transactions into candidate blocks at 10s boundaries
• Applies deterministic timestamp cutoff to ensure consistent TX set across nodes
• Reuses existing orderTransactions and createBlock infrastructure
• Includes cleanup function to remove rejected PROBLEMATIC transactions from mempool


src/libs/consensus/petri/block/petriBlockCompiler.ts
 





23. better_testing/petri/classifier.test.ts
 🧪 Tests  +192/-0     



Transaction classification logic unit tests

• Tests transaction classification logic (PRE_APPROVED vs TO_APPROVE)
• Validates that read-only transactions with only fee/nonce edits are PRE_APPROVED
• Tests that transactions with state-changing edits are classified as TO_APPROVE
• Covers edge cases including identity edits, storage program edits, and different accounts


better_testing/petri/classifier.test.ts
 





24. src/libs/consensus/petri/arbitration/bftArbitrator.ts
 ✨ Enhancement  +149/-0     



BFT arbitration for delta disagreement resolution

• Implements BFT arbitration for PROBLEMATIC transactions with delta disagreement
• Re-executes transactions speculatively and exchanges deltas with shard members
• Promotes transactions to PRE_APPROVED if 2/3+1 members agree on delta hash
• Rejects transactions if agreement not reached, ensuring chain never stalls


src/libs/consensus/petri/arbitration/bftArbitrator.ts
 





25. src/libs/consensus/petri/forge/deltaAgreementTracker.ts
 ✨ Enhancement  +171/-0     



Delta agreement tracking and promotion/flagging mechanism

• Tracks per-transaction delta agreement across forge rounds within a shard
• Promotes transactions to PRE_APPROVED when threshold agreement is reached
• Flags transactions as PROBLEMATIC after TTL rounds without agreement
• Provides detailed comparison data for diagnostics and round results


src/libs/consensus/petri/forge/deltaAgreementTracker.ts
 





26. better_testing/petri/speculativeExecutor.test.ts
 🧪 Tests  +130/-0     



Speculative executor delta determinism tests

• Tests deterministic delta hashing for speculative transaction execution
• Validates that same GCR edits produce same canonical hash regardless of key order
• Tests that different amounts, accounts, and edit orders produce different hashes
• Verifies BigInt and number amount handling consistency


better_testing/petri/speculativeExecutor.test.ts
 





27. src/libs/blockchain/chainBlocks.ts
 ✨ Enhancement  +89/-70     



Block insertion with savepoint-based transaction isolation

• Refactors insertBlock to use QueryRunner with savepoint support
• Prevents single transaction insert failure from poisoning entire PostgreSQL transaction
• Improves error handling with per-transaction savepoints and rollback capability
• Maintains committed transaction tracking for identity commitment updates


src/libs/blockchain/chainBlocks.ts
 





28. src/libs/consensus/petri/execution/speculativeExecutor.ts
 ✨ Enhancement  +130/-0     



Speculative transaction execution for delta generation

• Executes transaction GCR edits in simulation mode without mutating state
• Produces deterministic StateDelta with canonical hash for cross-node agreement
• Handles balance, nonce, identity, and other GCR edit types
• Ensures two honest nodes produce identical delta hashes for same transaction


src/libs/consensus/petri/execution/speculativeExecutor.ts
 





29. src/libs/consensus/petri/routing/petriRouter.ts
 ✨ Enhancement  +129/-0     



Petri transaction routing to shard members

• Routes validated transactions to exactly 2 shard members deterministically
• Uses Alea PRNG seeded with transaction hash for consistent member selection
• Provides getCurrentShard helper and relay function for transaction distribution
• Ensures all nodes agree on which members handle a given transaction


src/libs/consensus/petri/routing/petriRouter.ts
 





30. better_testing/petri/canonicalJson.test.ts
 🧪 Tests  +107/-0     



Canonical JSON serialization determinism test suite

• Comprehensive unit tests for deterministic JSON serialization with sorted keys
• Validates BigInt handling (string with &#x27;n&#x27; suffix), Map/Set sorting, and nested object key
 ordering
• Tests determinism guarantee: identical logical data produces identical strings regardless of key
 insertion order
• Covers edge cases: null/undefined, empty collections, special characters, deeply nested structures


better_testing/petri/canonicalJson.test.ts
 





31. src/features/metrics/MetricsCollector.ts
 ✨ Enhancement  +53/-0     



Petri consensus observability metrics integration

• Added 6 new Petri consensus metrics gauges (enabled, forge running/paused, round number,
 pending/tracked TX counts)
• Implemented collectPetriMetrics() method to gather forge state and transaction tracking data
• Integrated Petri metrics collection into main metrics cycle with error handling
• Metrics gated by petriConsensus feature flag with graceful degradation


src/features/metrics/MetricsCollector.ts
 





32. testing/loadgen/src/features/consensus/petri_block_production.ts
 🧪 Tests  +84/-0     



Petri block production devnet scenario test

• New devnet scenario validating block production when PETRI_CONSENSUS=true
• Checks Petri RPC availability via getTransactionFinality endpoint probe
• Verifies block height advancement with configurable thresholds and timeouts
• Outputs summary JSON with Petri-specific metrics (enabled node count, block deltas)


testing/loadgen/src/features/consensus/petri_block_production.ts
 





33. src/libs/blockchain/l2ps_mempool.ts
 ✨ Enhancement  +19/-8     



L2PS mempool Petri consensus routing integration

• Added conditional logic to skip SecretaryManager when Petri consensus is active
• Block number determination now branches: Petri uses chain directly, PoRBFT v2 uses secretary shard
 reference
• Minor formatting fixes (trailing commas in function signatures)
• Maintains backward compatibility with PoRBFT v2 fallback via feature flag


src/libs/blockchain/l2ps_mempool.ts
 





34. src/libs/consensus/petri/finality/transactionFinality.ts
 ✨ Enhancement  +86/-0     



Transaction finality query RPC endpoint implementation

• New RPC endpoint implementation for dual finality model (soft/hard timestamps)
• Queries both mempool (pending) and chain (confirmed) for transaction status
• Returns classification, soft finality (PRE_APPROVED timestamp), hard finality (block inclusion
 timestamp)
• Includes error handling and logging for transaction lookup failures


src/libs/consensus/petri/finality/transactionFinality.ts
 





35. better_testing/petri/continuousForge.test.ts
 🧪 Tests  +85/-0     



Continuous forge state machine lifecycle tests

• State lifecycle tests for ContinuousForge state machine (start, stop, pause, resume, reset)
• Validates initial state, running/paused flags, round counter, and delta tracking
• Tests idempotency (double start ignored) and object reference isolation (getCurrentDeltas returns
 copies)
• Does not test actual forge rounds (requires DB/network) — integration tests cover that


better_testing/petri/continuousForge.test.ts
 





36. src/libs/consensus/petri/classifier/transactionClassifier.ts
 ✨ Enhancement  +79/-0     



Transaction classifier for Petri consensus phases

• Transaction classification logic based on GCR edit generation (empty edits = PRE_APPROVED,
 non-empty = TO_APPROVE)
• Filters out fee-only and nonce-only edits to detect true state changes
• Supports pre-computed edits to avoid redundant GCR generation
• Returns classification result with full edits array for downstream use


src/libs/consensus/petri/classifier/transactionClassifier.ts
 





37. src/libs/consensus/v2/routines/manageProposeBlockHash.ts
 ✨ Enhancement  +30/-1     



Accept-and-sign block hash signing for Petri consensus

• Added Petri consensus accept-and-sign model: members sign secretary&#x27;s block hash directly without
 verification
• Dual-mode implementation: Petri trusts deterministic secretary, PoRBFT v2 verifies-then-signs
• Imports uint8ArrayToHex for signature encoding
• Gated by petriConsensus feature flag with early return before PoRBFT v2 path


src/libs/consensus/v2/routines/manageProposeBlockHash.ts
 





38. testing/loadgen/src/main.ts
 🧪 Tests  +8/-0     



Petri consensus test scenario registration

• Registered 4 new Petri consensus test scenarios: petri_block_production, petri_tx_inclusion,
 petri_relay_flow, petri_soak
• Added imports for Petri scenario functions
• Scenarios available for test suite execution and devnet validation


testing/loadgen/src/main.ts
 





39. src/libs/consensus/petri/types/continuousForgeTypes.ts
 ✨ Enhancement  +43/-0     



Continuous forge type definitions and interfaces

• Defines ContinuousForgeRound interface: round metadata, transactions, deltas,
 promoted/problematic TX hashes
• Defines ForgeConfig interface: forge interval, agreement threshold, problematic TTL
• Defines ForgeState interface: running/paused flags, round counter, pending transaction map
• Provides type contracts for forge loop coordination


src/libs/consensus/petri/types/continuousForgeTypes.ts
 





40. src/libs/network/endpointExecution.ts
 ✨ Enhancement  +23/-0     



Petri consensus transaction routing integration

• Added Petri consensus routing via petriRelay() before DTR/mempool addition
• Originating node does NOT add TX to its own mempool — shard members receive via RELAY_TX
• Early return with routing metadata when Petri flag is active
• Maintains backward compatibility with DTR flow when Petri is disabled


src/libs/network/endpointExecution.ts
 





41. src/libs/consensus/petri/utils/canonicalJson.ts
 ✨ Enhancement  +45/-0     



Deterministic canonical JSON serialization utility

• Deterministic JSON serialization with sorted object keys and custom replacer function
• Handles BigInt (converts to string with &#x27;n&#x27; suffix), Maps (sorted entries), Sets (sorted values)
• Critical for delta hashing: identical objects produce identical strings regardless of key order
• Used by state delta comparison across shard members


src/libs/consensus/petri/utils/canonicalJson.ts
 





42. src/libs/consensus/v2/routines/ensureCandidateBlockFormed.ts
 ✨ Enhancement  +20/-6     



Petri block compilation wait logic in candidate block formation

• Added Petri consensus path: waits for Petri block compilation instead of falling back to PoRBFT v2
 consensus routine
• Polls for candidate block with 100ms intervals up to 5 seconds when Petri is active
• Preserves PoRBFT v2 path when Petri flag is disabled
• Prevents unnecessary consensus routine invocation during Petri block compilation


src/libs/consensus/v2/routines/ensureCandidateBlockFormed.ts
 





43. src/libs/network/rpcDispatch.ts
 ✨ Enhancement  +21/-0     



Transaction finality RPC endpoint dispatch handler

• Added getTransactionFinality RPC method handler for Petri consensus finality queries
• Validates transaction hash parameter and returns finality result with classification and
 timestamps
• Integrated into main RPC dispatch switch statement
• Provides public API for transaction status queries


src/libs/network/rpcDispatch.ts
 





44. src/config/loader.ts
 ⚙️ Configuration changes  +9/-0     



Petri consensus configuration loading

• Added Petri consensus configuration loading from environment variables
• Loads 5 Petri config parameters: enabled flag, forge interval, block interval, agreement
 threshold, problematic TTL, shard size
• Integrates with existing config loader pattern using envBool() and envInt() helpers
• Defaults applied from defaults.ts


src/config/loader.ts
 





45. src/utilities/mainLoop.ts
 ✨ Enhancement  +11/-1     



Petri consensus routine dispatch in main loop

• Added Petri consensus routine dispatch: computes shard and calls petriConsensusRoutine() when
 flag is active
• Maintains PoRBFT v2 fallback via consensusRoutine() when Petri is disabled
• Imports shard/seed computation functions for Petri path
• Gated by getSharedState.petriConsensus feature flag


src/utilities/mainLoop.ts
 





46. src/config/envKeys.ts
 ⚙️ Configuration changes  +8/-0     



Petri consensus environment variable keys

• Added 6 new environment variable keys for Petri consensus configuration
• Keys: PETRI_CONSENSUS, PETRI_FORGE_INTERVAL_MS, PETRI_BLOCK_INTERVAL_MS,
 PETRI_AGREEMENT_THRESHOLD, PETRI_PROBLEMATIC_TTL_ROUNDS, PETRI_SHARD_SIZE
• Enables environment-based Petri configuration without code changes


src/config/envKeys.ts
 





47. src/config/index.ts
 ✨ Enhancement  +6/-0     



Petri consensus config accessor and type export

• Added petri config getter to Config class
• Exports PetriConsensusConfig type for type safety
• Maintains read-only access pattern consistent with other config sections


src/config/index.ts
 





48. src/libs/consensus/petri/types/classificationTypes.ts
 ✨ Enhancement  +27/-0     



Transaction classification type definitions

• Defines TransactionClassification enum: PRE_APPROVED, TO_APPROVE, PROBLEMATIC
• Defines ClassifiedTransaction interface with hash, classification, timestamps, forge round,
 delta hash, promotion/rejection tracking
• Provides type contracts for transaction state tracking through forge cycles


src/libs/consensus/petri/types/classificationTypes.ts
 





49. src/model/entities/Mempool.ts
 ✨ Enhancement  +12/-0     



Mempool entity Petri consensus columns

• Added classification column (text, nullable) with index for Petri transaction classification
• Added delta_hash column (text, nullable) for state delta tracking
• Added soft_finality_at column (bigint, nullable) for Petri finality timestamps
• Enables mempool to track Petri-specific transaction metadata


src/model/entities/Mempool.ts
 





50. testing/scripts/run-suite.ts
 🧪 Tests  +7/-1     



Petri consensus test suite registration

• Added petri test suite type with 4 scenarios: block production, TX inclusion, relay flow, soak
 test
• Integrated into suite registry for test orchestration
• Enables coordinated Petri consensus testing across multiple scenarios


testing/scripts/run-suite.ts
 





51. src/libs/consensus/petri/types/stateDelta.ts
 ✨ Enhancement  +27/-0     



State delta type definitions for Petri consensus

• Defines StateDelta interface: transaction hash, GCR edits, canonical JSON hash, execution
 timestamp, block reference
• Defines PeerDelta interface: peer public key, transaction hash, delta hash, receipt timestamp
• Provides type contracts for state delta exchange and agreement tracking


src/libs/consensus/petri/types/stateDelta.ts
 





52. src/index.ts
 ✨ Enhancement  +11/-0     



Petri consensus initialization in application warmup

• Initialized Petri consensus configuration in warmup phase
• Sets getSharedState.petriConsensus flag and petriConfig from loaded configuration
• Integrates Petri config into shared state for runtime access


src/index.ts
 





53. src/libs/consensus/petri/types/deltaComparison.ts
 ✨ Enhancement  +25/-0     



Delta comparison and agreement type definitions

• Defines DeltaComparison interface: per-transaction delta agreement tracking with peer hash map,
 agreement counts
• Defines RoundDeltaResult interface: aggregated round results with promoted/problematic
 transaction lists
• Provides type contracts for delta agreement evaluation


src/libs/consensus/petri/types/deltaComparison.ts
 





54. src/config/defaults.ts
 ⚙️ Configuration changes  +10/-1     



Petri consensus default configuration

• Added Petri consensus default configuration: enabled=true, forge interval=2000ms, block
 interval=10000ms, agreement threshold=7, TTL=5 rounds, shard size=10
• Changed OMNI server mode default from empty string to OMNI_PREFERRED
• Provides sensible defaults for Petri testnet deployment


src/config/defaults.ts
 





55. src/config/types.ts
 ✨ Enhancement  +12/-0     



Petri consensus configuration type definitions

• Added PetriConsensusConfig interface with 6 configuration fields
• Added petri field to AppConfig interface
• Provides type safety for Petri configuration throughout application


src/config/types.ts
 





56. src/libs/communications/broadcastManager.ts
 ✨ Enhancement  +5/-5     



Block broadcast to all peers for Petri consensus

• Removed signer filter from block broadcast: now sends to ALL peers instead of filtering by
 non-signers
• Petri shard members need finalized block with all signatures, not just unsigned block
• Deduplication handled by receiving side via Chain.getBlockByHash()
• Maintains backward compatibility with PoRBFT v2


src/libs/communications/broadcastManager.ts
 





57. src/libs/consensus/petri/types/petriConfig.ts
 ✨ Enhancement  +23/-0     



Petri consensus configuration interface and defaults

• Defines PetriConfig interface extending ForgeConfig with enabled flag, block interval, shard
 size
• Provides DEFAULT_PETRI_CONFIG constant with conservative testnet values
• Centralizes Petri configuration contract


src/libs/consensus/petri/types/petriConfig.ts
 





58. src/utilities/sharedState.ts
 ✨ Enhancement  +5/-0     



Petri consensus feature flag and config in shared state

• Added petriConsensus boolean flag (default false) for feature flag gating
• Added petriConfig object with default Petri configuration
• Imports DEFAULT_PETRI_CONFIG from Petri types
• Enables runtime Petri consensus control via shared state


src/utilities/sharedState.ts
 





59. src/libs/consensus/petri/forge/forgeInstance.ts
 ✨ Enhancement  +23/-0     



Petri continuous forge singleton instance manager

• Singleton instance management for ContinuousForge
• Exports getPetriForgeInstance() and setPetriForgeInstance() for forge lifecycle management
• Shared between forge loop and RPC handlers for delta exchange queries


src/libs/consensus/petri/forge/forgeInstance.ts
 





60. src/libs/consensus/petri/routing/shardMapper.ts
 ✨ Enhancement  +20/-0     



Shard mapper for transaction routing

• Maps account addresses to shard IDs for transaction routing
• Single-shard testnet implementation: always returns &#x27;default&#x27;
• Interface designed for future multi-shard expansion


src/libs/consensus/petri/routing/shardMapper.ts
 





61. src/libs/consensus/v2/routines/orderTransactions.ts
 ✨ Enhancement  +4/-1     



Deterministic transaction ordering with hash tiebreaker

• Added hash-based tiebreaker for deterministic transaction ordering when timestamps are equal
• Sorts by timestamp ascending, then by hash lexicographic comparison
• Ensures all nodes produce identical transaction order from same mempool state


src/libs/consensus/v2/routines/orderTransactions.ts
 





62. src/libs/consensus/v2/types/secretaryManager.ts
 📝 Documentation  +5/-0     



Secretary manager deprecation notice

• Added deprecation notice: SecretaryManager replaced by Petri Consensus leaderless coordination
• Kept for PoRBFT v2 fallback via feature flag
• Will be removed after Petri validation on testnet


src/libs/consensus/v2/types/secretaryManager.ts
 





63. src/libs/omniprotocol/protocol/handlers/consensus.ts
 📝 Documentation  +3/-0     



OmniProtocol consensus handlers deprecation notice

• Added deprecation notice for secretary-related handlers (opcodes 0x35-0x38)
• Handlers replaced by Petri Consensus, kept for PoRBFT v2 fallback
• Will be removed after Petri validation


src/libs/omniprotocol/protocol/handlers/consensus.ts
 





64. src/libs/consensus/v2/PoRBFT.ts
 📝 Documentation  +2/-0     



PoRBFT v2 consensus deprecation notice

• Added deprecation notice: PoRBFT v2 superseded by Petri consensus
• Retained as fallback via feature flag, will be removed after testnet validation


src/libs/consensus/v2/PoRBFT.ts
 





65. src/model/entities/Transactions.ts
 ✨ Enhancement  +4/-0     



Transaction entity Petri soft finality column

• Added soft_finality_at column (bigint, nullable) for Petri finality timestamp tracking
• Enables transaction entities to record soft finality timestamps


src/model/entities/Transactions.ts
 





66. src/libs/consensus/v2/types/validationStatusTypes.ts
 📝 Documentation  +3/-0     



Validation status types deprecation notice

• Added deprecation notice: replaced by Petri Consensus TransactionClassification types
• Kept for PoRBFT v2 fallback via feature flag


src/libs/consensus/v2/types/validationStatusTypes.ts
 





67. src/libs/network/endpointValidation.ts
  Formatting   +1/-0     



Endpoint validation formatting cleanup

• Minor formatting fix: added blank line before catch block


src/libs/network/endpointValidation.ts
 





68. petri/01-implementation-plan.md
 📝 Documentation  +494/-0     



Petri consensus implementation plan and phase documentation

• Comprehensive 494-line implementation plan for Petri Consensus phases 0-9
• Documents status, design decisions, current codebase structure, guiding principles
• Details all 9 phases with tasks, dependencies, acceptance criteria, and risk assessments
• Includes file structure, dependency graph, and phase execution guidance


petri/01-implementation-plan.md
 





69. petri/00-codebase-mapping.md
 📝 Documentation  +240/-0     



Petri consensus codebase mapping and architecture reference

• 240-line codebase mapping document correlating PoRBFT v2 code to Petri Consensus concepts
• Maps shard formation, RPC layer, transaction classification, continuous forge, block finalization
• Documents GCR state management, secretary transition, P2P communication, L2PS integration
• Includes impact assessment and file-by-file status (KEEP/REFACTOR/NEW/REPLACE)


petri/00-codebase-mapping.md
 





70. petri/consensus.md
 📝 Documentation  +222/-0     



Petri consensus implementation reference and flow documentation

• 222-line source-level reference for Petri consensus implementation
• Step-by-step flow from main loop dispatch through block finalization
• Documents secretary election, block compilation, deterministic ordering, accept-and-sign model
• Includes key invariants, configuration, and soak test results


petri/consensus.md
 





71. petri/VADEMECUM.md
 📝 Documentation  +273/-0     



Petri consensus operational guide and team mode handbook

• 273-line operational guide for building Petri Consensus
• Covers team mode operation, testing approach, reporting via Mycelium, safety guardrails
• Documents design decisions, file path references, autonomy/transparency expectations
• Includes phase execution checklist and architecture diagram update protocol


petri/VADEMECUM.md
 





72. TEAM.md
 📝 Documentation  +154/-0     



Team mode behavioral overlay for multi-agent collaboration

• 154-line team mode behavioral overlay for multi-agent engineering
• Defines Tech Lead role, agent tiers (You/Senior/Junior), dispatch protocols, verification workflow
• Documents anti-patterns, user interaction guidelines, edge cases
• Includes file-based persistence mechanism for compaction safety


TEAM.md
 





73. testing/TESTING_MAP.md
 🧪 Tests  +1/-0     



Petri consensus test suite registration in testing map

• Added Petri consensus to active/implemented/counted test categories
• References 186 unit tests with bun run test:petri command


testing/TESTING_MAP.md
 





74. .env.example
  Additional files   +10/-2     



...

.env.example
 





75. AGENTS.md
  Additional files   +8/-135     



...

AGENTS.md
 





76. data/genesis.json
  Additional files   +16/-0     



...

data/genesis.json
 





77. package.json
  Additional files   +1/-0     



...

package.json
 





78. petri/02-risks-and-considerations.md
  Additional files   +146/-0     



...

petri/02-risks-and-considerations.md
 





79. petri/03-secretary-coordinated-signing.md
  Additional files   +209/-0     



...

petri/03-secretary-coordinated-signing.md
 





80. petri/architecture-diagram.md
  Additional files   +1172/-0     



...

petri/architecture-diagram.md
 





81. petri/petri.md
  Additional files   +171/-0     



...

petri/petri.md
 





82. testing/devnet/.env.example
  Additional files   +3/-0     



...

testing/devnet/.env.example
 





83. testing/devnet/docker-compose.yml
  Additional files   +22/-8     



...

testing/devnet/docker-compose.yml
 










--- comment 2/2 ---
Time: 2026-03-23T12:33:09Z
Type: issue_comment
URL: https://github.com/kynesyslabs/node/pull/692#issuecomment-4110284505
Body:
ⓘ You are approaching your monthly quota for Qodo. Upgrade your plan


Code Review by Qodo





Looking for bugs?
Check back in a few minutes. An AI review agent is analyzing this pull request.




