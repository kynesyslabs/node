---
type: discovery-slice
title: Fragility Synthesis & Ranked Risks
date: 2026-05-13
status: assessment-only
---

# Fragility Synthesis & Ranked Risks

Cross-cuts the four data slices. Maps each operator complaint to concrete evidence and ranks remediation hooks by impact. **No code changes proposed yet** — this is the diagnosis, not the prescription.

## Operator Complaint → Evidence

### Complaint 1 — "Hard to debug what started and what didn't"

| Symptom | Concrete cause | Where |
|---|---|---|
| Stalled terminal, no output | DB init has no success log; if `setupChainDb` hangs on `PG_PORT 5332`, nothing prints until next step | `src/index.ts:478`, `src/libs/blockchain/chain.ts:46-50` |
| Same as above for mempool | `Mempool.init` silent | `src/libs/blockchain/mempool.ts:22` |
| Wrong port shown vs reality | `getNextAvailablePort` drift unlogged — operator can't see "wanted X, got Y" | `src/index.ts:268, 279, 552, 622` |
| Node appears healthy, network frozen | `if (enough_peers)` gate silently skips signaling, MCP, TLSN, mainLoop, DTR, L2PS — RPC and metrics keep answering | `src/index.ts:589-594` |
| "Started" log lies | `SignalingServer` ctor logs bind line **before** bind verified; bind failures surface async | `src/index.ts:608-614`, `signalingServer.ts:117` |
| Subsystem crashes invisible | `uncaughtException`/`unhandledRejection` swallow + continue | `src/index.ts:53-61` |
| Node "just dies" with no error | `mainLoop().finally(() => process.exit(1))` always exits, masking reason | `src/index.ts:827-837` |
| Hard-exit without preceding log | TLSNotary fatal, OmniProtocol no-adapter, dead signaling exit branch | `src/index.ts:706, 523, 614` |
| Bare-metal launcher hides progress | `scripts/run` `log_verbose` only fires under `VERBOSE=true` | `scripts/run:32` |

### Complaint 2 — "Too many open ports and certificates on remote servers"

**Reality check** — only the first half of the complaint is supported by code:

- **Ports — real problem:** default profile (monitoring + tlsnotary) exposes **7 host ports**; full profile reaches **11**, plus a 2000-port ephemeral pool for wstcp.
- **Certs — mostly perception:** only **1 endpoint uses real X.509 today** (OmniProtocol 53551, conditional). Most exposed ports are cleartext — the operator is correct that *they should be behind TLS*, but they don't currently *need* per-port certs.
- **What's actually exposed and shouldn't be:** MCP 3001, Signaling 3005, Metrics 9090, Prometheus 9091, Grafana 3000, Node Exporter 9100, Neo4j 7474/7687. None of these belong on a public interface in prod.
- **Collapsible:** RPC 53550, MCP 3001, Signaling 3005 (WSS), Metrics 9090, Grafana 3000, Prometheus 9091 → reverse-proxy candidates behind 1× 443 with single Let's Encrypt cert. **6 ports → 1 cert.**
- **Must stay direct:** OmniProtocol 53551 (custom-fingerprint TLS), wstcp pool (per-session ephemeral — verify whether public bind is actually required vs container-internal).
- **Postgres 5432:** already commented out in compose. **Internal-only by default** — good.
- **GroundControl 10250:** in-process, not in compose `ports:` — verify host-network mode doesn't accidentally expose it.

### Complaint 3 — "Stack feels fragile"

| Class | Concrete issues |
|---|---|
| Build pipeline | `start_db` script has corrupted bash expansions (lines 110, 151, 155, 158, 163, 174, 218, 251); `scripts/run` line 648 has dead branch above an unconditional override; `bun pm trust --all \|\| true` silently swallows trust failures |
| Container lifecycle | No `tini`/`dumb-init`, bun is PID 1, child processes may orphan on `docker stop`; runtime image lacks `nc` (referenced by run script if invoked); `wstcp` not baked into image — code paths needing it break in container |
| Compose layer | 5 of 7 services have no healthcheck; `grafana depends_on prometheus` uses legacy short-form (no condition); `node` itself has no compose-level healthcheck (only Dockerfile-level) |
| Shutdown | `scripts/run` traps INT but **not TERM** — `kill <pid>` or systemd stop leaves docker sidecars running; OmniProtocol "fallback" actually `process.exit(1)`s, contradicting comment |
| Defaults | Default passwords in `.env.example` baked into compose via `${VAR:-default}` (`PG_PASSWORD=demospassword`, `GRAFANA_ADMIN_PASSWORD=demos`, `NEO4J_AUTH=neo4j/changeme-please`); `EXPOSED_URL=http://localhost:53550` default useless for real peers |
| Multi-instance | `postgres → postgres_<port>` folder-copy hack for parallel instances is brittle; many hardcoded ports across scripts (`5332`, `53550`, `7047`, `3000`, `9091`) |
| First-run state | `.RUN` sentinel skips install on subsequent runs even when `bun.lock` changed |
| `reset-node` | `rm -rf` after `cd parent_dir` — destructive if symlink resolves unexpectedly; backs identity up to `parent_dir` (potentially `/`) |

## Ranked Remediation Hooks

Ranked by **impact ÷ effort**. Each item maps to a specific file:line. **None are implemented in this assessment.**

### Tier 1 — High impact, low risk

1. **Make the dormant-node failure mode visible** — `src/index.ts:589-594`. Add an explicit `log.warning("⚠️ DORMANT MODE: peer list empty; signaling/MCP/TLSN/mainLoop/DTR/L2PS skipped")` and surface this in metrics + RPC `/health`. Single biggest cure for "node looks alive but isn't" confusion.
2. **Add explicit start/ready markers** for the 3 silent-success steps: `Chain.setup`, `Mempool.init`, `ParallelNetworks.loadAllL2PS`. Pattern: `log.info("[<subsystem>] ready in <ms>ms")`.
3. **Add a real container healthcheck in compose** for the `node` service — copy/extend the Dockerfile HEALTHCHECK to compose, change endpoint from `/` to a dedicated `/health` route that asserts: DB up, chain seeded, peers loaded, mainLoop running. Surface dormant mode as `degraded`.
4. **Stop logging "Server is running on…" before actual bind verification.** Move log to after Bun confirms listen (`server.start()` resolution in `server_rpc.ts:196-197`; `signalingServer.ts:117`).

### Tier 2 — High impact, moderate effort

5. **Reverse-proxy the 6 collapsible HTTP ports behind 1×443.** Add an optional `caddy`/`traefik` service in a `proxy` compose profile. Documents the only real path to fewer certs on remote servers. **6→1 cert.**
6. **Replace `mainLoop().finally(process.exit(1))`** with a structured shutdown: log the actual exit cause (clean vs crash), drain RPC, close DB. The current `process.exit(1)` is a debug-time choice that became permanent. **DONE 2026-05-14 (Epic 14 T3).** Full Epic 13 `/health` + heartbeat extension still pending.
7. **Re-enable subsystem failures to actually crash the node** when appropriate. The blanket `uncaughtException`/`unhandledRejection` swallowers (`src/index.ts:53-61`) mean any dead subsystem looks like a healthy one. Either let crashes bubble, or add a "degraded subsystems" tracker exposed in `/health`.

### Tier 3 — Cleanup, lower priority

8. **Fix `scripts/start_db` bash expansion corruption** (lines 110, 151, 155, 158, 163, 174, 218, 251).
9. **Delete dead code:** `scripts/run:614-647` (overridden by line 648); `src/index.ts:608-614` (SignalingServer null-check on `new`).
10. **Add SIGTERM trap to `scripts/run`** so systemd/docker stop cleanly tear down sidecars.
11. **Add `tini` to runtime image** for proper zombie reaping under bun-as-PID-1.
12. **Document or fix the OmniProtocol fallback contradiction** at `src/index.ts:523` — the "failsafe" actually exits.
13. **Add healthchecks** to grafana, prometheus, neo4j, node-exporter.

## Honest Assessment

- The stack **is** fragile, but mostly in observable, fixable ways — not architecturally rotten.
- The "many certs" perception is partly real (too many host ports) and partly a misdiagnosis (most ports don't currently have TLS at all, which is the bigger problem).
- The single highest-leverage improvement is **making the dormant-node failure mode loud and impossible to miss**. Everything else is incremental.
- The container image is well-built (two stages, non-root user, explicit COPY allow-list, prune pass). The runtime is the weak link.
- The bare-metal launcher (`scripts/run`) carries a lot of one-off accumulated hacks (sed-patching `falcon-sign`, folder-copy multi-instance, sentinel-skip installs). Replacing it with a slimmer wrapper would help, but not urgent unless someone is actively maintaining it.

## Source Cross-Reference

All findings traceable to one of:
- `01-compose-services.md` — service map
- `02-startup-trace.md` — boot sequence + observability gaps
- `03-ports-and-certs.md` — network surface
- `04-scripts-and-dockerfile.md` — build/run pipeline
