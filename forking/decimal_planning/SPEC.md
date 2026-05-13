# SPEC — DEM → OS Denomination Migration

> **Status**: Draft, pending user approval.
> **Source-of-record for intent**: `IDEA.md` (do not edit).
> **Source-of-record for ground truth**: `audit_sdk.md`, `audit_node.md`, `surface_scan.md`, `forking_feasibility.md`.
> **This file**: implementable, dual-repo, cutover-aware spec. Replaces IDEA.md as the working plan.

---

## 0. Goal & Constraints

**Goal**: Move the Demos Network from DEM-as-`number` to OS-as-`bigint`/`string`. Internal representation: `bigint`. Wire representation: decimal string. 1 DEM = 10^9 OS.

**Hard constraints (from user)**:
1. **Live state**: no network reset. Migration applies to existing balances.
2. **Self-contained SDK phases (strong reading)**: until v2 is fully tested, every published SDK version must be usable by the **current production node** without breaking. SDK changes that affect wire format are gated by node-side dual-rule support landing first.
3. **Manual SDK publish loop**: SDK change → user publishes manually → node bumps SDK pin → node change. Each SDK phase must be a complete, shippable, passing-tests release.
4. **Pre-fixes first**: bugs found in `audit_node.md` that exist independent of this migration are fixed in their own PRs before migration begins.
5. **Tests live in `testing/`** per CLAUDE.md.

**Soft constraints**:
- Node SDK pin is `^2.11.4` (caret). The major bump to 3.0.0 will not auto-pull; explicit `bun update --latest` required.
- Node has no hard-fork machinery today. We build a minimal one as part of this migration (~2 person-days, see `forking_feasibility.md`).

---

## 1. Cutover Strategy

### 1.1 Hard fork at block height N

A coordinated rule change at block `N`:

| Block height | Wire format | Storage unit | Hashing serializer |
|---|---|---|---|
| `< N` | `amount: number` (DEM) | DEM bigint | legacy |
| `≥ N` | `amount: string` (OS) | OS bigint | new |

The node validates blocks `< N` with legacy rules and blocks `≥ N` with new rules. Sync of historical blocks remains valid.

### 1.2 State migration at block N

At the block-N transition, every account balance is multiplied by `10^9` in a single atomic database migration. This is not a transaction; it's a state edit baked into the fork activation. Total balance supply increases by 10^9× nominally but value is unchanged.

The migration:
1. Runs once when the node first processes block `N`.
2. Is idempotent (gated on a one-time flag in the database).
3. Has a verification step: sum of pre-migration balances × 10^9 = sum of post-migration balances.

### 1.3 Why not dual-format acceptance window
Confirmed dead end (see `forking_feasibility.md`): signatures commit to exact serialized bytes. Two byte-level formats produce two different hashes. A node accepting both cannot verify the same transaction in two formats.

### 1.4 Why hard fork over network reset
- Preserves history and audit trail
- Reusable pattern for future protocol upgrades
- All required infrastructure (block height threading, single serialization choke points) already exists
- ~2 person-days to build the gate vs. the operational pain of a coordinated reset

---

## 2. Phasing & Repo Coordination

### Legend
- **[SDK]** changes happen in `/Users/tcsenpai/kynesys/sdks/`. End with: lint+typecheck+tests pass, version bump, **user publishes manually**.
- **[NODE]** changes happen in `/Users/tcsenpai/kynesys/node/`. End with: lint+typecheck+`bun test testing/` pass.
- **🚦** = hard gate (do not start the next phase until this completes).
- Each SDK phase produces a publishable SDK version usable by the **then-current** node version.

### Phase sequence

```
P-1  [NODE] Pre-fixes (independent bugs, no migration logic)              🚦
 |
P0   [SDK]  Foundation: denomination/ utilities, exported, unused yet     🚦 (publish v2.12.0)
 |
P1   [NODE] Bump SDK to v2.12.0; adopt utilities for internal cleanup     🚦
 |
P2   [NODE] Hard-fork machinery (block-height-gated rule dispatch)        🚦
 |    (forks config, gate function, block-N activation hook;
 |     legacy serializer + validators preserved as the only active path)
 |
P3   [NODE] Dual-rule serializer/validator paths (legacy + new), gated    🚦
 |    by block height. Default activation height = +∞ (effectively off).
 |    Storage migration script written and tested but not auto-run.
 |
P4   [SDK]  Internal type migration: amount/balance/fee fields become     🚦 (publish v3.0.0-rc.1)
 |    OS strings on the wire. Public API accepts bigint. Phases 1–7
 |    of IDEA.md collapsed into one shippable SDK release.
 |    SDK still works against pre-fork node (validates client-side
 |    against block height retrieved from getAddressInfo or similar).
 |
P5   [NODE] Bump SDK to v3.0.0-rc.1. Set fork activation height to a      🚦
 |    concrete future block N on testnet. Test full path on testnet.
 |
P6   [BOTH] Integration test pass: testnet runs through block N           🚦
 |    successfully. Balances migrate. Signatures with new format
 |    validate. Old historical blocks still re-syncable.
 |
P7   [SDK]  Final cleanup, docs, examples, JSDoc. Publish v3.0.0.         🚦
 |
P8   [NODE] Production fork activation height set. Coordinated release.
```

---

## 3. Phase Details

### P-1 — Node pre-fixes (independent bugs)

**Repo**: node only. No SDK touch.

**Tasks**:
1. Replace `parseInt(operation.params.amount)` with `BigInt(operation.params.amount)` everywhere it occurs (cite locations from `audit_node.md`).
2. Widen any 32-bit `integer` fee columns to `bigint` in TypeORM entities. Generate migration. (TypeORM `synchronize: true` is allowed per CLAUDE.md but write the migration anyway for prod determinism.)
3. Fix `getAddressInfo` zero-balance FIXME (referenced in `audit_sdk.md`, surfaced via SDK but root cause is node-side response shape).
4. Add type assertions in `GCRBalanceRoutines` and `subOperations` where `actualBalance < editOperation.amount` compares bigint vs string today.

**Acceptance**:
- `bun run lint:fix` clean
- `bun test testing/` passes (existing tests, no new ones required for this phase)
- Each fix is its own commit/PR for clean review

**Out of scope**: anything denomination-related. These are bugs that should land regardless.

---

### P0 — SDK foundation (additive only)

**Repo**: SDK only. **Self-contained: yes.**

**Tasks** (per IDEA.md §0.1–0.5, with corrections):
1. Create `src/denomination/constants.ts` (constants exactly as IDEA.md spec).
2. Create `src/denomination/conversion.ts` (functions exactly as IDEA.md spec).
3. Create `src/denomination/index.ts` re-exporting both.
4. Re-export from main entry point. **Audit confirms** the public entry is `src/index.ts` (not `src/websdk/index.ts`) — verify with `audit_sdk.md`'s findings.
5. Create `src/denomination/conversion.test.ts` (tests as IDEA.md spec).

**Acceptance**:
- `bun test src/denomination/` passes
- `bun run build` (or SDK equivalent) succeeds
- No existing SDK code uses these utilities yet — they are dormant exports
- **Existing SDK consumers (current node) are 100% unaffected** — purely additive

**Publish gate** 🚦: User runs `bun publish` (or equivalent). Output: SDK v2.12.0 on npm.

---

### P1 — Node adopts SDK utilities (cleanup only, no behavior change)

**Repo**: node. **Wire-format unchanged.**

**Tasks**:
1. `bun update @kynesyslabs/demosdk --latest` → 2.12.0
2. Where node has its own DEM/OS conversion math (per `surface_scan.md` Category B hits in node), replace with imports from `@kynesyslabs/demosdk/denomination`. **Do not** change any wire-facing behavior.
3. Remove duplicated conversion utilities from node.

**Acceptance**:
- `bun run lint:fix` clean, `bun test testing/` passes
- No wire-format change; node-SDK contract identical to before P1
- Node continues to accept `amount: number` (DEM) on the wire

**Why this phase exists**: gets utilities into node early so P2/P3 can use them without import gymnastics, while still being a no-op for the network.

---

### P2 — Node hard-fork machinery (rule-gating only, no rule yet)

**Repo**: node. **Wire-format unchanged.**

**Tasks** (per `forking_feasibility.md`):
1. Add `forks` field to genesis/chain config: `{ osDenomination: { activationHeight: number | null } }`. Default `null` = inactive.
2. Load fork heights into `SharedState` (or wherever runtime config lives) at startup.
3. Create `src/forks/` module with a single gate function: `isForkActive(forkName, blockHeight): boolean`.
4. Wire it into the existing serialization choke points (per `forking_feasibility.md`: 6 transaction hash sites + 2 block hash sites). For now, the gate function always returns `false` because `activationHeight` is `null`. **No behavioral change.**
5. Unit tests for the gate function in `testing/`.

**Acceptance**:
- Existing tests pass unchanged
- New tests for the gate function pass
- Network behavior is bit-identical to before P2 (provable via integration test that validates a known transaction hash matches pre-P2 hash)

---

### P3 — Node dual-rule paths + state migration script + fork-status RPC

**Repo**: node. **Wire-format unchanged in production** (fork still inactive).

**Tasks**:
1. **Dual serializers**: at each of the 6+2 hash sites, branch on `isForkActive('osDenomination', height)`:
   - inactive → existing JSON.stringify path (legacy: `amount: number`)
   - active → new path (canonical OS-string serialization)
2. **Dual validators**: amount/balance/fee comparison code branches on the same gate. Pre-fork: DEM bigint storage, OS conversion not applied. Post-fork: OS bigint storage, signatures verified against OS-string content.
3. **State migration script** at `src/forks/migrations/osDenomination.ts`:
   - Idempotent (one-time flag in DB)
   - Multiplies every account balance by `10^9`
   - Verifies sum invariant: `Σ(post) = Σ(pre) × 10^9`
   - Hooked to run **automatically** when the node first sees block `≥ activationHeight`
4. **Fork-status RPC** (required by P4's dual-format SDK):
   - New endpoint or extension to existing one (e.g., `getNetworkInfo`) returning `{ forks: { osDenomination: { activationHeight: number | null, activated: boolean, currentHeight: number } } }`
   - `activated` is true iff `currentHeight >= activationHeight` and `activationHeight !== null`
   - Cheap (no DB query — read from `SharedState`)
5. **Migration tests in `testing/`**:
   - Snapshot a small DB of DEM balances, run migration, assert OS balances correct
   - Round-trip: legacy serializer with DEM number → hash A; new serializer with OS string → hash B; assert A ≠ B (formats are distinct, as expected)
   - Block-height gate: same transaction at height < N hashes one way, at height ≥ N hashes another
   - Fork-status RPC returns correct values for: no-fork-configured, fork-configured-but-inactive, fork-active

**Acceptance**:
- All existing tests still pass (because `activationHeight` defaults to `null`/∞, gate is inactive)
- New dual-rule tests pass
- Migration script tested against a snapshot in `testing/`
- Node deployed with default config behaves identically to a pre-P3 node

**Why this lands before SDK v3**: the node must be ready to accept the new wire format at fork height **before** any SDK can produce that format. SDK v3 ships *after* node has dual-rule support deployed.

---

### P4 — SDK v3.0.0-rc.1: full type migration

**Repo**: SDK only. **Self-contained: yes** (publishable, tests pass; **must remain compatible with pre-fork node** — see compatibility note below).

This phase **collapses IDEA.md phases 1–7** into one shippable release because partial type migration cannot be self-contained per the strong-reading constraint.

**Tasks** (consolidated; cite specific files via `audit_sdk.md`):

1. **Type definitions** — migrate every interface in IDEA.md §1.1–1.9 PLUS the ones the audit found missing:
   - D402PaymentPayload
   - BridgeTradePayload
   - GCREdit variants
   - StateChange token/NFT amount fields
   - xm apiTools fields
2. **Internal arithmetic** — all amount math uses `bigint`. JSON serialization always converts via `toOsString` for wire.
3. **IPFS module** (IDEA.md §3): rename `max_cost_dem` → `max_cost_os`. Convert quote.cost from DEM to OS via `demToOs`.
4. **Wallet** (IDEA.md §4): `_balance: bigint`, `balanceOs`, `balanceDem`, `transfer(to, amountOs: bigint)`.
5. **Main Demos class** (IDEA.md §5): `transfer(to, amountOs)`, `getAddressInfo` returns `balance: string` (OS).
6. **Escrow** (IDEA.md §6): `sendToIdentity(..., amountOs: bigint)`.
7. **Native bridge** (IDEA.md §7): all amounts as OS strings.
8. **Storage program / TLSNotary fees** (IDEA.md §2): use `OS_PER_DEM` for fee constants.
9. **Tests** — every SDK test updated to use OS values.
10. **Version**: `3.0.0-rc.1`. Major bump signals breaking change.

**Compatibility model — decided: option (a) dual-format SDK**:

Per the strong-reading constraint, SDK v3.0.0-rc.1 must still be usable against the **then-current node** (which has P3's dual-rule support but `activationHeight: null`/∞ in production by default).

The SDK detects fork status via the node and serializes accordingly:
- **Pre-fork node** (or `activationHeight: null`) → SDK produces legacy DEM-number wire format
- **Post-fork node** (or current height ≥ `activationHeight`) → SDK produces new OS-string wire format
- Same SDK, both serializers shipped, runtime decision per connection

**How fork detection works (P4 design)**:
1. Add a node RPC: `getNetworkInfo` (or extend an existing one) that returns `{ forks: { osDenomination: { activationHeight, activated: bool } } }`. This RPC is added in **P3** (alongside the dual-rule paths) so SDK v3 has something to query.
2. SDK caches the fork status per `Demos` instance after the first call. TTL based on block height progression: re-checks when `activated` is `false` and current height approaches `activationHeight`.
3. SDK public API (`demToOs`, `transfer(amountOs)`) is unchanged regardless of which serializer ends up on the wire — the bigint amount is the same; only the JSON shape differs.
4. For pre-fork nodes, the SDK's `transfer(amountOs)` divides `amountOs` by `OS_PER_DEM` to get DEM, validates that the result is an integer (no sub-DEM precision can be sent to a pre-fork node), errors clearly if it's not.

**Why option (a) over (b)**:
- (a) lets production users adopt v3 immediately without waiting for the fork; one SDK across the rollout window.
- (a)'s extra surface area is bounded: one RPC call, one cached flag, one branch in serialization.
- The sub-DEM precision check is a hard error with a clear message, so users can't accidentally lose value.

**Cost of option (a) we're accepting**:
- Both serializers must remain in v3 indefinitely (or until v4 drops pre-fork support).
- The fork-detection RPC (`getNetworkInfo`) is now part of the node's contract — must be added in P3, not later.
- One extra round-trip on first transaction per `Demos` instance (cached after).

**Acceptance**:
- All SDK tests pass
- TypeScript compiles with strict types
- Published as `3.0.0-rc.1` (pre-release tag — won't auto-install via caret)
- README/JSDoc updated for breaking change

**Publish gate** 🚦: User runs `bun publish --tag rc`.

---

### P5 — Node bumps SDK to v3.0.0-rc.1, testnet fork

**Repo**: node.

**Tasks**:
1. `bun add @kynesyslabs/demosdk@3.0.0-rc.1` (explicit version, escape the caret).
2. Update node code to consume new SDK types (the node's own internal use of SDK types). Mostly type-checker fallout from P4.
3. **Testnet config**: set `forks.osDenomination.activationHeight` to a concrete near-future block on testnet.
4. Run testnet through the fork height. Observe migration runs, balances multiply, new transactions accepted in OS format, old transactions still re-syncable.

**Acceptance**:
- Testnet successfully crosses fork height
- Pre-fork blocks remain syncable (re-sync from genesis works)
- Post-fork transactions validate
- Sum invariant holds: `Σ(post-fork balances) == Σ(pre-fork balances) × 10^9`

---

### P6 — Integration test pass (testnet sustained run)

**Repo**: both, plus testnet ops.

**Tasks**:
1. Run testnet for a sustained period across the fork.
2. Real users / test clients exercise: transfers, escrow, IPFS charges, bridge ops, all using SDK v3.
3. Re-sync a fresh node from genesis: must succeed across the fork boundary.
4. Edge cases: transactions submitted near the fork height, mempool drain across the boundary, etc.

**Acceptance**:
- All `testing/` integration suites green against testnet
- No state divergence between nodes
- No signature failures attributable to format confusion

---

### P7 — SDK v3.0.0 final

**Repo**: SDK only.

**Tasks**:
1. Address any RC feedback.
2. Final docs sweep: README examples use `demToOs(...)`, JSDoc complete.
3. Remove pre-release tag. Publish as `3.0.0`.

**Publish gate** 🚦: User runs `bun publish`.

---

### P8 — Production fork activation

**Repo**: node, ops.

**Tasks**:
1. Bump production node SDK pin to `^3.0.0`.
2. Set production `forks.osDenomination.activationHeight` to a coordinated future block (give node operators advance notice).
3. Coordinated deploy across all node operators **before** activation height.
4. At activation height, migration runs automatically per P3 design.

**Acceptance**:
- Production crosses fork height with no incidents
- All operators on new version
- Public SDK consumers transition (or stay on v2.x indefinitely if they want pre-fork compatibility — caret pin won't pull v3 unless they explicitly upgrade)

---

## 4. Test Strategy (cross-cutting)

Per CLAUDE.md, all tests live in `testing/` for the node and follow SDK conventions in the SDK repo.

**Unit tests** (per phase):
- P0: conversion utility round-trips (already in IDEA.md §0.5)
- P2: gate function truth table
- P3: state migration idempotency, sum invariant, dual-serializer hash distinctness
- P4: every migrated type has at least one round-trip test (DEM input → OS wire → DEM display)

**Integration tests** in `testing/` (node):
1. **Snapshot replay**: load a snapshot of pre-fork DB, run migration, assert post-state. Round-trip the snapshot through `bun test testing/`.
2. **Block-height gate boundary**: submit identical transactions at heights `N-1` and `N`, assert both validate but with different content hashes.
3. **Re-sync across fork**: spin up a fresh node, sync from block 0, assert it crosses the fork height correctly.
4. **Mempool drain**: transactions submitted pre-fork that land in a post-fork block — define and test the policy (likely: rejected at fork height, must be resubmitted in new format).
5. **Sum invariant**: programmatic check on a non-trivial balance distribution.

**SDK integration** (in SDK repo):
- End-to-end: `demToOs("1.5")` → `transfer` → mock node receives correct wire bytes → response parses back to `bigint`.
- Compatibility: SDK v3 talking to a mocked pre-fork node — does it error cleanly per option (b) above?

---

## 5. Open Questions for User

These were resolved in conversation but documented here for the spec record:

| # | Question | Answer |
|---|---|---|
| 1 | Storage unit today | DEM (a) — multiplication migration required |
| 2 | Hard-fork machinery exists | No — build minimal one in P2 |
| 3 | Self-contained SDK phases | Strong reading (a): publishable + compatible with then-current node |
| 4 | Pre-fixes | Phase −1, separate PRs |
| 5 | SDK pin | `^2.11.4`, manual upgrade to v3 |
| 6 | IPFS `max_cost_dem` denomination | Was DEM, becomes OS, rename to `max_cost_os` |
| 7 | Test strategy | Use `testing/` per CLAUDE.md |

**Resolved**:
- **Q-P4-A**: Option **(a) dual-format SDK** chosen by user. SDK ships both serializers, detects fork status via new `getNetworkInfo` RPC (added in P3), serializes per node's state. Pre-fork serialization rejects sub-DEM precision with a clear error.

---

## 6. Mycelium Tracking — seeded

Epic and phase tasks created. Resume with:

```bash
myc task list --epic 3      # see all phases
myc deps show <task-id>     # see what's blocked / blocking
```

| Task ID | Phase | Status |
|---|---|---|
| 18 | P-1: Node pre-fixes | open |
| 19 | P0: SDK utilities (publish v2.12.0) | blocked by 18 |
| 20 | P1: Node bumps SDK, cleanup | blocked by 19 |
| 21 | P2: Node hard-fork machinery | blocked by 20 |
| 22 | P3: Node dual-rule + migration + fork-status RPC | blocked by 21 |
| 23 | P4: SDK v3.0.0-rc.1 dual-format | blocked by 22 |
| 24 | P5: Node bumps to RC, testnet fork | blocked by 23 |
| 25 | P6: Sustained testnet integration | blocked by 24 |
| 26 | P7: SDK v3.0.0 final | blocked by 25 |
| 27 | P8: Production fork activation | blocked by 26 |

P-1 may be subdivided into per-bug subtasks before execution starts. Each phase task links to the corresponding section in this SPEC.md via its description.

---

## 7. Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| State migration produces wrong balances | Critical | Sum invariant check; snapshot-based test in `testing/`; testnet rehearsal in P5/P6 |
| Pre-fork blocks unsyncable after upgrade | Critical | Dual-serializer paths preserved indefinitely; re-sync test in P6 |
| Signature scheme inconsistencies near fork boundary | High | Clear policy on mempool drain; integration test for fork-boundary transactions |
| SDK v3 RC accidentally pulled by production users | Medium | Use `--tag rc` on publish; users must opt in explicitly |
| Hidden type definitions still using `number` | Medium | `surface_scan.md` is the canonical checklist; CI lint rule for `amount: number` post-P4 |
| TypeORM column types insufficient for OS magnitudes | High | P-1 widens to `bigint`; verified before P3 migration script |

---

## 8. Files in `decimal_planning/` after this spec

- `IDEA.md` — original proposal (preserved)
- `LOG.md` — running log
- `NEXT_STEPS.md` — superseded by this SPEC.md, but kept for trail
- `audit_sdk.md`, `audit_node.md`, `surface_scan.md`, `forking_feasibility.md` — research outputs
- `SPEC.md` — this file, the working plan
- (future) per-phase notes, diagrams, post-phase reports
