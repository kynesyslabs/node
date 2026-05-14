---
type: changelog
title: Startup Assessment Changelog
---

# Startup Assessment Changelog

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
