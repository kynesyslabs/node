---
type: plan
title: "Epic 3 — Pre-flight Blocker Fixes"
date: 2026-05-14
status: ready-for-myc
depends_on:
  - docs/discoveries/startup-assessment-2026-05-13/05-fragility-synthesis.md
  - docs/discoveries/startup-assessment-2026-05-13/06-epic-1-reverse-proxy.md
  - docs/discoveries/startup-assessment-2026-05-13/07-epic-2-healthcheck-observability.md
---

# Epic 3 — Pre-flight Blocker Fixes

## Why this epic exists

Three blockers were surfaced in Epic 1 and Epic 2 planning. They must land **before** the reverse-proxy and observability work, because:

1. **XFF spoof** (`rateLimiter.ts:136-160`) — putting Caddy in front without fixing this makes source-IP spoofing trivial. Today it is *already exploitable* (clients can send fake XFF and steal whitelisted-IP trust), but a proxy makes the fix mandatory because *every* request will arrive from the proxy.
2. **MCP zero auth + dead port mapping** (`MCPServer.ts:253-343`, `docker-compose.yml:162`, `src/index.ts:629`) — the current compose `3001:3001` mapping points at nothing inside the container (MCP binds `localhost`). Worse, `get_node_identity` + `get_peer_list` leak the node's publicKey and peer topology to any reachable client. **Unsafe to expose at all** until SDK gets auth.
3. **mainLoop debug `process.exit(1)`** (`src/index.ts:827-837`) — any mainLoop error kills the node despite the swallow-policy comment at `:53-61`. Research uncovered a **second latent bug**: this also overrides `gracefulShutdown`'s `process.exit(0)` so `docker stop` exits code 1.

Plus one read-only verification (T0) that informs Epic 12 task T9:

4. **wstcp pool reachability** — confirmed de facto internal in containerized default deployments. No code change needed in this epic; just document the verdict so Epic 12 can rely on it.

## What we are NOT doing here

- Not adding the full subsystem registry / boot tracker — Epic 13.
- Not building bearer-auth for MCP — research recommends Option A (internal-only) for the blocker, Option C (Caddy bearer + bind `0.0.0.0`) for Epic 12.
- Not adding a Prometheus metric for XFF rejection — Epic 13 (T6 adds counters). This epic emits a **log line** only.
- Not changing OmniProtocol or signalingServer auth semantics.
- Not bumping `@modelcontextprotocol/sdk` — DEPS-AUDIT.md:95 follow-up, separate ticket.
- Not adding mainLoop heartbeat — Epic 13 T5.

The principle: **make safe-by-default the cheapest correct state, defer everything else to the right epic.**

## Tasks

### T0 — Record wstcp reachability verdict (read-only)

- **File**: `docs/discoveries/startup-assessment-2026-05-13/03-ports-and-certs.md` — add a "Reachability verdict" subsection under the wstcp row citing the new research.
- Conclusion to record: **containerized default deployment = de facto internal; bare-metal with `ufw allow 55000:60000/tcp` = host-exposed. Flipping to `127.0.0.1` is unsafe in bare-metal mode without a co-located reverse proxy.** Therefore Epic 12 T9 must be conditional on a reverse-proxy being present (which it will be).
- Also store the operator one-liner from the research as a runbook stub `docs/runbooks/wstcp-reachability-check.md` so anyone can verify in their own env.
- **Acceptance**: doc updated, one-liner reproducible.

### T1 — Fix XFF spoof in rate limiter

**Files touched:**
- `src/libs/network/middleware/rateLimiter.ts` (`getClientIP` at L136-160; delete dead `isTrustedProxy`/`extractForwardedIP` at L191-229)
- `src/config/envKeys.ts` (add `TRUSTED_PROXIES`, `XFF_MODE`)
- `src/config/loader.ts` (parse + validate)
- `src/config/defaults.ts` (defaults: empty list, mode auto-derived)
- `src/utilities/sharedState.ts:397-412` (add `trustedProxies: CIDR[]`, `xffMode` to `rateLimitConfig`)
- `.env.example` (document the new keys with examples for compose + bare-metal)
- `package.json` (`bun add ipaddr.js`)
- `src/libs/network/rateLimiter.test.ts` (new tests per research §test-plan items 1-12)

**Behavior contract (from research):**

| `TRUSTED_PROXIES` value | `XFF_MODE` override | Effective mode | What happens |
|---|---|---|---|
| empty | unset | **off** (default) | XFF/XRI/CF-Connecting-IP ignored; socket IP only. One-time `log.warning` at startup. |
| empty | `legacy` | **legacy** | Current insecure behavior preserved. `log.error` at startup. Opt-in escape hatch. |
| non-empty CIDR list | unset | **strict** | Honor XFF iff `server.requestIP(req).address ∈ TRUSTED_PROXIES`. Parse XFF right-to-left, return left-most non-trusted IP. On rejection: socket IP + sampled `log.warning`. |
| non-empty | `off` | **off** | TRUSTED_PROXIES ignored; warning at startup that user explicitly disabled. |

Implementation notes:
- Use `ipaddr.js`'s `IPv4.parseCIDR()` / `IPv6.parseCIDR()` + `match()` for trust checking.
- Normalize IPs before bucketing: `ipaddr.process(raw).toNormalizedString()` — prevents `192.168.1.1` vs `::ffff:192.168.1.1` vs `[::ffff:192.168.1.1]:443` from yielding separate buckets.
- Strip brackets + port from `x-real-ip` if present.
- Sample log: at most 1 in 100 XFF rejections per source socket IP per minute.
- Preserve loopback whitelist behavior (`LOCALHOST_IPS` from `constants.ts:35` keeps trusted-internal status).
- Delete dead `isTrustedProxy` + `extractForwardedIP` (L191-229).

**Acceptance:**
- All 12 unit tests in research §test-plan pass.
- `server_rpc.ts:37` `yourIP` echo returns socket IP when XFF_MODE=off (cosmetic change documented).
- `blocked_ips.json` does not gain entries when a single spoofed XFF batch is sent (regression).
- Startup logs show clear mode-selection line.

### T2 — Lock down MCP (Option A: internal-only)

**Files touched:**
- `docker-compose.yml:162` — **remove** the `"${RPC_MCP_PORT:-3001}:..."` line in `node.ports`. Add a comment block referencing this epic + DEPS-AUDIT.md:95.
- `src/config/defaults.ts:56` — flip `mcpEnabled: true` → `false`. Default-off prevents accidentally-on in fresh deployments.
- `.env.example` — add a documented block:
  ```bash
  # MCP server (Model Context Protocol — experimental, NO AUTH)
  # Off by default. Do not expose publicly until SDK gains auth.
  # See docs/runbooks/mcp-security.md
  # MCP_ENABLED=false
  ```
- `src/features/mcp/README.md:48,226-228` — strike examples of `host: "0.0.0.0"` or annotate "**REQUIRES reverse proxy with auth + DNS-rebinding guard; current SDK has no built-in auth. See DEPS-AUDIT.md.**"
- `src/features/mcp/MCPServer.ts:307-321` — research uncovered a **CSRF-like bug**: `POST /message` doesn't validate the `sessionId` query param against the SSE GET that opened the transport. Add a 1-line check that rejects with 401 when the param is missing or mismatched. This is *defense in depth* — Option A already makes MCP unreachable from outside docker, but the check is correct hygiene.
- New file: `docs/runbooks/mcp-security.md` — current state, risks (publicKey + peer leak), how to safely enable (only via Caddy bearer-auth in Epic 12 T2 follow-up), threat model.

**Acceptance:**
- `docker compose ps` shows no `3001/tcp` host publication.
- A fresh `cp .env.example .env && docker compose up` does not start MCP.
- `docker compose exec node curl http://localhost:3001/sse` still works (internal-only by design).
- POST /message with mismatched sessionId returns 401.
- Runbook exists and explains the threat model.

**Defers to Epic 12 T2:**
- Bearer-auth at Caddy.
- Bind `0.0.0.0` (only after Caddy lands).
- CORS allowlist (Epic 12 T12).

### T3 — Remove debug `process.exit(1)` from mainLoop wrapper

**Files touched:**
- `src/utilities/sharedState.ts:~169` — add 3 fields:
  ```typescript
  mainLoopExited = false;
  mainLoopExitedAt: number | null = null;
  mainLoopExitReason: string | null = null;
  ```
- `src/index.ts:827-837` — replace the wrapper per research §minimum-fix:

  ```typescript
  mainLoop()
      .catch((error: Error) => {
          console.error(error);
          log.error("[CORE] Error in main loop: " + error);
          handleError(error, "CORE", { source: ErrorSource.MAIN_LOOP });
          getSharedState.mainLoopExitReason =
              error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
          getSharedState.mainLoopExited = true;
          getSharedState.mainLoopExitedAt = Date.now();
          if (getSharedState.isShuttingDown) {
              log.info("[CORE] Main loop stopped (graceful shutdown)");
          } else {
              log.error(
                  "[CORE] Main loop terminated unexpectedly. " +
                  "Node continues serving RPC but is no longer producing blocks. " +
                  "Investigate.",
              );
          }
      }); // fire-and-forget; do NOT kill the process on exit
  ```
- Delete the unreachable `log.info("Main loop finished")` (was sitting after `process.exit(1)`).
- Add an inline comment referencing commit `455d615b` (debug origin) + this epic.

**Acceptance:**
- Inject `throw new Error("simulated")` in `mainLoopCycle` body via a `MAINLOOP_TEST_THROW` env guard (test-only); node stays alive, RPC keeps serving, log line printed.
- `docker stop demos-node` exits with **code 0** (graceful), not 1. This validates the latent secondary bug fix.
- Normal boot prints no `Main loop terminated` line during a 30s smoke test.

**Defers to Epic 13:**
- `/health` reading `mainLoopExited` to flip `accepting=false` / 503.
- Heartbeat timestamps and staleness threshold.
- Prometheus gauges for mainLoop liveness.
- Auto-restart of mainLoop.

### T4 — Documentation closeout

**Files touched:**
- `docs/discoveries/startup-assessment-2026-05-13/05-fragility-synthesis.md` — mark blocker items DONE with PR ref + commit shas.
- `docs/discoveries/startup-assessment-2026-05-13/06-epic-1-reverse-proxy.md` — strike "hard blocker" annotations on T1/T2/T4 prerequisites, link to this epic.
- `docs/discoveries/startup-assessment-2026-05-13/07-epic-2-healthcheck-observability.md` — strike risk #5 mention of mainLoop debug exit.
- `docs/INDEX.md` + `docs/manifest.json` — register new runbooks `mcp-security.md`, `wstcp-reachability-check.md`.
- New `docs/discoveries/startup-assessment-2026-05-13/CHANGELOG.md` initial entry: "2026-05-14: Epic 3 lands; blockers cleared; Epic 1/2 may now be scheduled."
- Hindsight `coding-node` retain memories: (1) XFF mode contract + default selection, (2) MCP internal-only stance + why, (3) mainLoop wrapper fix + latent docker-stop exit-code bug, (4) wstcp reachability verdict.

**Acceptance:**
- All cross-references updated.
- Hindsight bank carries 4 new memories tagged `blockers`, `epic-3`.

## Sequencing within the epic

T0 is read-only docs — can run in parallel with code work. T1, T2, T3 are independent (different files) — can be done as separate PRs or one bundled. T4 runs last.

Suggested PR layout:
1. PR — T1 (XFF spoof fix). Self-contained, has its own tests.
2. PR — T2 (MCP lockdown). Trivial compose + default + docs.
3. PR — T3 (mainLoop wrapper). Trivial code + 2 acceptance tests.
4. PR — T4 (docs sync). Run after the 3 above merge.

## Risk register

| Risk | Mitigation |
|---|---|
| T1 breaks deployments that already run behind an undocumented proxy | `XFF_MODE=legacy` escape hatch + clear `log.error` if used + upgrade note in CHANGELOG |
| T2 disables MCP for someone currently using it | No first-party consumer found in grep across node + sdks + docs. Operators who use it will see startup absence and read the new runbook to enable. |
| T3 lets a stalled node hide longer | Until Epic 13's `/health` extension lands, ops will notice via block-height stagnation, not container restart. Acceptable trade-off: crash-loop hides root cause worse than a stall does. Log message is explicit. |
| `ipaddr.js` adds a runtime dep | ~30KB, zero native deps, MIT, widely used. DEPS-AUDIT entry to be added. |

## Definition of Done

- All 4 tasks closed in myc.
- 3 PRs merged with passing CI.
- `docker stop` smoke test verified: exit code 0.
- `bun test src/libs/network/rateLimiter.test.ts` passes new 12 cases.
- Operator one-liner from T0 verified on at least one staging env.
- `coding-node` hindsight bank holds the 4 new memories.
- Epic 12 + Epic 13 risk registers no longer reference these blockers as open items.
