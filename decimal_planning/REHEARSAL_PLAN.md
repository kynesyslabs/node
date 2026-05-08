# P5b Rehearsal Plan — DEM → OS Fork Activation on Devnet

**Phase**: P5b (post-typecheck-fix, pre-testnet).
**Target infra**: `testing/devnet/` (4 nodes + Postgres 16 + tlsnotary, docker-compose).
**Status**: Design only. Scripts to be written in the next phase.

---

## 0. Why this plan exists

The fork mechanism is unit-tested against SQLite in-memory: 52/52 tests pass in `testing/forks/`. That confirms the **logic** is sound. It does **not** confirm:

- The migration runs correctly on PostgreSQL 16 (text-based numeric arithmetic, JSONB casting, transactional rollback semantics).
- Real peer sync — gossip, block relay, mempool drain — handles the fork boundary.
- The `getNetworkInfo` RPC returns sane values across 4 independent nodes that may briefly disagree on `currentHeight`.
- A node that joins **after** the fork can replay history and end up converged.
- `BlockContent`'s genesis-hash invariance under added `forks` field actually holds in practice.
- The cap policy fires loud (and stays loud) when migration overflows the legacy backend.

Each scenario below maps to one of those gaps. Scripts will be `bash` driving `docker compose` + `bun` for SDK calls, `psql` for DB introspection, plus `curl` for RPC. No code attaches to the running node process.

---

## 1. Conventions used in this plan

- **Genesis variants**: we maintain 3 genesis files under `testing/devnet/scenarios/genesis/`:
  - `genesis-pre-fork.json` — current production layout, no `forks` field.
  - `genesis-fork-low.json` — `forks.osDenomination.activationHeight: 5` (fast cross-over for happy path).
  - `genesis-fork-overflow.json` — same as `-low.json` but with one balance entry seeded above the legacy cap (>9M DEM equivalent in JSONB legacy GCR).
- **Binary variants**: two image tags built from the docker-compose context:
  - `demos-devnet-node:pre-fork` — built from a commit at `decimals` branch tip **before** P3 fork machinery (or the equivalent feature-flag-disabled build). Used only in scenario 2 (desync) and 4 (genesis-hash invariance).
  - `demos-devnet-node:post-fork` — built from current `decimals` HEAD with all P3 + P5 changes. Default image for everything else.
- **Observation primitives**:
  - `psql` queries against `node{1..5}_db` (a fifth db is added in scenarios 3 and 4 by extending `postgres-init/init-databases.sql`).
  - RPC: `curl http://localhost:5355{1..5}/rpc/...` — at minimum `getLastBlock`, `getNetworkInfo`, `getAddressInfo`.
  - Logs: `docker compose logs node-N --since 1m` filtered with `grep -E '(fork|migration|cap|ABORT|ERROR)'`.
- **Repeatability**: every scenario starts with `docker compose down -v` (full state wipe) and ends with the same. We do **not** chain state across scenarios.
- **Driver script convention**: `testing/devnet/scenarios/<NN>-<slug>/run.sh` is the entry point, plus a sibling `expect.sh` that asserts pass/fail, returning non-zero on failure. A top-level `testing/devnet/scenarios/run-all.sh` runs them in the documented order and writes a JUnit-style summary.

---

## 2. Scenarios

### Scenario 1 — All-validators-cross-fork (the base case)

**Goal**: Prove that 4 fully-coordinated nodes can cross the fork, run the migration, and converge with matching post-fork balances. This is the minimum-viable success.

**Setup**:
- All 4 nodes use `demos-devnet-node:post-fork` image.
- All 4 nodes use `genesis-fork-low.json` (activation height = 5).
- Pre-seed each node's `node{1..4}_db` (via SQL fixture loaded after first startup, or via genesis `balances` if simpler) with the same 5-account distribution: 4 validator stakes (1000 DEM each) + 6 user balances (mixed: 100, 50, 0.5, 9_000_000, 0.000001, 1).
- Postgres clean.

**Action**:
1. `docker compose up -d` with `genesis-fork-low.json`.
2. Wait until all nodes report `getLastBlock.number >= 6` (one block past activation).
3. Snapshot every DB's `gcr_main`, `validators.staked_amount`, `global_change_registry.details`, `fork_state` table.

**Observation points**:
- `fork_state` row exists on all 4 nodes with `fork_name='osDenomination'`, `applied=true`, `migration_block_number=5`, identical `cappedCount` and `totalValueLostOs` (both should be 0 here).
- `getNetworkInfo` on each node returns `osDenomination.activated=true`.
- Block hash for block N (=5) matches across all 4 nodes (compare via RPC `getBlock?height=5`).
- Sum invariant: `Σ(post_balances) == Σ(pre_balances) × 10^9` per node; same sum across all 4 nodes.

**Success criteria**:
- All 4 `fork_state` rows are bit-identical (excluding `completed_at` timestamp).
- Block 5 hash identical across all 4 nodes.
- Sum invariant holds with zero cap losses.
- All 4 nodes still produce blocks past height 5 for at least 60 seconds.
- No error/panic strings in logs.

**Failure mode caught**: Postgres-specific bugs in the migration SQL (e.g., text-cast arithmetic differing from SQLite, JSONB path expression differences, transactional isolation issues), peer divergence on the fork boundary.

**Estimated runtime**: ~3 min (build cached).

---

### Scenario 2 — Validator desync recovery

**Goal**: Prove that an out-of-date validator can catch up by wiping its chain.db and re-syncing from genesis after the fork has already happened.

**Setup**:
- Nodes 1–3 on `demos-devnet-node:post-fork` + `genesis-fork-low.json`.
- Node 4 on `demos-devnet-node:pre-fork` + `genesis-pre-fork.json` (no `forks` field). Same identities/peerlist.
- Same pre-seeded balance distribution as scenario 1.

**Action**:
1. `docker compose up -d`.
2. Wait until nodes 1–3 cross height 5 and migrate; node 4 stays stuck (rejects post-fork blocks because its serializer can't validate them, or hard-errors because it doesn't know about `forks`).
3. Confirm node 4 is desynced: its `getLastBlock.number < 5` while peers are >5, or it's logging signature/hash failures.
4. `docker compose stop node-4`. Drop node 4's database: `psql ... -c "DROP DATABASE node4_db; CREATE DATABASE node4_db OWNER demosuser;"`. Replace node 4's image tag with `:post-fork` and its genesis with `genesis-fork-low.json` (compose override file).
5. `docker compose up -d node-4`.
6. Wait for node 4 to sync to current height.

**Observation points**:
- Logs on node 4 during step 3: should contain explicit hash mismatch or "unknown fork" error.
- Postgres `node4_db.fork_state` table after step 6: `applied=true`.
- Sum invariant on node 4 matches nodes 1–3.
- Block hash at height 5 on node 4 matches the other 3.

**Success criteria**:
- Node 4 fails LOUDLY in step 3 (we want a clear error in logs, not a silent stall).
- After wipe + restart, node 4 catches up within 60s of consensus time.
- All 4 nodes converge: identical block hashes for height 5, 6, …, current. Identical `fork_state` rows.

**Failure mode caught**: Re-sync after a wipe doesn't replay the migration on the catching-up node; or the migration runs but produces a different result because the catching-up node has a slightly different mempool snapshot. Also: regression in error-loudness — silent failure is worse than loud.

**Estimated runtime**: ~6 min (two upbringings + sync wait).

---

### Scenario 3 — Fresh node post-fork (HIGHEST STAKES)

**Goal**: Prove that a node that joins **after** the fork has already happened can sync the entire chain from genesis, including pre-fork blocks, and end up converged with the others. This validates the static-trace claim from the Senior investigation in Session 14 — that the migration hook fires correctly during replay.

**Setup**:
- Step 0 (preparation): extend `postgres-init/init-databases.sql` to also create `node5_db`. Extend compose with a `node-5` service that depends on node-1..4 being healthy. Give it port `53555` for RPC.
- Nodes 1–4 on `:post-fork` + `genesis-fork-low.json`. Same pre-seeded balances as scenario 1.
- Node 5 NOT started yet.

**Action**:
1. `docker compose up -d node-1 node-2 node-3 node-4`.
2. Wait for all 4 to cross height 5 and run the migration (same as scenario 1).
3. Let the network advance to height ~50 (post-fork by a comfortable margin), so node 5's sync has to replay both pre-fork and post-fork blocks.
4. `docker compose up -d node-5` (image `:post-fork`, genesis `genesis-fork-low.json`, empty `node5_db`).
5. Wait for node 5 to sync to current height.

**Observation points**:
- Node 5 log line "applying fork migration osDenomination at block 5" must appear (or whatever the equivalent log statement is).
- `fork_state` on node 5 after sync: `applied=true`, `migration_block_number=5`.
- Block hashes on node 5 for heights 1..5 (pre-fork) and 5..current (post-fork) match the other nodes exactly.
- Sum invariant on node 5: matches the other 4.
- `getAddressInfo` on node 5 for any seeded account returns identical balance to node 1.

**Success criteria**:
- Node 5 reaches current height within a reasonable timeout (e.g. 3 minutes).
- All hashes match. Sum invariant matches. No log errors or peer-rejection warnings.
- `fork_state` recorded with the same effective metadata (cap counts, etc.) as the original fork on nodes 1–4.

**Failure mode caught**: The static-trace claim is wrong. The migration hook fires during proposing/inserting NEW blocks but does not fire during historical replay, leaving node 5 with pre-fork balances while it tries to validate post-fork blocks. This is the highest-likelihood real bug.

**Estimated runtime**: ~7 min (network warmup + late-joiner sync).

---

### Scenario 4 — Genesis-hash invariance

**Goal**: Prove that adding a `forks` field to `genesis.json` does NOT change the computed genesis block hash. This validates the static-trace claim that `BlockContent` does not include `forks` and that an existing chain.db built before the field was added will still accept the new genesis.

**Setup**:
- Step 1: Bring up node 1 on `:pre-fork` image with `genesis-pre-fork.json` (no `forks` field). Let it produce blocks for ~30s.
- Step 2: `docker compose stop node-1`.
- Step 3: Swap genesis to `genesis-fork-low.json` (adds `forks` field, NO other changes). Swap image to `:post-fork`.
- Step 4: `docker compose up -d node-1` against the **same** `node1_db` (no DB wipe).

**Observation points**:
- Node 1's startup logs in step 4 must NOT contain a "genesis hash mismatch" error.
- The genesis row in `node1_db.blocks` table has the same hash as before (verify by capturing the hash in step 1 and comparing).
- Node 1 reaches its previous tip and continues producing blocks.

**Success criteria**:
- Node 1 starts cleanly. No mismatch logs.
- Genesis hash identical pre/post genesis-file edit.
- Chain continues from existing tip (no replay-from-zero).

**Failure mode caught**: `BlockContent` actually does include `forks` (or some other field that touches the hash). If this scenario fails, the entire fork-activation strategy needs to be redesigned because every existing node will reject the new genesis.

**Estimated runtime**: ~2 min.

---

### Scenario 5 — Cap policy fires loud

**Goal**: Prove that when the legacy GCR overflows the cap, the migration aborts loudly, the block doesn't apply, and `fork_state` records exact forensic data. Then prove that a retry path (either fix the seed or accept the cap) works.

**Setup**:
- All 4 nodes on `:post-fork` image.
- Genesis: `genesis-fork-overflow.json` — same as `-low.json` but seeds the legacy GCR JSONB column with one account holding `9_500_000` DEM (> the 9M cap derived from `Number.MAX_SAFE_INTEGER * 0.9 / 10^9`).
- `activationHeight = 5`.

**Action — Phase A (loud failure)**:
1. `docker compose up -d`.
2. Wait until nodes attempt to insert block 5.
3. Observe migration aborts on all 4 nodes.

**Action — Phase B (retry with cap accepted)**:
4. `docker compose down -v`.
5. Modify the genesis migration policy to accept the cap (or modify the seed to not overflow — pick whichever the policy says is the operator's intent).
6. `docker compose up -d`.
7. Wait for cross-fork.

**Observation points (Phase A)**:
- All 4 nodes log a clearly-formatted CAP / ABORT message identifying the offending account and the cap value.
- Block 5 is NOT in `node{1..4}_db.blocks` table (only blocks 0..4 exist).
- All 4 nodes are stuck at height 4. `fork_state.applied = false` (or row doesn't exist).
- `getNetworkInfo.osDenomination.activated = false` because we never crossed the height successfully.

**Observation points (Phase B)**:
- Cap is now logged but accepted. `fork_state.cappedCount > 0`, `totalValueLostOs > 0`, both identical across nodes.
- Migration applied. Block 5 in DB. Network resumes.

**Success criteria**:
- Phase A: nodes halt loudly, fork_state untouched, sum invariant on the existing rows still holds (because nothing was migrated).
- Phase B: cap forensics are bit-identical across all 4 nodes, network advances.

**Failure mode caught**: Migration silently truncates or silently succeeds when overflowing. If the cap policy fires-quiet, value is destroyed without operator awareness — that's the worst possible outcome for this migration. We must verify the **fail-loud** contract empirically on real Postgres, not just SQLite.

**Estimated runtime**: ~5 min (two cycles).

---

### Scenario 6 — Mid-flight transactions across the boundary

**Goal**: Prove that transactions submitted by SDK v3 clients in the immediate vicinity of the fork height land correctly. Specifically: a tx submitted while the network is at height N-1 ends up in a post-fork block; the SDK pre-flight `getNetworkInfo` returns the correct `activated` state at submission time; the tx is accepted.

**Setup**:
- All 4 nodes on `:post-fork` image, `genesis-fork-low.json` with `activationHeight = 10` (slightly higher to give us room to send the tx before fork).
- Pre-seeded balances as in scenario 1.

**Action**:
1. `docker compose up -d`.
2. While network is at height 8 or 9 (poll via `getLastBlock`), use SDK v3 (or a curl-driven RPC) to submit one transfer of 1 DEM (= 10^9 OS) from sender to recipient.
3. Wait for the tx to be confirmed.
4. Inspect which block it landed in.

**Observation points**:
- The tx's `content` shape on the wire (capture via RPC `getMempool` immediately after submission, before it confirms): `amount` field as DEM-number if SDK detected pre-fork, OS-string if post-fork.
- Block height at which the tx is included: should be either the last pre-fork block (9) or the first post-fork block (10).
- If included at 10: the migration ran first, so the sender's balance available for spending is `(pre × 10^9) - amountSpent`. Verify with `getAddressInfo`.
- Recipient balance after confirmation matches expected post-fork value.
- All 4 nodes agree on the resulting balances (sum-check).

**Success criteria**:
- Tx accepted, included in a block, balances correct on all 4 nodes.
- No "signature invalid" or "format mismatch" errors in logs near the boundary.

**Failure mode caught**: Mempool drain edge cases — a tx serialized in pre-fork format while the validator picking it up is post-fork (or vice versa). Hash/signature mismatch races at the boundary.

**Estimated runtime**: ~3 min.

---

### Scenario 7 — Sum invariant audit

**Goal**: Independently verify the sum-invariant claim on real Postgres by computing pre- and post-fork totals across all three balance backends (`gcr_main.balance`, `validators.staked_amount`, legacy `global_change_registry.details.content.balance`) and asserting `Σ(post) = Σ(pre) × 10^9 - Σ(capLosses)`.

**Setup**:
- All 4 nodes on `:post-fork` + `genesis-fork-low.json`. Activation height = 10.
- Pre-seeded: a non-trivial distribution including some legacy-backend accounts (under the cap), some GCRv2 accounts, and some validator stakes.

**Action**:
1. `docker compose up -d`.
2. While network is below height 10, run the snapshot script: dumps `Σ` of each backend on each node into `pre.json`.
3. Wait for height 10+ on all 4.
4. Run snapshot script again: `post.json`.
5. Run the assertion script: for each node, `post == pre × 10^9 - capLosses` (capLosses retrieved from `fork_state`).

**Observation points**:
- Pre and post sums per backend per node.
- Cap losses recorded in `fork_state.totalValueLostOs`.
- Cross-node consistency: identical pre, identical post.

**Success criteria**:
- Invariant holds exactly on all 4 nodes.
- All 4 nodes' pre-sums match each other (consistency before the fork).
- All 4 nodes' post-sums match each other (consistency after).

**Failure mode caught**: Migration multiplies one backend but not another (e.g., misses validator stakes, or double-multiplies legacy-GCR via JSONB path bug). The unit tests assert this in SQLite; this scenario asserts it in Postgres with realistic seeded distribution.

**Estimated runtime**: ~3 min.

---

### Scenario 8 — Re-sync after fork without DB wipe

**Goal**: A node that had already synced through the fork crashes and restarts. Verify it does NOT re-run the migration (idempotency), picks up correctly, and continues producing/validating blocks.

**Setup**:
- All 4 nodes on `:post-fork` + `genesis-fork-low.json` (activation 5). Pre-seeded balances.

**Action**:
1. `docker compose up -d`.
2. Wait for cross-fork on all 4.
3. Snapshot `fork_state` and a sample of `gcr_main` from node 4.
4. `docker kill demos-devnet-node-4` (ungraceful shutdown).
5. `docker compose start node-4`.
6. After node 4 reconnects, snapshot `fork_state` and the same `gcr_main` sample again.

**Observation points**:
- `fork_state.applied = true` both before kill and after restart, with identical `completed_at` timestamp (proving migration was NOT re-run — it would update the timestamp if it had).
- Sample balances unchanged (proving they weren't multiplied by 10^9 a second time).
- Node 4 catches up to peers within consensus_time × small N.
- No "applying fork migration" log line during restart.

**Success criteria**:
- `fork_state` row identical pre/post crash.
- Sample balances identical pre/post crash.
- No re-migration log line.

**Failure mode caught**: Idempotency gate is broken — migration runs twice, balances become DEM × 10^18, network state diverges fatally. This is the doomsday bug. Catching it here on devnet beats catching it on testnet.

**Estimated runtime**: ~3 min.

---

## 3. Summary table

| # | Name | Stakes | Validates | Runtime |
|---|---|---|---|---|
| 1 | All-validators-cross-fork | Base case | Postgres migration runs, peer convergence | 3 min |
| 2 | Validator desync recovery | High | Wipe + re-sync path; loud failure on stale binary | 6 min |
| 3 | Fresh node post-fork | **HIGHEST** | Migration runs during historical replay | 7 min |
| 4 | Genesis-hash invariance | High | `BlockContent` doesn't include `forks` | 2 min |
| 5 | Cap policy fires loud | High | Fail-loud contract on Postgres | 5 min |
| 6 | Mid-flight transactions | Medium | Boundary-block tx handling | 3 min |
| 7 | Sum invariant audit | Medium | All 3 backends migrated together | 3 min |
| 8 | Idempotent restart | **HIGHEST** | No double-migration on crash recovery | 3 min |

**Total wall-clock if run sequentially (with 30s tear-down between)**: ~37 min.

---

## 4. Proposed run order

Some scenarios depend on others passing first:

1. **Scenario 4** — Genesis-hash invariance. **Must run first.** If this fails, every other scenario is wasted because the entire fork model is wrong.
2. **Scenario 1** — All-validators-cross-fork. The base case. If this fails, nothing else is reachable.
3. **Scenario 7** — Sum invariant audit. Builds confidence that the migration math is correct on Postgres, before stressing it.
4. **Scenario 8** — Idempotent restart. Cheap, catches the doomsday-bug class.
5. **Scenario 5** — Cap policy fires loud. Standalone, runs on its own genesis.
6. **Scenario 6** — Mid-flight transactions. Requires baseline migration to work.
7. **Scenario 2** — Validator desync recovery. Slowest, requires both image variants.
8. **Scenario 3** — Fresh node post-fork. **Highest stakes**, most expensive setup, runs last so any earlier failure short-circuits.

`run-all.sh` should `exit 1` on the first failure, with explicit notice that subsequent scenarios were skipped.

---

## 5. Risk register — what this rehearsal does NOT cover

| Risk | Why it's not covered | Mitigation |
|---|---|---|
| Production-scale validator count | Devnet runs 4 nodes; production runs ~dozens. Convergence under heavy peer count not exercised. | P6 sustained testnet run (>10 nodes) gates production. |
| Production Postgres tuning | Devnet uses default `postgres:16-alpine`. Production may have different `work_mem`, replica configs, vacuum schedules. | Capture migration wall-clock on devnet as a floor; multiply by 10x and review against ops constraints. |
| Real-world balance distribution | Seeded fixtures are synthetic. Real chain has long-tail account distribution. | P5/P6: take a snapshot of testnet GCR, replay it through a migration dry-run before production fork. |
| Network partitions / Byzantine peers | Devnet network is an idealized Docker bridge. No latency, packet loss, or malicious peer simulation. | Out of scope for P5b. Captured under Risk Register P0 — accepted. |
| SDK v2 talking to post-fork node | Considered as scenario 9, see §6. | Skipped — covered by P4 SDK contract test. |
| Long-running stability past fork (>1 day) | Each scenario runs minutes, not days. Memory leaks, slow disk-fill, validator-set churn over time not observable. | P6 sustained testnet run. |
| TLSNotary integration during fork | tlsnotary is part of devnet but no scenario exercises a notarization across the boundary. | Out of scope; tlsnotary doesn't touch balances. Add to P6 if user requests. |
| Production identity rotation / key changes | Devnet uses static identities. | Out of scope. |
| Genesis with thousands of balance entries | Synthetic genesis is small. JSONB widening may behave differently at scale. | Capture migration timing per row count; extrapolate. Add to P6 dry-run if extrapolation is concerning. |

---

## 6. Scenarios considered but cut

- **SDK v2 talking to post-fork node** (originally on the spec): cut from this rehearsal because P4 already shipped a contract test in the SDK repo (Session 13, `wireFormat.spec.ts`) that covers the case at the SDK boundary. Re-running the same check at the devnet level adds no new signal. If the user disagrees, it slots in between scenarios 5 and 6 and adds ~3 min.
- **Mempool flush during reorg across fork**: cut because devnet doesn't easily reproduce reorgs without a custom Byzantine harness. Best handled in P6 testnet under real adversarial conditions.
- **Storage-program / IPFS fee migration end-to-end**: cut because storage-program writes go through the same `gcr_edits[]` path that scenario 6 exercises; running it twice on different programs adds no new code path coverage.

---

## 7. Operational notes for the script-implementation phase

- **Build caching**: the two image variants (`:pre-fork`, `:post-fork`) should be built once at the top of `run-all.sh` and tagged. Each scenario's `run.sh` does `docker compose down -v` but reuses the cached images.
- **Genesis swap**: avoid editing `data/genesis.json` in-place. Use a compose override file per scenario (`docker-compose.scenario-<NN>.yml`) that mounts the right `genesis-*.json` over the default.
- **Wait helpers**: provide a `scripts/wait-for-height.sh <node> <target-height> <timeout>` and `wait-for-fork-applied.sh <node> <fork-name>` so scenario scripts read clearly.
- **DB introspection**: provide `scripts/db-query.sh <node-N> <sql>` that wraps `docker exec demos-devnet-postgres psql -U demosuser -d node{N}_db -t -A -c "<sql>"`.
- **Pass/fail reporting**: each scenario writes `result.json` `{ "scenario": "...", "status": "pass"|"fail", "duration_s": N, "evidence": [...] }`. `run-all.sh` aggregates.
- **No flake tolerance**: any scenario that's flaky should be redesigned, not retried. Fork mechanics are deterministic; if the rehearsal isn't deterministic, we have a bug.

---

## 8. Definition of done for P5b

- All 8 scenarios pass on a clean checkout of the `decimals` branch with the post-typecheck-fix tip.
- `run-all.sh` produces a green summary in under 45 minutes wall-clock on a developer laptop.
- The summary report is committed to `decimal_planning/REHEARSAL_RESULTS_<date>.md` (next phase produces it).
- Any failure during execution surfaces a clear log excerpt and the offending DB query result.
- The plan in this document is updated with any deviations discovered while writing the scripts.
