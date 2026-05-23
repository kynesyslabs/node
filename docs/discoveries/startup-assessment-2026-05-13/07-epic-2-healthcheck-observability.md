---
type: plan
title: "Epic 2 — Healthcheck + Observability Overhaul"
date: 2026-05-13
status: implemented
last_updated: 2026-05-14
implemented_tasks: [T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18]
depends_on: docs/discoveries/startup-assessment-2026-05-13/05-fragility-synthesis.md
---

# Epic 2 — Healthcheck + Observability Overhaul

> **Status (2026-05-14):** Implemented end-to-end. All 18 tasks landed
> in commit dated 2026-05-14 — see this folder's CHANGELOG.md for the
> change list. Manual smoke tests (real subsystem failure → row turns
> red in TUI, alert fires in Prometheus) are operator follow-ups; the
> code path is wired and unit-test-covered.

## Goal

Make the node's internal state observable. Eliminate the "looks alive but isn't" failure modes:
- Dormant mode (`enough_peers=false`) is silent today.
- mainLoop death is silent until process dies.
- Port drift, silent-success boot steps, swallowed uncaught exceptions all invisible.
- Container healthcheck hits an unconditional 200 endpoint.
- 5 of 7 compose services have no healthcheck.

**Net effect:** single source of truth in `getSharedState.subsystems` + `getSharedState.bootSequence`, surfaced via `/health` JSON + Prometheus metrics + TUI. Container + compose healthchecks point at real signal.

## What we keep / build on (do not duplicate)

PR #797 already shipped:
- `/health` endpoint returning `{version, version_name, accepting, mempool_size, uptime_s}` with 200/503 split on `syncStatus && !inSyncLoop && mempool OK`.
- Rate-limit allowlist for `/health` (`rateLimiter.ts:286-291`).

This epic **extends** the JSON shape additively (preserves existing keys) and adds subsystem/boot/port/error blocks.

## Risks / constraints

1. **JSON shape contract:** keep all PR #797 keys to avoid breaking external probes. Only add.
2. **`uncaughtException` swallow policy** stays as-is for now — just instrumented. Don't change behavior without a separate decision.
3. **Logger is string-only** — boot tracker lives in `getSharedState`, not in log lines (logs are human-readable mirror).
4. **TUI integration**: `TUIManager.NodeInfo.subsystems` extension must not break the existing TUI render path.
5. **mainLoop heartbeat threshold** must be tuned so genuine long syncs don't false-positive as "dead". Suggest threshold = max(loop interval × 3, 30s).
6. **Metrics cardinality:** `subsystem` label has ~10 values, `boot_step` has 20 — safe for Prometheus. Don't add per-peer or per-request labels here.

## Out of scope

- ~~Changing `process.exit(1)` policy at `src/index.ts:835` (mainLoop debug exit) — separate decision, recorded but not flipped here.~~ **DONE 2026-05-14 by Epic 14 T3.** This epic still owns the full `/health` extension, heartbeat staleness threshold, and mainLoop liveness alert.
- Replacing the categorized logger.
- Alert routing (PagerDuty/Slack) — alert *rules* are in scope, but receiver config is deployment-specific and goes in a runbook.

## Task Breakdown (sequenced)

### Phase A — Subsystem registry (single source of truth)

**T1 — Add `SubsystemRegistry` to `getSharedState`.**
- File: `src/utilities/sharedState.ts` (~line 105+).
- Add typed struct:
  ```typescript
  type SubsystemStatus = "pending" | "running" | "ready" | "failed" | "skipped" | "dormant";
  type SubsystemInfo = {
    status: SubsystemStatus;
    since: number | null;       // unix ms when entered current status
    port?: number | null;
    requestedPort?: number | null;
    lastError?: { at: number; message: string; source?: string } | null;
    enabled?: boolean;
    extra?: Record<string, unknown>;
  };
  ```
- Add `getSharedState.subsystems: Record<string, SubsystemInfo>` initialized empty.
- Add helpers (in `sharedState.ts` or a new `src/utilities/subsystemRegistry.ts`):
  - `markSubsystem(name, status, opts?)` — updates registry + emits log line `[BOOT] subsystem <name>: <status>` + (in T6) updates metric.
  - `subsystemError(name, err, source?)` — sets status `failed`, records error.
  - `getSubsystemSnapshot()` — returns deep clone for serialization.
- Registered subsystems (10): `chain, rpc, metrics, signaling, mcp, tlsnotary, omni, dtr, l2ps, main_loop`.
- Acceptance: unit test asserts state transitions; existing code not regressed (no usages yet).

**T2 — Add `BootTracker` for the 20-step boot sequence.**
- File: new `src/utilities/bootTracker.ts`.
- Struct: ordered list of steps `{idx, name, status, startedAt, finishedAt, error?, skippedReason?}`.
- API: `bootTracker.register(name)` (called at module-load for each step), `bootTracker.start(name)`, `bootTracker.ready(name)`, `bootTracker.fail(name, err)`, `bootTracker.skip(name, reason)`, `bootTracker.snapshot()`.
- Persist to `getSharedState.bootSequence`.
- Acceptance: unit test for state machine.

### Phase B — Wire registry + tracker into `src/index.ts`

**T3 — Bracket every `ANCHOR` with BootTracker calls.**
- File: `src/index.ts` — anchors at lines 130, 138, 241, 250, 310, 373, 382, 391, 413, 478, 502, 552, 587, 605, 622, 684, 826, 840, 857, 868, 874.
- Pattern:
  ```typescript
  bootTracker.start("chain.setup");
  try {
    await Chain.setup();
    bootTracker.ready("chain.setup");
    markSubsystem("chain", "ready");
  } catch (e) {
    bootTracker.fail("chain.setup", e);
    subsystemError("chain", e);
    throw e;
  }
  ```
- Replace silent-success calls (`Chain.setup`, `Mempool.init`, `loadNetworkParameters`, `ParallelNetworks.loadAllL2PS`) with bracketed versions.
- The `enough_peers=false` branch (line 587-594): set `getSharedState.dormantMode = true`; for each skipped subsystem call `markSubsystem(name, "skipped", {reason: "no peers"})`.
- Acceptance: starting node with TUI off, `curl localhost:53550/health/subsystems` (T7) returns all 10 with correct statuses for normal boot AND dormant boot.

**T4 — Add port-drift logging inside `getNextAvailablePort`.**
- File: `src/index.ts:229-239`.
- Signature: `getNextAvailablePort(startFrom: number, reason: string): Promise<number>`.
- Inside loop, after match: if `startFrom !== originalStartFrom`, `log.warning(\`[PORT] ${reason} drifted from ${originalStartFrom} to ${startFrom}\`)`.
- Update all call sites (lines 268, 279, 552, 622) to pass reason (`"signaling"`, `"omni"`, `"metrics"`, `"mcp"`).
- Also populate `subsystems[name].requestedPort` and `.port` accordingly.
- Acceptance: unit test pinned to a busy port; logs drift; subsystem record reflects both values.

**T5 — Add mainLoop heartbeat.**
- File: `src/utilities/mainLoop.ts` (whichever file contains `mainLoop()`).
- At top of each iteration: `getSharedState.mainLoopHeartbeatAt = Date.now()`.
- Add `markSubsystem("main_loop", "ready")` on first heartbeat.
- Remove the debug `process.exit(1)` in `.finally` at `src/index.ts:827-837`. Replace with:
  ```typescript
  mainLoop()
    .catch(e => { subsystemError("main_loop", e); log.error("[MAIN] mainLoop crashed:", e); })
    .finally(() => { markSubsystem("main_loop", "failed", {extra: {reason: "loop_returned"}}); log.warning("[MAIN] mainLoop ended (not crashed) — node will continue serving RPC but is non-functional for consensus"); });
  ```
- Document this in `docs/discoveries/.../05-fragility-synthesis.md` as a behavior change.
- Acceptance: test that kills mainLoop and asserts RPC stays up + `/health` shows `main_loop.up=false`.

### Phase C — Surface state

**T6 — Add metrics gauges/counters.**
- File: `src/features/metrics/MetricsService.ts` + `MetricsCollector.ts`.
- New gauges:
  - `demos_subsystem_up{subsystem}` (0/1).
  - `demos_subsystem_uptime_seconds{subsystem}`.
  - `demos_boot_step_status{step,name}` (0=pending, 1=running, 2=ready, 3=failed, 4=skipped).
  - `demos_boot_complete` (0/1).
  - `demos_dormant_mode` (0/1).
  - `demos_main_loop_heartbeat_seconds` (seconds since last heartbeat).
  - `demos_port_drift{service}` (`actual - requested`).
- New counters:
  - `demos_uncaught_exception_total{source}` — incremented by hooks at `src/index.ts:53-61`.
  - `demos_unhandled_rejection_total{source}`.
  - `demos_subsystem_restart_total{subsystem}` (for future use).
  - `demos_main_loop_iterations_total`.
- Collector reads `getSharedState.subsystems` + `getSharedState.bootSequence` periodically (e.g. every 5s aligned with prom scrape).
- Acceptance: `curl localhost:9090/metrics | grep demos_subsystem_up` returns all 10; values flip correctly when a subsystem fails (forced in test).

**T7 — Extend `/health` JSON.**
- File: `src/libs/network/server_rpc.ts:55-86` (the existing handler).
- Build response merging existing PR #797 keys with new blocks per the research:
  ```json
  {
    "version": "...", "version_name": "...", "accepting": true,
    "mempool_size": 42, "uptime_s": 1234,
    "status": "ok | degraded | dormant | failing",
    "dormant": false,
    "boot": {"complete": true, "steps_total": 20, "steps_ready": 20, "steps_failed": 0, "steps_skipped": 0, "current": null},
    "subsystems": { ... per T1 registry ... },
    "ports": { ... per T4 ... },
    "errors": {"uncaught_total": 0, "unhandled_rejection_total": 0, "last_uncaught": null}
  }
  ```
- HTTP status:
  - `ok` → 200 (everything ready).
  - `degraded` → 200 (optional subsystem failed, e.g. L2PS) — preserves PR #797 200 semantics.
  - `dormant` → 200 (intentional idle — `enough_peers=false`). Add header `X-Demos-Dormant: true` for LB metadata.
  - `failing` → 503 (chain DB down, mempool unreachable, mainLoop dead more than threshold).
- Add slim sibling endpoint `/health/subsystems` returning only the subsystems block (for ops dashboards).
- Acceptance: contract test compares response against frozen golden JSON for: healthy boot, dormant boot, mainLoop-dead state, chain-DB-down state.

**T8 — Hook `uncaughtException` / `unhandledRejection` counters.**
- File: `src/index.ts:53-61`.
- Inside both handlers: `metrics.incrementCounter("demos_uncaught_exception_total", {source})`, set `getSharedState.lastUncaughtException = {at: Date.now(), source, message}`.
- Behavior (swallow + continue) unchanged.
- Acceptance: forced crash in a subsystem bumps counter, surfaces in `/health.errors.last_uncaught`.

**T9 — TUI integration.**
- File: `src/utilities/tui/TUIManager.ts:37+`.
- Extend `NodeInfo` with `subsystems: Record<string, {status, port?, lastError?}>`.
- Wire `tuiManager.refreshSubsystems()` to read `getSharedState.subsystems` snapshot at the same cadence as other refreshes.
- Add a TUI panel "Subsystems" showing each row.
- Acceptance: manual TUI smoke test — see all 10 subsystems with statuses; force a subsystem failure → row turns red.

### Phase D — Container + compose healthchecks

**T10 — Fix Dockerfile healthcheck target.**
- File: `Dockerfile:200-201`.
- Change `curl -fsS "http://localhost:${RPC_PORT}/"` → `curl -fsS "http://localhost:${RPC_PORT}/health"`.
- Bump `--start-period=90s` (genesis init can be slow).
- Acceptance: `docker inspect` shows new healthcheck; a dormant node correctly reports as healthy (200 with dormant flag), a failing node 503.

**T11 — Add compose-level healthchecks.**
- File: `docker-compose.yml`.
- Add healthchecks to: `node` (curl `/health` — match Dockerfile but explicit in compose), `prometheus` (`wget --spider /-/healthy`), `grafana` (`wget --spider /api/health`), `node-exporter` (`wget --spider /metrics`), `neo4j` (`wget --spider /` on 7474).
- All: `interval: 30s, timeout: 5s, retries: 3, start_period: 30s` (90s for node, 60s for neo4j).
- Acceptance: `docker compose ps` shows `(healthy)` for all 7 services after warmup.

**T12 — Add log rotation caps to compose.**
- File: `docker-compose.yml`.
- Either top-level `x-logging:` anchor or per-service:
  ```yaml
  logging:
    driver: json-file
    options:
      max-size: "50m"
      max-file: "5"
  ```
- Apply to all services.
- Acceptance: `docker inspect <container> | jq '.[0].HostConfig.LogConfig'` shows caps.

**T13 — Make grafana depend on prometheus health, not just start.**
- File: `docker-compose.yml` — change short-form `depends_on: [prometheus]` to long-form `depends_on: prometheus: {condition: service_healthy}`.
- Acceptance: forcing prometheus restart causes grafana to wait.

### Phase E — Alerts + dashboards

**T14 — Write Prometheus alert rules.**
- New files in `monitoring/prometheus/alerts/`:
  - `node-health.yml` — alerts: `NodeDown` (up==0 for 1m), `NodeDormant` (`demos_dormant_mode==1 for 10m`), `NodeFailing` (`demos_subsystem_up{subsystem="main_loop"}==0 for 2m`), `MempoolStuck` (`rate(demos_transactions_total[5m])==0 AND demos_mempool_size>0 for 10m`), `PeersZero` (`demos_peer_online_count==0 for 5m`), `BootIncomplete` (`demos_boot_complete==0 for 5m`).
  - `subsystem-down.yml` — generic: `SubsystemDown` per-label (`demos_subsystem_up==0 for 2m`).
  - `node-uncaught.yml` — `UncaughtSpike` (`increase(demos_uncaught_exception_total[5m]) > 10`).
- Uncomment `rule_files: [alerts/*.yml]` in `prometheus.yml`.
- Acceptance: `promtool check rules monitoring/prometheus/alerts/*.yml` passes; `promtool test rules` for at least one rule.

**T15 — Update Grafana dashboard.**
- File: `monitoring/grafana/provisioning/dashboards/json/demos-overview.json`.
- Add row "Subsystems" with stat panels per `demos_subsystem_up` label.
- Add row "Boot" with table showing `demos_boot_step_status`.
- Add panel `demos_main_loop_heartbeat_seconds` (gauge with thresholds — green <30s, amber <120s, red >120s).
- Acceptance: dashboard renders without "no data" panels in a running devnet.

### Phase F — Documentation

**T16 — Runbook: interpret `/health` response.**
- New file: `docs/runbooks/health-endpoint.md`.
- Document every field with example values and the meaning of each `status` level. Include curl examples for common probes (k8s readiness, LB health, manual sanity check).
- Acceptance: file exists.

**T17 — Runbook: diagnose dormant mode.**
- New file: `docs/runbooks/dormant-mode.md`.
- Symptoms (`status=dormant`, `peers=0`, `signaling.skipped`), causes (empty `demos_peerlist.json`, network egress blocked, all known peers down), recovery steps (curl `/peerlist`, check bootstrap nodes, restart with valid peer list).
- Acceptance: file exists; references `demos_peerlist.json` config + the actual code path at `src/index.ts:589`.

**T18 — Update assessment + index docs.**
- Files: `docs/discoveries/startup-assessment-2026-05-13/02-startup-trace.md`, `05-fragility-synthesis.md` — mark Tier 1 items #1-#4 as DONE with PR refs.
- Update `docs/INDEX.md` + `docs/manifest.json` to list new runbooks.
- Add `coding-node` hindsight memories: pointers to runbooks + the `/health` JSON contract.
- Acceptance: docs reflect post-epic reality.

## Acceptance Criteria for Epic 2 (whole)

- Every one of the 20 boot steps emits start/ready/fail/skipped log + boot-tracker entries.
- `/health` JSON includes `subsystems`, `boot`, `ports`, `errors` blocks alongside PR #797 keys.
- Dormant mode is visible: `/health.dormant=true`, `demos_dormant_mode==1`, Grafana row red, alert fires after 10 min.
- mainLoop death no longer kills process; `/health.subsystems.main_loop.up=false`, alert fires.
- Container healthcheck no longer passes for a dormant-and-mainLoop-dead node (returns 503).
- 5 missing compose healthchecks added; all services report `(healthy)` in `docker compose ps`.
- Prometheus has alert rules; Grafana dashboard shows subsystem + boot panels.
- All docs updated.

## Test Plan

1. **Unit:** `SubsystemRegistry` state transitions; `BootTracker` state machine; `getNextAvailablePort` drift logging.
2. **Integration:** spin devnet, kill chain DB → assert `/health` 503 + `chain.up=false`; kill mainLoop → assert `/health.subsystems.main_loop.up=false` + RPC still 200.
3. **Contract:** golden-JSON test for `/health` response in 4 known states.
4. **Container:** docker-compose up → all services `(healthy)`; stop one → corresponding alert fires within rule interval.
5. **Long-running:** 24h devnet → no false-positive alerts; log rotation caps respected.

## Definition of Done

- All 18 tasks closed in myc.
- PR merged with passing CI.
- Devnet smoke test green for 24h.
- Runbooks `health-endpoint.md` and `dormant-mode.md` validated by following them during a forced-fault drill.
- `coding-node` hindsight bank carries memories for the new contract + runbooks.
