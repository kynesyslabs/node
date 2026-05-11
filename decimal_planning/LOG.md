# Decimal Migration — Logbook

## Session 1 (2026-05-01)

### State
- Team Mode: ON (Tech Lead)
- Branch: `decimals`
- IDEA.md moved into `decimal_planning/` (was at repo root)

### What happened
- User shared IDEA.md: a 10-phase plan to migrate `@kynesyslabs/demosdk` from DEM (number) to OS (BigInt, 9 decimals, 1 DEM = 10^9 OS).
- Wire format: OS as decimal string. Internal: BigInt. Breaking change, major version bump.
- I started a coherence audit (Senior dispatched to verify SDK paths/shapes vs. doc claims) — interrupted by user due to context budget.
- Pivoted to scaffolding: this directory + LOG + NEXT_STEPS, defer the audit to next session.

### Open questions (to resolve before implementation)
1. **Scope ambiguity**: IDEA.md is written for the SDK repo (`../sdks/`). But this is the **node** repo. The node stores balances, computes fees, and serializes transactions too. Migration must be coordinated:
   - SDK changes wire format (number → OS string)
   - Node must accept/emit the new wire format
   - Both must agree on the same cutover, or one breaks the other
2. **Transaction hashing/signing**: changing `amount: number` → `amount: string` changes the hash. Any in-flight transactions or stored history will be invalidated unless this is handled at a network reset boundary.
3. **Existing BigInt usage**: doc assumes greenfield. Need to verify nothing already does this conversion.
4. **Path verification**: doc references `/app/docs-repo` paths and warns to check `../sdks/` — none of the file paths in the doc are verified against actual source yet.

### Decisions made
- Track this work in Mycelium (per AGENTS.md). Epic + phase tasks. Will create on next session start.
- Use `decimal_planning/` as the working dir for all planning artifacts (refined spec, audit reports, diagrams).
- Don't touch any code until coherence audit completes.

## Session 2 (2026-05-01, continued)

### State
- Three audits dispatched in parallel and completed: `audit_sdk.md`, `audit_node.md`, `surface_scan.md`.
- Hard-fork feasibility investigated: `forking_feasibility.md` — verdict M-sized, infrastructure ready.
- User answered the 7 open questions:
  1. Storage today is DEM — needs ×10^9 migration
  2. No hard-fork machinery — build minimal one (in scope)
  3. Self-contained SDK phases = strong reading (publishable + back-compatible with then-current node)
  4. Pre-fixes as Phase −1, separate PRs
  5. SDK pin is `^2.11.4` (caret), `upgrade_sdk` script uses `--latest`
  6. IPFS `max_cost_dem` was actually DEM — convert + rename to `max_cost_os`
  7. Tests in `testing/`
- Drafted `SPEC.md` — the implementable, dual-repo, cutover-aware plan.

### What SPEC.md contains
- Hard-fork-at-block-N strategy with state migration (×10^9) at activation
- 9 phases (P-1 through P8) with explicit publish gates
- Dual-rule serializer approach in node (P3) so SDK v3 can be published before production fork activation
- One open question for user before P4 starts: SDK-v3-vs-pre-fork-node compatibility — option (a) dual-serializer with detection, or (b) clean error. Recommendation: (b).
- Risk register, test strategy, Mycelium scaffolding instructions.

### Decisions made
- IDEA.md phases 1–7 collapse into a single SDK release (P4) because partial type migration cannot be self-contained per the strong-reading constraint.
- Node leads SDK on wire-format readiness: P2/P3 land dual-rule support before SDK v3 ships.
- Hard fork over network reset confirmed (preserves history, reusable pattern, infrastructure ready).
- Dual-format acceptance window ruled out (signatures commit to bytes; cannot validate same tx in two formats).

## Session 14 (2026-05-07, SDK published as 3.1.0, P5 starting)

### State
- SDK shipped as **3.1.0** (skipped rc tag, promoted straight to release per user decision).
- Node `package.json` updated to `"@kynesyslabs/demosdk": "3.1.0"` (exact pin).
- PR-86 review queue fully drained (11 fixed, 2 dismissed, all GitHub threads resolved).
- `bun run type-check-ts` shows **12 errors** post-bump — the expected boundary mismatches per SPEC P5 task list:
  - `chainTransactions.ts` — `Transactions` entity `amount: bigint` vs SDK `RawTransaction.amount: string | number`
  - `executeNativeTransaction.ts:42` — `>` on `string | number` and `number`
  - `subOperations.ts:62` — `number` not assignable to `bigint`
- All 52 tests in `testing/forks/` were green pre-bump; need to re-confirm post-bump as part of P5.

### Outstanding workspace state
- Unstaged: `package.json` (SDK bump), `decimal_planning/LOG.md` (this file), `.gitignore`, untracked `decimal_planning/SPEC_P4.md`. To commit at end of P5.

### Next: P5
- Fix the typecheck fallout from SDK 3.1.0 → 12 errors at the entity/SDK boundary (need explicit BigInt() conversions or update type signatures consistently)
- Run all tests, confirm they're still green
- Set testnet `forks.osDenomination.activationHeight` to a concrete near-future block
- Run testnet through the fork height; observe migration runs, balances multiply, hashes align with SDK serializer

## Session 13 (2026-05-07, P4 complete — awaiting publish)

### State
- P4 implemented on SDK branch `decimals-p4` (in `/Users/tcsenpai/kynesys/sdks/`). 4 commits, isolated from `main`.
- Round-trip hash equality test PASSES against the node's serializer algorithm — strongest pre-testnet signal we have.
- Sub-DEM precision rejection works.
- RPC failure fallback warn-once verified.
- 36 SDK files touched, 8 new files added, +2550/-205 lines, 76/76 tests pass.

### P4 commits (SDK repo, `decimals-p4` branch)
- `acf56a4 feat(types,construction): widen amount/fee/balance fields to OS string + bigint internal arithmetic`
- `2fca411 feat(serializer): dual-format serializerGate matching node's wire format`
- `6a1e485 feat(rpc): getNetworkInfo fork detection + sub-DEM guard + public API bigint`
- `102d23e chore(release): tests + 3.0.0-rc.1 + jsdoc + migration guide`

### Findings to remember
1. **`bigint` in `tx.content.data`** — `JSON.stringify` rejects bigints, so `data` field is wire-shaped at construction time, not at serializer. Same pattern as `gcr_edits[]`. Caught by `wireFormat.spec.ts`.
2. **Bun loader + type-only barrel re-exports** — type-only `export { Foo }` reachable through transitive imports trips Bun's runtime module loader. Senior split tests: Bun for pure unit, Jest for integration. Avoided a churny refactor of unrelated barrels. Documented in commit 4.
3. **getAddressInfo zero-balance FIXME RESOLVED** — fixed in passing during P4 commit 4 JSDoc sweep (`info.balance ?? 0` before `BigInt(...)`). This was on our backlog from Session 4.
4. **Round-trip hash equality** holds for 5 fixture variants (OS-string, legacy DEM-number, bigint-normalized, non-canonical-OS, pre-fork). Object spread idiom preserves key order: `[type, from, to, amount, data, nonce, timestamp, transaction_fee, from_ed25519_address, gcr_edits]`.

### Awaiting
P4 publish gate. User to:
1. Optional review: `git diff main..decimals-p4` in SDK repo
2. Merge `decimals-p4` into `main` (or chosen ship path)
3. `bun publish --tag rc` (publishes as `3.0.0-rc.1` with rc tag — won't auto-pull via `^3.0.0`)
4. Confirm published version → P5 unblocks

### Next: P5
Node bumps SDK pin to `3.0.0-rc.1` (exact pin, escape caret), sets testnet `forks.osDenomination.activationHeight`, runs testnet through fork height. First real integration test of the dual-format pipeline.

## Session 15 (2026-05-09, P5b + P5c complete — ready to ship)

### State
- **Epic #7 (P5b rehearsal)** fully closed: 4/4 tasks done, all 8 rehearsal scenarios PASS in Run 5.
- **Epic #8 (P5c runbook)** fully closed: 2/2 tasks done. RUNBOOK_FORK_ACTIVATION.md (2293 words, evidence-cited) and `testing/forks/preflight.ts` (197 lines, exits 1 on validator-unready).
- Branch `decimals` is 28 commits ahead of origin. Nothing pushed.

### What's empirically validated
- Fork mechanism works on real Postgres at production-genesis magnitude (gcr_main.balance widened to numeric in P5a fix)
- All 4 validators converge on identical block-N hashes
- Fresh validator joins post-fork and replays through fork via Sync.ts → Chain.insertBlock → migration hook (Run 5 Scenario 3, the load-bearing one)
- Cap policy fires loudly with `[forks][osDenomination] CAP applied: account=<addr>` log when triggered
- Idempotent across crash + restart (fork_state.applied flag prevents re-run)
- Genesis-hash invariance: adding `forks` field to genesis.json doesn't change BlockContent hash (Run 5 Scenario 4)

### Two operational notes uncovered during P5c
1. **No `bun run build` script in package.json** — runbook's §2 prerequisites mention it but it doesn't exist. Closest artifact is `tsconfig.tsbuildinfo`. Pre-flight script uses its mtime as freshness signal. Worth aligning runbook on next pass.
2. **Env var inconsistency**: rehearsal harness uses `POSTGRES_USER` etc.; production node uses `PG_USER`. Pre-flight script uses production names. Operators should be aware when configuring.

### What's missing to merge
The migration is implementation-complete and validated. Remaining work is operational, not engineering:
1. Open PR for `decimals` → `main` (or whatever the merge target is)
2. Pick a fork height N (per runbook §3 framework)
3. Validators run pre-flight script, confirm all-green
4. Update each validator's `data/genesis.json` with the agreed N
5. Coordinate restarts at T-1h
6. Observe block N crossing per runbook §4

### Closed Mycelium tasks
- #71, #72, #73, #74 all closed in this session
- Epic #7 + Epic #8 both at 0 open tasks
- Epic #3 (master DEM→OS migration) still has tasks #23-#27 (P4-P8) open as bookkeeping; P4-P5 are functionally done (closing those tomorrow as cleanup)

## Session 12 (2026-05-06, P3 fully complete — switching to SDK side)

### State
- All four P3 sub-phases done: P3a (post-fork serializer), P3b (state migration), P3c (getNetworkInfo RPC), P3d (integration tests).
- Mycelium #22 (P3) closed.
- Branch `decimals` is now 21 commits ahead of main.
- 52/52 tests in `testing/forks/` (49 unit + 3 integration). Lint clean, typecheck baseline (11) preserved. Bit-identical regression intact.
- Production behavior bit-identical to pre-fork-machinery state (fork inactive by default).

### Latent ESM circular import (out of scope, recorded)
`forkHandlers → sharedState → Peer → manageNodeCall → handlers/index → forkHandlers`. Workaround: tests route via `handlerRegistry` instead of importing `forkHandlers` directly. Pre-existing in the codebase (governanceHandlers / peerHandlers do the same import pattern). Clean fix would be `import type { NodeCall }` in `Peer.ts`. Not chasing now.

### Commits added in P3 (8 total)
- `c6b91c57 feat(forks): add ForkState entity and TypeORM migration` (P3b)
- `16732481 feat(forks): implement osDenomination state migration with cap policy` (P3b)
- `f21e59e7 feat(forks): hook fork migrations into Chain.insertBlock` (P3b)
- `fff62854 test(forks): osDenomination migration tests` (P3b)
- `e497cd5a docs(decimal_planning): add post-staking-merge investigation report`
- `e142bcce feat(forks): add getNetworkInfo RPC handler` (P3c)
- `ee4254ea test(forks): getNetworkInfo handler tests` (P3c)
- `af3b7a4b test(forks): integration tests for fork pipeline` (P3d)

### Next: P4 — SDK v3.0.0-rc.1
This is the next **publish gate**. Per SPEC option (a) dual-format SDK design:
- SDK ships both serializers (DEM-number for pre-fork nodes, OS-string for post-fork)
- SDK calls `getNetworkInfo` to detect node fork status, caches per `Demos` instance
- Pre-fork transfer rejects sub-DEM precision with hard error (no silent value loss)
- Collapses IDEA.md phases 1–7 into one shippable SDK release
- Adds gcr_edits[] amount migration (the flag from Session 9)

P4 is in the SDK repo (`/Users/tcsenpai/kynesys/sdks/`). When it ships → user publishes v3.0.0-rc.1 with `--tag rc` → P5 (node bumps SDK pin to RC, sets testnet fork height) → P6 (sustained testnet) → P7 (final v3.0.0) → P8 (production fork).

## Session 11 (2026-05-06, P3b complete)

### State
- Stabilisation/staking PR merged into `decimals` (merge commit `4b099c5d`).
- P3a regression confirmed intact post-merge (31/31 tests still pass).
- Re-investigation report: `decimal_planning/audit_node_post_staking.md`. Headline: `Validators.stake` was renamed to `Validators.staked_amount` (text/bigint-as-string), DEM-denominated, written via `GCRValidatorStakeRoutines.apply()`. Migration must include this column.
- User decisions locked:
  - **Q1** — Cap policy for legacy GCR overflow (set to 90% of `Number.MAX_SAFE_INTEGER`, log every cap, record `cappedCount` and `totalValueLostOs` in fork_state audit row)
  - **Q2** — Migration runs **inside** the same TypeORM transaction as block save (atomic)
  - **Q3** — `NetworkUpgradeVote.weight` immutable at snapshot, no tally-time adjustment
- P3b shipped in 4 commits (`c6b91c57`..`fff62854`):
  - `feat(forks): add ForkState entity and TypeORM migration`
  - `feat(forks): implement osDenomination state migration with cap policy`
  - `feat(forks): hook fork migrations into Chain.insertBlock`
  - `test(forks): osDenomination migration tests`
- Plus `e497cd5a docs(decimal_planning): add post-staking-merge investigation report`.

### What's verified
- Cap value: `LEGACY_NUMBER_CAP = 8_106_479_329_266_892n` OS = `BigInt(Math.floor(Number.MAX_SAFE_INTEGER * 0.9))`
- 11/11 new migration tests pass, including: cap behavior (test 4), idempotency throw (7), outer-transaction rollback (8), atomicity on poison row (9), empty-chain edge case (1)
- 42/42 in `testing/forks/` overall (31 baseline + 11 new)
- Lint clean, typecheck baseline (11) preserved, no new errors
- Bit-identical regression PASS: production behavior unchanged when `activationHeight: null`
- Hook integration: atomic per Q2, no invasive refactor needed (existing `dataSource.transaction(em => ...)` block in `chainBlocks.insertBlock:218` was already in place)
- Migration runs **before** block transactions execute, so the triggering block's txs see post-fork (OS) balances

### Test infrastructure note
P3b introduced `placeholder()` helper for portable raw queries (Postgres `$N` / SQLite `?`). Tests use SQLite in-memory; production uses Postgres. `ON CONFLICT` syntax is identical across both for fork_state UPSERT.

### Closed Mycelium tasks
- #22 (P3) — close on next session start (P3a + P3b done; P3c and P3d still ahead in current session)

Wait — P3 is task #22 covering all of P3a/b/c/d. P3c (`getNetworkInfo` RPC) and P3d (integration tests) still pending. Keep #22 open.

### Next: P3c
SDK-facing fork-status RPC. Per SPEC option (a) dual-format SDK design:
- Endpoint: `getNetworkInfo` (or extend an existing one)
- Returns: `{ forks: { osDenomination: { activationHeight: number | null, activated: boolean, currentHeight: number } } }`
- `activated` = `currentHeight >= activationHeight && activationHeight !== null`
- Reads from `SharedState` only — no DB query, must be cheap
- Used by SDK v3 (P4) to decide which serializer to send

## Session 10 (2026-05-01, paused for staking PR)

### Why
P3b investigation surfaced `Validators.stake` (DEM-denominated `integer` column on `Validators` entity) with no writer in the current code. A staking PR is in approval that adds the write side. Migrating consensus-relevant state without seeing the final staking design risks corrupting validator sets at fork.

User decision: pause here, wait for staking PR to merge into `stabilisation`, pull it, then revisit P3b investigation with complete picture.

### State preserved
- 12 commits on `decimals` branch (P-1 + P0/P1 + P2 + P3a). All independently valid.
- 31/31 tests pass in `testing/forks/`.
- Lint clean, typecheck baseline (11 errors) preserved.
- `decimal_planning/PAUSED.md` written with full resume protocol.
- Mycelium: P-1, P0, P1, P2 closed. P3a closed (need to do). P3b open (the blocker).

### Cleanup
- Discarded 45 files of formatter-noise unstaged edits from the P3b investigation Senior. Workspace clean.
- No P3b code was written — only investigation. Nothing to revert in commits.

### Resume target
When staking PR lands: read PAUSED.md → pull staking → re-run P3a regression → re-investigate `Validators.stake` with staking PR design → resume P3b implementation.

## Session 9 (2026-05-01, P3a complete)

### State
- P3a done in 2 commits (`2b2d2ece`, `974b361b`). Branch is now 12 commits ahead of main.
- 13 new tests, total 31/31 in `testing/forks/`. Bit-identical regression for default (inactive) config still passes.
- Validators: P-1's `BigInt()` coercions already handle both number and string inputs. No P3a-specific validator work needed.
- BlockContent: verified to have no amount/fee fields. Post-fork block branch is a deliberate no-op (kept structurally for future forks).
- Canonical wire key order observed: `type, from, to, amount, data, nonce, timestamp, transaction_fee, from_ed25519_address, gcr_edits`. Insertion-order preservation via `{ ...content }` spread is sufficient (no explicit canonicalization needed; matches pre-fork behavior).

### Open finding for P4
`tx.content.gcr_edits[]` entries carry per-entry `amount: number` (DEM) today. Senior flagged this for review. Resolution:
- The "mixed v2 SDK + post-fork node" scenario is explicitly rejected per SPEC option (a) — SDK v3 detects fork status and refuses to send v2-format to post-fork nodes
- SDK v3 (P4) must produce gcr_edits with OS-string amounts as part of its type migration
- **Action item for P4 brief**: explicitly list gcr_edits as a migration target — not just top-level amount/fees
- **No action in P3a**: gcr_edits format is the SDK's responsibility, not the node serializer's

### Next: P3b (state migration script)
Most consensus-sensitive piece. Multiplies every account balance by 10^9 at fork activation. Two backends to handle (Session 5 finding):
1. GCRv2 `gcr_main.balance: bigint` — direct multiplication
2. Legacy `GlobalChangeRegistry` JSONB column (number) — must widen + multiply, may need MAX_SAFE_INTEGER pre-check
Sum invariant: `Σ(post) = Σ(pre) × 10^9`. Idempotency flag in DB.

## Session 8 (2026-05-01, P2 complete, P3 planning)

### State
- P2 landed in 6 logical commits (`2891f745`..`a5e28183`). Branch `decimals` is now 10 commits ahead of main.
- 18 new tests in `testing/forks/`. Bit-identical regression confirmed at heights 0, 1, 1M, 999_999_999, with fork forcibly active too (placeholder branch returns identical bytes — P3 will fill it in).
- Audit corrections (recorded so we don't trust the audit blindly in P3):
  - 7 tx hash sites (not 6): audit missed `signalingServer.ts:664`
  - audit's `transaction.ts:192` was a debug log; actual sites are 91, 108, 269
  - Senior's confirmed list of 7+2 sites is canonical for P3
- `findGenesisBlock` loads fork config before the early-return so existing nodes pick up new fork heights on restart, not just on first init.
- `Transaction.sign/hash/isCoherent` got optional `blockHeight` param defaulted to `getSharedState.lastBlockNumber ?? 0`. Callers can override when they know the owning block (P3 will).

### P3 split decision
P3 is too large for one Senior dispatch. Splitting into 4 sub-phases:
- **P3a**: Dual serializer (the post-fork branch becomes real) + dual validators (amount/balance/fee BigInt-typed post-fork)
- **P3b**: State migration script (×10^9, sum invariant, dual-backend: GCRv2 bigint AND legacy GlobalChangeRegistry JSONB number) + auto-trigger hook on first sight of block ≥ activationHeight
- **P3c**: `getNetworkInfo` RPC for SDK fork detection
- **P3d**: Integration tests in `testing/`: snapshot replay, hash distinctness pre/post fork, fork-boundary edge cases

Each sub-phase is its own Senior dispatch, separate commits, independently reviewable. Mycelium task #22 covers all four; will close when all done.

### Closed Mycelium tasks
- #21 (P2) closed

## Session 7 (2026-05-01, P0+P1 complete, P2 starting)

### State
- SDK v2.12.0 published with denomination utilities. Node bumped from `^2.11.4` → `2.12.0` (exact pin to avoid caret drift across major bumps later).
- Node P1 commit: `f140a0c7 chore(deps): bump demosdk to 2.12.0`. **Zero conversion sites needed replacement** — exhaustive grep confirmed audit_node.md:129's claim that node has no DEM↔OS math today. Conversion is **introduced** in P3.
- Typecheck baseline now 11 errors (down from 32 post-P-1; some dropped naturally from the SDK bump's cleaner types).
- SDK import idiom confirmed: `import { denomination } from "@kynesyslabs/demosdk"` then `denomination.demToOs(x)`. Namespace-only, no flat re-export.

### Closed Mycelium tasks
- #19 (P0) closed
- #20 (P1) closed

### Next: P2 — node hard-fork machinery
Per `forking_feasibility.md`: M-sized, ~2 person-days. All infrastructure already in place:
- Block height threaded through validation (`confirmTransaction` line 30-35)
- Block height in `createBlock` as formal param
- 6 transaction hash sites + 2 block hash sites identified — all use `JSON.stringify(content)` pattern
- Single chokepoint per category, easy gate insertion

P2 is gate-only — `isForkActive(name, height)` always returns false because `activationHeight: null`. Behavior must be bit-identical post-P2.

## Session 6 (2026-05-01, P0 publish gate)

### State
- P0 SDK changes (`f951fbc`) merged with upstream (`af1c7c9`) on SDK main branch.
- Verified merge didn't touch P4 hot spots (getAddressInfo, transfer, TxFee, amount, balance semantics unchanged).
- Build clean post-merge, all 11 denomination tests pass.
- User published v2.12.0 to npm.

## Session 5 (2026-05-01, P-1 complete)

### Status
- All three P-1 commits landed:
  - `438ade1f` fix(consensus): use BigInt instead of parseInt in subOperations
  - `c343d426` fix(model): widen Transactions fee columns from integer to bigint
  - `cf798bad` fix(gcr): coerce editOperation.amount to BigInt at routine boundary
- Lint clean on touched files. Repo-wide TS error count bit-identical to baseline (32 errors, all pre-existing).
- TypeORM migration `WidenFeeColumnsToBigint1714521600000` created at `src/migrations/`.

### Important finding flagged for P3
Senior discovered that `getGCRNativeBalance` was reading `details.content.balance` from the **legacy** `GlobalChangeRegistry` JSONB column typed as `number` — not the GCRv2 `GCRMain.balance: bigint` the audit assumed. This means **two storage backends** must be migrated in P3:
1. GCRv2 `gcr_main.balance` — already bigint, just multiply by 10^9
2. Legacy GlobalChangeRegistry JSONB — currently `number`, must be widened AND multiplied
P-1 added a `MAX_SAFE_INTEGER` guard in `setGCRNativeBalance` so the legacy path fails loudly instead of silently truncating, but the dual-backend migration is now an explicit P3 requirement.

### Pre-existing issues out of scope (deferred)
- `subOperations.ts:62` — `transaction.amount = 0` against `bigint` entity field (broken before P-1).
- `chainTransactions.ts`/`chainBlocks.ts` — `Repository<Transactions>.save(RawTransaction)` typing mismatch where SDK `RawTransaction` types fees/amounts as `number` but entity is `bigint`. Resolves naturally in P4 (SDK type migration).
- `getAddressInfo` zero-balance FIXME — deferred to P3 per Session 4 decision.

### Closed Mycelium task
- #18 (P-1) → close on next session start: `myc task close 18`

## Session 4 (2026-05-01, P-1 start)

### Scope adjustment to P-1
- Original P-1 had 4 sub-tasks. The 4th — fixing `getAddressInfo` zero-balance FIXME — turned out to be **SDK-side only** (the FIXME lives in `../sdks/`, not in the node).
- Properly fixing it requires the node to emit `balance: string` instead of `balance: number/bigint`, which is a wire-format change. That belongs in P3 (dual-rule serialization), not in P-1's "no migration logic" phase.
- **Decision**: dropping FIXME fix from P-1; will be handled naturally by P3.
- P-1 now has 3 sub-tasks:
  1. `parseInt(amount)` → `BigInt(amount)` in `src/libs/blockchain/routines/subOperations.ts` (lines 83, 96, 147, 163, 171)
  2. Widen 32-bit fee columns in `src/model/entities/Transactions.ts` (lines 52-59) — `networkFee`, `rpcFee`, `additionalFee` from `integer/number` to `bigint/bigint`. Generate TypeORM migration.
  3. Type assertions in `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` (lines 26, 65) — coerce `editOperation.amount` to BigInt at the boundary.
- File `src/model/entities/Transactions.ts:43` already has `amount: bigint` ✓ — only fees need widening.
- `subOperations.ts:96` does `parseInt(...)` then `isNaN(...)` checks — must replace with `BigInt(...)` in try/catch since BigInt throws on bad input.

## Session 3 (2026-05-01, continued)

### State
- User chose **option (a)** for SDK-vs-pre-fork compatibility: dual-format SDK that detects fork status and serializes accordingly.
- SPEC.md updated with option (a) details:
  - SDK ships both serializers (DEM-number for pre-fork, OS-string for post-fork)
  - Node adds `getNetworkInfo` (or similar) RPC in **P3** so SDK has something to query — moved from P4 to P3 to honor the strong-reading constraint
  - SDK caches fork status per `Demos` instance, refreshes when nearing activation height
  - Pre-fork serialization rejects sub-DEM precision with a hard error
- Mycelium epic #3 created with 9 tasks (P-1 through P8), full dependency chain wired:
  - Task 18 (P-1) is the only currently unblocked task
  - All others blocked in sequence per SPEC.md §2

### Resume protocol (post-compaction)
1. Read AGENTS.md (Team Mode marker)
2. Read decimal_planning/LOG.md (latest session)
3. Read decimal_planning/SPEC.md (working plan)
4. `myc task list --epic 3` — see what's open and what's blocked
5. The next actionable task is whichever has no `blocked by` arrow
6. When picking up a phase: read its SPEC.md section, check the audit reports for cited file paths/lines, then dispatch (Senior for implementation, You for integration)

### Decisions made
- Option (a) confirmed: dual-format SDK during transition
- Fork-status RPC moved from P4 (SDK) to P3 (node) so SDK has the contract to query
- SDK pre-fork transfer rejects sub-DEM amounts with clear error rather than silently truncating
