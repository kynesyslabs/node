---
type: runbook
title: MCP Server Security & Enablement
date: 2026-05-14
status: active
---

# MCP Server Security & Enablement

## TL;DR

The MCP (Model Context Protocol) server is **disabled by default** since
Epic 14. Its current implementation has **no authentication**. Two of its
tools leak sensitive data:

- `get_node_identity` returns the node's public key + public IP.
- `get_peer_list` returns peer identities + connection strings (your full
  network topology map).

Do not enable + publish MCP without an authenticated reverse proxy in
front. Until Epic 12 lands a Caddy bearer-auth route, treat MCP as
**strictly internal**.

## Current default state

- `MCP_ENABLED=false` (`src/config/defaults.ts:56`).
- Compose does NOT publish `3001/tcp` (`docker-compose.yml`).
- The server, when enabled, binds `localhost` inside the container
  (`src/index.ts:629`) and is reachable only via
  `docker compose exec node curl http://localhost:3001/sse`.
- POST `/message` validates the SSE `sessionId` query parameter
  (`src/features/mcp/MCPServer.ts:307`). Mismatched/missing sessionId
  yields HTTP 401. This is defense-in-depth; it is not a substitute for
  transport auth.

## Threat model

| Vector | Today | Mitigation |
|---|---|---|
| Anyone with network access can call any tool | Yes (within docker network, since localhost bind) | Default `MCP_ENABLED=false` + no host publish |
| Tool leaks publicKey + IP | Yes (`get_node_identity`) | Do not expose externally; audit before enabling new tools |
| Tool leaks peer topology | Yes (`get_peer_list`) | Same |
| Cross-session message hijack (CSRF-like) | Mitigated (sessionId check) | n/a |
| Browser DNS-rebinding to local MCP | Open (`@modelcontextprotocol/sdk` CVE — `DEPS-AUDIT.md:95`) | Upgrade SDK + add Origin allowlist, tracked separately |
| Wildcard CORS | Yes (`MCPServer.ts:260,273`) | Restrict at reverse-proxy layer |
| Unauthenticated tool execution | Yes | Bearer auth at proxy OR token middleware (deferred to Epic 12) |

## How to safely enable

### Option A — local agent only (recommended today)

Use `docker compose exec` from the host:

```bash
docker compose exec node curl -N http://localhost:3001/sse
```

Set `MCP_ENABLED=true` in `.env` only if a local agent (Claude Desktop,
Cursor, etc.) running on the same host needs the SSE stream. Do not
expose the port.

### Option B — behind reverse proxy with auth (Epic 12)

Wait for Epic 12 to land. The proxy will terminate TLS at `:443`, enforce
bearer auth, and forward to MCP via the docker network. Until that ships,
this option is not available — building it ad-hoc bypasses the
constraints documented above.

### Option C — direct public exposure

**Not supported.** Do not do this. If you have a use case, file a ticket
referencing Epic 14 + DEPS-AUDIT.md:95.

## Verifying the lockdown

```bash
# host: must not list 3001 on docker compose ps
docker compose ps

# expected: empty output (no host-published 3001)
docker compose port node 3001 2>&1 || echo "not published (expected)"

# from inside the container: MCP is reachable when enabled
docker compose exec node curl -sf http://localhost:3001/sse | head -5
```

## Related

- `docs/discoveries/startup-assessment-2026-05-13/08-epic-3-blockers.md`
- `docs/discoveries/startup-assessment-2026-05-13/06-epic-1-reverse-proxy.md`
- `DEPS-AUDIT.md:95` (SDK upgrade tracking)
- `src/features/mcp/MCPServer.ts:307` (sessionId check)
