# Rehearsal Results (run on 2026-05-08)

## Environment

- **Date/time**: 2026-05-08, ~11:06 CEST (Europe/Rome host).
- **Host OS**: Darwin 25.2.0 (macOS).
- **Docker**: v28.4.0 (build d8eb465).
- **Docker Compose**: v2.39.2-desktop.1.
- **Bun**: v1.3.6.
- **Repo**: `/Users/tcsenpai/kynesys/node/`, branch `decimals` at HEAD `4b099c5d`.
- **Notable env state at start**:
  - Pre-existing `demos-tlsnotary` container running for 7 days, holding **host port 7047** (`0.0.0.0:7047->7047/tcp`). This container is **not** the devnet's `demos-devnet-tlsnotary`; it is a separate, long-running tlsnotary instance.
  - Other unrelated containers running: `demos-grafana` (3000), `demos-prometheus` (9091), `csv-editor-frontend` (8765), `csv-editor-backend` (8764), n8n stack (5678 + internal postgres/redis). None of these touch the rehearsal-relevant host ports per the user's STOP-condition list (5432 / 53551-53557 / 7047 / 53559).
  - Host ports 5432 and 53551-53557 were free at start.
  - Host port **7047 was occupied** by `demos-tlsnotary` — but the rehearsal devnet also requires this port (see `testing/devnet/docker-compose.yml:38-39`).

## Summary table

| # | Scenario | Status | Runtime | Notes |
|---|---|---|---|---|
| 1 | All-validators-cross-fork (smoke test) | ERROR | 44.2 s | Hard stop: docker compose up failed because host port 7047 is held by an unrelated `demos-tlsnotary` container the user wants left running. |
| 4 | Genesis-hash invariance | SKIPPED | — | Halted under STOP condition #2. |
| 7 | Sum invariant audit | SKIPPED | — | Halted under STOP condition #2. |
| 8 | Idempotent restart | SKIPPED | — | Halted under STOP condition #2. |
| 5 | Cap policy fires loud | SKIPPED | — | Halted under STOP condition #2. |
| 6 | Mid-flight transactions | SKIPPED | — | Halted under STOP condition #2. |
| 2 | Validator desync recovery | SKIPPED | — | Halted under STOP condition #2. |
| 3 | Fresh node post-fork | SKIPPED | — | Halted under STOP condition #2. |

Counts: PASS 0 / FAIL 0 / SKIPPED 7 / ERROR 1 / TIMEOUT 0.

## Per-scenario detail

### Scenario 1: All-validators-cross-fork (smoke test)

**Result**: ERROR (environment, not fork mechanism).
**Runtime**: 44.2 s wall-clock (build cache hit, no node ever started).
**Observations**:
- The harness ran its pre-clean `docker compose down -v` cleanly.
- Identity regeneration succeeded (4 nodes).
- `genesis-fork-low.json` was staged at `data/genesis.json`; backup at `data/genesis.json.rehearsal-backup` was created.
- Image `demos-devnet-node:latest` was rebuilt via `docker compose up -d --build` — all 9 layers cached, image rewrapped in ~26 s.
- Network `demos-devnet_demos-network` and volume `demos-devnet_postgres-data` created.
- All container objects created: `demos-devnet-postgres`, `demos-devnet-tlsnotary`, `demos-devnet-node-1..4`.
- `demos-devnet-postgres` started successfully (host port 5432 was free).
- `demos-devnet-tlsnotary` failed to start.

**Failure mode (environment)**:

```
Error response from daemon: failed to set up container networking: driver failed
programming external connectivity on endpoint demos-devnet-tlsnotary
(e90364e34d28255b4ffb474685e8ac02ece45a7ad991e6980541068d9c02f054):
Bind for 0.0.0.0:7047 failed: port is already allocated
```

`docker ps` confirms the holder:

```
demos-tlsnotary  0.0.0.0:7047->7047/tcp, [::]:7047->7047/tcp
```

This `demos-tlsnotary` container is **not** part of the devnet (which would name its container `demos-devnet-tlsnotary`). It has been running for 7 days and is unrelated to the rehearsal. Per the user's STOP conditions, "The user has other things running locally; don't kill them. Stop and report."

**Read on whether this is a real bug**: No. This is an environment / port-collision issue that the rehearsal harness cannot resolve without either (a) killing the unrelated container (forbidden), or (b) introducing a host-port override for tlsnotary in `testing/devnet/docker-compose.yml` (the harness already has one for postgres via `POSTGRES_HOST_PORT`, but **none** for tlsnotary's 7047). No fork-mechanism observation was reachable.

**Log excerpts**: see "Failure mode" above. Build phase was clean; failure is a single-line networking error from the Docker daemon.

**Post-failure cleanup**: harness ran `restoreProductionGenesis()` and `downHard()` from its `finally` block. Verified after the run:
- `diff data/genesis.json data/genesis.json.rehearsal-backup` → no diff (genesis restored to production state).
- `docker ps` shows no `demos-devnet-*` containers.
- No leftover `docker-compose.override.*.yml` files in `testing/devnet/`.
- The harness left `data/genesis.json.rehearsal-backup` in place (as designed — it is a one-time backup, not deleted on teardown).

### Scenarios 2–8: SKIPPED

Halted per the user's STOP-condition #2 (port conflict that the rehearsal cannot resolve without disturbing the user's other workloads). Running the remaining scenarios would have hit the same tlsnotary port-binding error on every `docker compose up`, since the harness is per-scenario fully repeatable from a clean state and every scenario brings `tlsnotary` up.

## Verdict

**Rehearsal halted before any fork mechanism could be observed.** The harness itself appears functional: it built the image, regenerated identities, staged the rehearsal genesis, ran teardown on failure, and restored the production genesis. The block was a port collision on 7047 between the always-on `demos-tlsnotary` container the user keeps running and the devnet's `demos-devnet-tlsnotary` service, which both want to bind host `0.0.0.0:7047`.

Per the user's instructions, this is not a problem the rehearsal driver should solve. It is an operator-side decision: either stop the user's standalone tlsnotary before rehearsing, or add a `TLSNOTARY_HOST_PORT` override variable to `testing/devnet/docker-compose.yml` (mirroring the existing `POSTGRES_HOST_PORT` pattern) so the devnet's tlsnotary can be remapped to e.g. 7147.

No fork-mechanism evidence was produced. The status of the 8 rehearsal scenarios on this branch remains **unverified on real Postgres**.

## Open questions / follow-ups

1. **Add a tlsnotary host-port override** to `testing/devnet/docker-compose.yml` (one-line change: `"${TLSNOTARY_HOST_PORT:-7047}:7047"`), following the `POSTGRES_HOST_PORT` pattern. This is the least-disruptive fix and lets the rehearsal coexist with other tlsnotary instances. Out of scope for this task per "no code changes unless a scenario reveals a real bug" — but worth a follow-up.
2. **Document the prerequisite** in `testing/forks/rehearsal/README.md` that host port 7047 must be free in addition to 5432 and 53551-53558. The README only mentions 5432 today.
3. **Re-run the rehearsal** after either (a) the user temporarily stops `demos-tlsnotary`, or (b) the host-port override is added, then merged. None of the 8 scenarios were validated in this attempt; all 8 still need to run before P5b is signed off.
4. **No fork-mechanism bug was surfaced** because no scenario reached its assertions. The rehearsal cannot produce a verdict on the migration / convergence / idempotency claims yet.

## Final state

- All `demos-devnet-*` containers are torn down.
- `demos-devnet_postgres-data` volume removed.
- Production genesis restored at `data/genesis.json` (matches `data/genesis.json.rehearsal-backup`).
- No override files left in `testing/devnet/`.
- The user's pre-existing containers (`demos-tlsnotary`, `demos-grafana`, `demos-prometheus`, csv-editor, n8n stack, postgres-with-worker) are untouched.
- No commits made. No remote pushed.

---

## Run 2 (after tlsnotary port fix) — 2026-05-08

### Environment

- **Date/time**: 2026-05-08, ~12:30 CEST.
- **Host OS**: Darwin 25.2.0 (macOS).
- **Docker**: v28.4.0 (build d8eb465).
- **Docker Compose**: v2.39.2-desktop.1.
- **Bun**: v1.3.6.
- **Repo**: `/Users/tcsenpai/kynesys/node/`, branch `decimals` at HEAD `34826f1f` ("chore(devnet): make tlsnotary host port configurable…"). Run 2 commit is the immediate child of Run 1's HEAD.
- **Standalone `demos-tlsnotary`**: still up on host port 7047, undisturbed throughout Run 2.
- **Standalone `withpostgresandworker-postgres-1`**: bound to internal docker port only (not host 5432), so host 5432 was free.
- **Rehearsal env vars used**: `TLSNOTARY_HOST_PORT=7048` set in `testing/devnet/.env`. `POSTGRES_HOST_PORT=5432` (default). Node RPC ports: `53551 / 53553 / 53555 / 53557` per `.env.example` (this is what `lib/nodeQueries.ts` expects — see "Pre-flight finding" below).

### Pre-flight finding (operator-side, not a fork bug)

The pre-existing `testing/devnet/.env` (gitignored, dated 2026-03-23) used the **earlier** devnet port scheme:

```
NODE1_PORT=53551  NODE2_PORT=53552  NODE3_PORT=53553  NODE4_PORT=53554
NODE1_OMNI_PORT=53561  NODE2_OMNI_PORT=53562  NODE3_OMNI_PORT=53563  NODE4_OMNI_PORT=53564
```

The rehearsal harness's `lib/nodeQueries.ts` is hard-coded against the newer interleaved scheme that ships in `testing/devnet/.env.example` (`53551 / 53553 / 53555 / 53557`). With the stale `.env` in place, scenario 1 timed out polling the wrong host ports ("Unable to connect" on host RPC). I aligned the local `.env` with `.env.example` (RPC `53551/53553/53555/53557`, omni `53552/53554/53556/53558`, plus `TLSNOTARY_HOST_PORT=7048`) and re-ran. **No source code or committed file was changed for this** — `.env` is gitignored and per-developer.

This is worth a follow-up: the harness either needs to read `.env` itself, or the README should call out that an out-of-date `.env` from the pre-rehearsal devnet will silently misconfigure the run. Not a blocker for this dispatch (the user's `.env.example` is the source of truth and the harness matches it).

### Summary table

| # | Scenario | Status | Runtime | Notes |
|---|---|---|---|---|
| 1 | All-validators-cross-fork (smoke test) | FAIL | 283 s (1st correct run, 252 s on `--keep-state` repro) | Real fork-mechanism bug: Postgres `bigint` overflow during `UPDATE gcr_main SET balance = balance * 1000000000`. STOP. |
| 4 | Genesis-hash invariance | SKIPPED | — | Hard-stop after scenario 1 surfaced a real bug. Per dispatch instructions, the user decides whether to fix-and-re-run or accept-and-document. |
| 7 | Sum invariant audit | SKIPPED | — | Same. |
| 8 | Idempotent restart | SKIPPED | — | Same. |
| 5 | Cap policy fires loud | SKIPPED | — | Same. |
| 6 | Mid-flight transactions | SKIPPED | — | Same. |
| 2 | Validator desync recovery | SKIPPED | — | Same. |
| 3 | Fresh node post-fork | SKIPPED | — | Same. |

Counts: PASS 0 / FAIL 1 / SKIPPED 7 / ERROR 0 / TIMEOUT 0.

### Per-scenario detail

#### Scenario 1: All-validators-cross-fork (FAIL — real fork bug)

**Result**: FAIL — Postgres `bigint` overflow inside the migration.
**Runtime**: 283 s wall-clock for the height-poll timeout (which is what the harness reports). Underlying cause occurred ~30 s into network startup, when nodes attempted to insert block 5 (the activation block).

**What happened**:
1. Harness ran `regenerateIdentities(4)`, `stageGenesis(GENESIS_FORK_LOW)`, `up({ build: true })` cleanly.
2. All containers came up: postgres healthy, tlsnotary up on host 7048, all 4 nodes started.
3. Nodes booted, connected to Postgres, populated `gcr_main` from genesis (each row at `1_000_000_000_000_000_000` = 1e18 = the seeded balance from the rehearsal genesis).
4. At block 5 (activation height), each node ran `runOsDenominationMigration()` which executes `UPDATE gcr_main SET balance = balance * 1000000000`.
5. Postgres rejected the multiplication: `1e18 * 1e9 = 1e27`, which exceeds signed 64-bit `bigint` max (~9.22e18 = `9_223_372_036_854_775_807`). Postgres error code `22003`, routine `int84mul` in `int8.c`.
6. The migration's transactional rollback failed the block insert (`Failed to insert block 5 with hash 63883d6954909e180a1f1516ef48a9b7ed1ed71c5deeb5064922bb119bd63e65: QueryFailedError: bigint out of range`).
7. The node's main entry crashed (`error: script "start:bun" exited with code 1`) and Docker's `restart: unless-stopped` cycled it.
8. Repeated crash-loop on every node. Network never advanced past block 4. Harness's height>=6 watcher timed out at 240 s.

**Log excerpt (node-1, the smoking gun)**:

```
[ERROR] [CORE] [ChainDB] [ ERROR ]: Failed to insert block 5 with hash
  63883d6954909e180a1f1516ef48a9b7ed1ed71c5deeb5064922bb119bd63e65:
  QueryFailedError: bigint out of range
error: bigint out of range
      query: "UPDATE gcr_main SET balance = balance * 1000000000",
   severity: "ERROR",
       code: "22003",
       file: "int8.c",
    routine: "int84mul"
[ERROR] [CONSENSUS] QueryFailedError: bigint out of range
error: script "start:bun" exited with code 1
```

**Postgres state at the moment of failure** (captured via `docker exec demos-devnet-postgres psql ... node1_db`):

```
\d gcr_main
  pubkey   text NOT NULL  PK
  balance  bigint NOT NULL    <-- signed 64-bit, max 9.22e18

SELECT MAX(balance), COUNT(*) FROM gcr_main;
  max:   1_000_000_000_000_000_000   (= 1e18)
  count: 7
```

So the seeded value was already at 1e18 magnitude; multiplying by 1e9 overflows on the very first row. This is true for the production genesis at `data/genesis.json` too (identical balances).

**Severity**: BLOCKER. With these seed values (which match production genesis), the fork migration can NEVER succeed on Postgres. The scenario is doing exactly what production will do.

**Read on whether this is a real fork-mechanism bug**: Yes — and a high-stakes one. The migration:

1. Has no overflow guard before the multiplication. Cap policy is implemented for the **legacy** GCR (`global_change_registry`) but not for `gcr_main`.
2. Computes the multiplication inside Postgres at the column type (`bigint`). Even if the cap were checked, the *expression* `balance * 1000000000` is evaluated before any client-side capping has a chance.
3. Was unit-tested against SQLite, where integer columns are dynamically typed (effectively arbitrary precision in JS via `BigInt`). SQLite accepted 1e27 silently. Postgres correctly refuses.

**Implications**:
- Even a single account with >= ~9.22e9 DEM (in pre-fork DEM-magnitude integer units) overflows. With the schema as-is, the *largest legal pre-fork balance* a single account can hold and still allow migration is `9_223_372_036` (~9.22 billion in column units), and the genesis seeds 1e18 — which is already 1e8x past that limit.
- Two distinct interpretations of `balance`'s units in the production genesis are possible: (a) it was intentionally pre-multiplied to "look like" post-fork OS units (in which case the migration must be a no-op for `gcr_main` rows, or skip already-migrated balances), or (b) the seed values are accidentally too large and need to be reduced to pre-fork DEM. Either way, the migration as written cannot run on this seed without changes.
- Any plausible production migration plan needs at least: column type widening to `numeric` (or `numeric(78,0)` to match EVM-256-bit conventions), OR capping in client code with overflow detection BEFORE issuing the SQL, OR a multi-step migration that copies into a wider column.

**Cleanup verified post-failure**:
- `diff data/genesis.json data/genesis.json.rehearsal-backup` → no diff (production genesis restored).
- `docker ps --filter name=demos-devnet` → empty (no containers).
- `ls testing/devnet/docker-compose.*.yml` → no override files left.
- Standalone `demos-tlsnotary`, `demos-grafana`, `demos-prometheus`, csv-editor, n8n stack — all undisturbed.

#### Scenarios 2–8: SKIPPED

Halted under the dispatch's STOP condition: "A scenario reveals a real fork-mechanism bug — STOP, document precisely, that's the user's call." Running scenarios 2–8 against a migration that crashes on the seed wouldn't add information beyond what scenario 1 already produced.

### Verdict

**NOT READY for testnet activation.** A blocker fork-mechanism bug was confirmed live on real Postgres at scenario 1, the simplest base-case scenario. The fork migration overflows `bigint` on the very first `UPDATE gcr_main` query when run against the production genesis seed magnitudes (1e18). This is precisely the SQLite-vs-Postgres gap the rehearsal exists to surface, and the rehearsal worked as intended in surfacing it.

The fork-activation logic, peer convergence, idempotency, fresh-joiner replay, and cap policy claims **all remain unverified on real Postgres** because no scenario reached its assertions. The static-trace reasoning from earlier sessions held at the unit-test layer but did not survive contact with Postgres typing.

### Top findings

1. **(BLOCKER, real bug)** `runOsDenominationMigration` performs `UPDATE gcr_main SET balance = balance * 1000000000` against a `bigint` column. This overflows Postgres signed 64-bit on any account holding >= ~9.22 * 10^9 in column units pre-multiplication. The production genesis seeds 1e18, so every account overflows. Source: `src/forks/migrations/osDenomination.ts:275`. No cap is applied to `gcr_main`; only the legacy `global_change_registry` table has cap-policy code.
2. **(Operator-side, low priority)** The pre-existing `testing/devnet/.env` predates the rehearsal harness and uses the older non-interleaved port scheme. The harness expects the `.env.example` scheme. Once aligned, the rehearsal proceeded — but the README/harness should defend against this (either fail-loud at startup with a port-mismatch check, or log the polled URLs upfront).
3. **(Confirmed working)** Part 1's tlsnotary host-port override worked exactly as designed: `TLSNOTARY_HOST_PORT=7048` allowed the rehearsal devnet to coexist with the user's standalone `demos-tlsnotary` on host 7047. No port collision, both containers ran healthy in parallel for the duration of Run 2.

### STOP condition hit

"A scenario reveals a real fork-mechanism bug" — scenario 1 surfaced a Postgres `bigint` overflow in the migration. Per dispatch instructions, I did NOT attempt a fix. Documentation only.

### Open questions / follow-ups

1. **Decide the fix shape for the gcr_main migration.** Likely options:
   - Widen `gcr_main.balance` to `numeric` (Postgres arbitrary-precision) ahead of the fork, then multiply, then optionally narrow.
   - Apply cap policy to `gcr_main` as well as to `global_change_registry`, AND multiply in a wider type (`(balance::numeric) * 1000000000`).
   - Reconsider whether the seed magnitudes in `data/genesis.json` are correct — are they intended as pre-fork DEM (in which case 1e18 is wrong) or as post-fork OS (in which case the migration should skip `gcr_main` rows that are already at OS magnitude)?
2. **Add a unit test against Postgres**, not SQLite, that runs the migration on a 1e18-seeded row and asserts behaviour. The 52/52 SQLite tests give false confidence.
3. **Re-run the rehearsal** after the fix lands; scenarios 2–8 still need verification.
4. **Document the harness/`.env` mismatch** in `testing/forks/rehearsal/README.md` so the next operator doesn't lose 5 minutes to it.
5. **Operator note**: the `genesis-fork-overflow.json` referenced in `decimal_planning/REHEARSAL_PLAN.md` for scenario 5 is not present in `testing/forks/rehearsal/genesis/` — the harness uses `genesis-fork-mid.json` instead. Worth reconciling.

### Final state

- All `demos-devnet-*` containers torn down.
- `demos-devnet_postgres-data` volume removed.
- Production genesis restored at `data/genesis.json` (byte-identical to `data/genesis.json.rehearsal-backup`).
- No override files left in `testing/devnet/`.
- Standalone `demos-tlsnotary`, `demos-grafana`, `demos-prometheus`, csv-editor, n8n stack — all undisturbed.
- `testing/devnet/.env` (gitignored) was updated locally to match `.env.example`'s port scheme + `TLSNOTARY_HOST_PORT=7048`. Original was backed up at `/tmp/devnet.env.original.backup` (not committed).
- One commit on `decimals` ahead of Run 1 HEAD: `34826f1f` (Part 1 fix). One commit for this report (this file).
- Nothing pushed.
