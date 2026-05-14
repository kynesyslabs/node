---
type: changelog
title: Startup Assessment Changelog
---

# Startup Assessment Changelog

## 2026-05-14 — Epic 13 (observability) lands

Full implementation of `07-epic-2-healthcheck-observability.md`. The
node now exposes its internal state via `/health`, Prometheus metrics,
the TUI, and Grafana — surfacing dormant mode, mainLoop liveness, port
drift, swallowed errors, and per-subsystem status that were previously
invisible.

Changes:

- **T1 — SubsystemRegistry**
  - `src/utilities/subsystemRegistry.ts` (new): typed registry of 10
    known subsystems (chain, rpc, metrics, signaling, mcp, tlsnotary,
    omni, dtr, l2ps, main_loop). Helpers `markSubsystem`,
    `subsystemError`, `snapshotSubsystems`. Lifecycle states
    pending/running/ready/failed/skipped/dormant. State transitions
    emit a one-line log; `since` timestamps stamped on real change.
- **T2 — BootTracker**
  - Same file. Append-only ordered log of named boot steps with
    register/start/ready/fail/skip API. `summary()` aggregates counts
    for `/health.boot`. Deep-clone snapshots for serialisation.
  - +12 unit tests in `subsystemRegistry.test.ts`, all passing.
- **T3 — Boot anchor brackets**
  - `src/index.ts`: every major boot step now wraps `bootTracker.start`
    / `ready` / `fail` + `markSubsystem`. Silent-success steps
    (Chain.setup, Mempool.init, fastSync, ParallelNetworks.loadAllL2PS)
    now emit `[BOOT] ... ready` lines. The dormant-mode block
    (`enough_peers=false`) sets `getSharedState.dormantMode = true`,
    logs a clear warning, and marks signaling / MCP / TLSNotary /
    main_loop / DTR / L2PS as skipped with reason "no peers".
- **T4 — Port-drift logging**
  - `getNextAvailablePort(startFrom, reason)`: now takes a reason arg
    and logs `[PORT] <reason> drifted from X to Y` whenever the
    chosen port differs from the requested one. All 4 call sites
    (signaling, omni, metrics, mcp) updated. Drift mirrored into the
    subsystem registry via `requestedPort` + `port`.
- **T5 — mainLoop heartbeat**
  - `src/utilities/mainLoop.ts`: top of `mainLoopCycle` sets
    `getSharedState.mainLoopHeartbeatAt = Date.now()`, increments
    `mainLoopIterations`, bumps the Prom counter, and on the very
    first tick marks `main_loop` as ready.
  - (`process.exit(1)` removal already shipped in Epic 14 T3.)
- **T6 — Metrics gauges + counters**
  - `MetricsService.registerCoreMetrics()` adds `demos_subsystem_up`,
    `_uptime_seconds`, `_restart_total`, `_error_total`,
    `demos_boot_step_status`, `demos_boot_complete`,
    `demos_dormant_mode`, `demos_main_loop_heartbeat_seconds`,
    `demos_main_loop_iterations_total`, `demos_port_drift`,
    `demos_uncaught_exception_total`,
    `demos_unhandled_rejection_total`.
  - `MetricsCollector.collectObservability()` reads
    `getSharedState.subsystems` + `bootTracker.summary()` on every
    tick (every 2.5s) and mirrors into the gauges.
- **T7 — /health JSON (additive over PR #797)**
  - `src/libs/network/server_rpc.ts`: extended `/health` body with
    `status` (ok|degraded|dormant|failing), `dormant`, `boot`,
    `subsystems`, `ports`, `main_loop`, `errors` blocks. PR #797
    keys preserved verbatim. HTTP status: 503 only on `failing`;
    dormant / degraded / ok all return 200. Adds
    `X-Demos-Dormant: true` response header in dormant state for LB
    metadata. New sibling endpoint `/health/subsystems` returns the
    subsystem block only (rate-limit bypassed).
- **T8 — Uncaught exception counters**
  - `src/index.ts:53-90`: process-wide handlers now bump
    `getSharedState.uncaughtExceptionTotal` /
    `unhandledRejectionTotal`, record `lastUncaughtException`, and
    increment the matching Prom counter. Swallow behaviour preserved.
- **T9 — TUI integration**
  - `src/utilities/tui/TUIManager.ts`: `NodeInfo` gained optional
    `subsystems` map and `dormantMode` flag. New
    `refreshSubsystems()` reads the live snapshot and is called on
    every refresh tick.
- **T10 — Dockerfile healthcheck target**
  - `Dockerfile`: HEALTHCHECK switched from `curl /` (always 200) to
    `curl /health`. `--start-period` bumped 60s → 90s.
- **T11 — Compose healthchecks**
  - `docker-compose.yml`: added healthchecks for `node`,
    `prometheus`, `grafana`, `node-exporter`, `neo4j`. All with
    sensible intervals + start_periods.
- **T12 — Log rotation caps**
  - `docker-compose.yml`: new `x-default-logging` YAML anchor with
    `max-size: 50m, max-file: 5`. Applied to every service via
    `<<: *default-logging`.
- **T13 — Grafana service_healthy dependency**
  - `grafana` now uses long-form `depends_on: prometheus: condition:
    service_healthy` instead of plain start-only wait.
- **T14 — Prometheus alert rules**
  - `monitoring/prometheus/alerts/node-health.yml` — NodeDown,
    NodeFailing, NodeDormant, BootIncomplete, MempoolStuck,
    PeersZero, MainLoopHeartbeatStale.
  - `subsystems.yml` — SubsystemDown, PortDriftDetected.
  - `errors.yml` — UncaughtExceptionSpike,
    UnhandledRejectionSpike.
  - `prometheus.yml`: uncommented `rule_files: alerts/*.yml`. All 11
    rules pass `promtool check`.
- **T15 — Grafana observability dashboard**
  - `monitoring/grafana/provisioning/dashboards/json/observability.json`
    (new): subsystem stat row, mainLoop heartbeat gauge, boot
    complete / dormant stat, boot-sequence table with status enum
    mappings, error-rate timeseries, iterations/s timeseries.
    Auto-provisioned alongside the existing dashboards.
  - Decision: shipped as new dashboard rather than mutating
    `demos-overview.json` (39KB, complex grid layout — high risk of
    breaking the existing dashboard on edit).
- **T16 — `docs/runbooks/health-endpoint.md`** (new)
- **T17 — `docs/runbooks/dormant-mode.md`** (new)
- **T18 — Index + manifest + CHANGELOG**
  - `docs/INDEX.md` + `docs/manifest.json` register the new runbooks.
  - Plan doc `07-epic-2-healthcheck-observability.md` annotated with
    implemented_tasks frontmatter + status banner.
  - `coding-node` hindsight memories retained.

Net effect:

- The dormant-mode failure ("node looks healthy but consensus frozen")
  is now loud + queryable + alertable. Single highest-impact fix from
  the original assessment.
- mainLoop death is detectable via `/health.main_loop.exited` and
  `demos_main_loop_heartbeat_seconds`. Combined with Epic 14 T3 (no
  more debug `process.exit(1)`), the node stays observable through a
  consensus failure instead of crash-looping silently.
- Port drift no longer silent. Operators see `[PORT] X drifted` lines
  and can query `/health.ports`.
- 5 missing compose healthchecks added. `docker compose ps` shows
  meaningful health state for every service.
- Prometheus alerts cover the failure modes called out in the
  fragility synthesis (Tier 1 + Tier 2 items #1–#3).
- All file-format checks pass: `tsc --noEmit` clean for changed files,
  `promtool check rules` 11/11 SUCCESS, `docker compose config`
  validates across every profile combo, `bun test
  src/utilities/subsystemRegistry.test.ts` 12/12 pass.

## 2026-05-14 — Epic 12 (reverse proxy) — autofix slice lands

Implementation slice of `06-epic-1-reverse-proxy.md`. Code, config, and
docs only — the live integration steps (cert provisioning, dropping
host ports, flipping wstcp bind, etc.) need operator action on a real
environment and are tracked as separate open tasks.

Changes:

- **T5 — Caddyfile**
  - `monitoring/caddy/Caddyfile` (new): single-vhost reverse proxy with
    routes for RPC `/`, signaling `/signaling/*`, MCP `/mcp/*`, metrics
    `/metrics`, Grafana `/grafana/*`, Prometheus `/prometheus/*`,
    TLSNotary `/tlsnotary/*`. Auto HTTPS via Let's Encrypt
    (`tls {$ACME_EMAIL}`). Strips inbound `X-Forwarded-*` headers
    before forwarding so Epic 14's `TRUSTED_PROXIES` model holds.
    Basic-auth on `/metrics` + `/mcp` with sentinel hashes that reject
    by default (operator generates real ones via
    `caddy hash-password`).
- **T6 — Compose service**
  - `docker-compose.yml`: `caddy` service under `profiles: [proxy]`,
    image `caddy:2-alpine`, host ports 80 + 443 (+ 443/udp for HTTP/3),
    volumes for `Caddyfile` (RO) + named `caddy_data` / `caddy_config`,
    healthcheck on `wget /:80`. New named volumes added at the bottom
    of the file. Default-profile compose unchanged (`caddy` does not
    start unless the operator opts in).
- **T7 — `.env.example` proxy block**
  - New section between MONITORING and TLSNOTARY documenting
    `PROXY_DOMAIN`, `ACME_EMAIL`, `METRICS_BASIC_AUTH_HASH`,
    `MCP_BASIC_AUTH_HASH`, `GRAFANA_ROOT_URL`,
    `GRAFANA_SERVE_FROM_SUB_PATH`, `CORS_ALLOWED_ORIGINS`. Reminds
    operators to set `TRUSTED_PROXIES` (Epic 14) alongside.
  - `COMPOSE_PROFILES` comment updated to list the new `proxy` profile
    + recommended `monitoring,tlsnotary,proxy` production pairing.
- **T10 — Grafana sub-path**
  - `docker-compose.yml`: added `GF_SERVER_SERVE_FROM_SUB_PATH` env,
    defaulting to `false`. Operator flips it + sets
    `GRAFANA_ROOT_URL=https://${PROXY_DOMAIN}/grafana/` to engage.
- **T11 — Prometheus sub-path**
  - Caddyfile uses `handle_path /prometheus/*` (prefix-strip) so the
    Prometheus container stays at root with no `--web.route-prefix`.
    Documented UI-asset caveats + the subdomain escape hatch in
    `proxy-setup.md`.
- **T12 — CORS allowlist**
  - `src/libs/network/bunServer.ts`: `cors()` middleware now reads
    `CORS_ALLOWED_ORIGINS`. Default behaviour preserved (`*` wildcard)
    but emits a one-time `log.warning` at startup if the node also
    detects `PROXY_DOMAIN` is set to a non-localhost value (i.e., the
    wildcard is exposed publicly). Allowlist matching is
    case-insensitive + strips trailing slashes. Preflight OPTIONS now
    returns 204 instead of 200.
- **T15 — `docs/runbooks/proxy-setup.md`** (new)
  - Step-by-step bring-up: env, DNS, firewall, ACME, smoke tests,
    rollback. Common failures section (ACME challenges, rate limits,
    Grafana asset breakage, Prometheus sub-path caveats, MCP 401).
- **T16 — `docs/runbooks/proxy-add-service.md`** (new)
  - Pattern for routing a new internal service via sub-path or
    subdomain. Validation + zero-downtime reload commands.
- **T17 — Cross-references + index**
  - `docs/INDEX.md` + `docs/manifest.json` register the two new
    runbooks.
  - `coding-node` hindsight memories retained.

Closed via Epic 14 (no Epic 12 commit needed):

- **T1** — Trusted-proxy + XFF policy (closed in Epic 14 T1).
- **T2** — MCP auth decision (closed via Epic 14 T2, Option C).
- **T3** — MCP binding vs port mapping (closed via Epic 14 T2).

Deferred to live verification (NOT in this commit):

- **T4** — wstcp 0.0.0.0 reachability per-env verify (read-only
  verdict documented; operator runs the one-liner).
- **T8** — Path-mode `EXPOSED_URL` end-to-end with SDK integration
  test against running devnet + proxy.
- **T9** — `wstcp --bind-addr 127.0.0.1`. Containerized default OK;
  bare-metal breaks. Gate on Caddy being co-located.
- **T13** — Drop redundant host port mappings. Risky before smoke
  test of every proxied route in a real deployment.
- **T14** — TLSNotary 7047 disposition behind proxy. Needs live WS
  termination test against the upstream notary binary.

## 2026-05-14 — Epic 14 (blockers) lands

Implementation of `08-epic-3-blockers.md`. Cleared the three blockers
called out for Epic 12 (reverse proxy) + Epic 13 (observability). Epic 12
and Epic 13 may now be scheduled.

Changes:

- **T1 — XFF spoof fix**
  - `src/libs/network/middleware/rateLimiter.ts`: rewrote `getClientIP`
    with a 3-mode behavior (off / strict / legacy). Resolved at
    construct time from `XFF_MODE` + `TRUSTED_PROXIES` env vars or
    explicit config. IP normalisation (`ipaddr.js` + IPv4-mapped IPv6
    collapse + RFC 5952 canonical IPv6) prevents bucket-multiplier
    attacks via representation variants. Dead `isTrustedProxy`,
    `extractForwardedIP`, `isValidIP` removed. XFF-rejection logged
    sample-rated (max 1/min/source).
  - `src/config/envKeys.ts`, `defaults.ts`, `loader.ts`, `types.ts`,
    `src/utilities/sharedState.ts`: wired `TRUSTED_PROXIES` +
    `XFF_MODE`. Default mode = `off` when list empty.
  - `.env.example`: documented SECURITY block.
  - `package.json`: `ipaddr.js@2.4.0` added.
  - `src/libs/network/rateLimiter.test.ts`: +16 unit tests covering all
    three modes, CIDR boundaries, IPv6 normalisation, invalid-input
    safety. (Two pre-existing `isTrustedInternalRequest` tests are
    flaky on `main` — out of scope for this epic.)
- **T2 — MCP lockdown**
  - `docker-compose.yml`: removed host publish of `${RPC_MCP_PORT}:3001`.
    MCP is now reachable only inside the docker network.
  - `src/config/defaults.ts`: `mcpEnabled: true → false` (default-off).
  - `src/features/mcp/MCPServer.ts`: POST `/message` validates the SSE
    `sessionId` query param (CSRF defense-in-depth). Mismatch yields
    HTTP 401.
  - `.env.example`: MCP block annotated; `MCP_ENABLED=false` example.
  - `src/features/mcp/README.md`: security banner added.
  - `docs/runbooks/mcp-security.md`: new — threat model + safe
    enablement path.
- **T3 — mainLoop wrapper**
  - `src/index.ts:827-857`: removed the debug `process.exit(1)` from
    `.finally` (was originally commit `455d615b` "try: debug
    terminate on mainloop failure"). Replaced with structured exit
    recording in `sharedState` + a differentiated log line (info on
    graceful shutdown, error otherwise). Incidentally fixes the
    latent bug where the wrapper's exit-1 was overriding
    `gracefulShutdown`'s exit-0 (so `docker stop` now exits with code
    0, not 1).
  - `src/utilities/sharedState.ts`: added `mainLoopExited`,
    `mainLoopExitedAt`, `mainLoopExitReason` fields for Epic 13 to
    consume.
- **T0 — wstcp reachability**
  - `docs/runbooks/wstcp-reachability-check.md`: new — operator
    one-liner + verdict table.
- **T4 — docs close-out**
  - `docs/INDEX.md`, `docs/manifest.json` updated with new runbooks +
    epic plan files.
  - `coding-node` hindsight bank: 4 memories retained.

Net effect:
- Anyone spoofing `X-Forwarded-For` no longer steals trust or
  multiplies their rate-limit bucket.
- MCP is no longer accidentally reachable from outside docker.
- mainLoop death no longer kills the node; `docker stop` exits code 0.
- Epic 12 and Epic 13 risk registers no longer reference these
  blockers as open items.
