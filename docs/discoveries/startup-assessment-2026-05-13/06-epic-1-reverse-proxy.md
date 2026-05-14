---
type: plan
title: "Epic 1 — Reverse Proxy in Front of Exposed Services"
date: 2026-05-13
status: ready-for-myc
depends_on: docs/discoveries/startup-assessment-2026-05-13/05-fragility-synthesis.md
---

# Epic 1 — Reverse Proxy in Front of Exposed Services

## Goal

Collapse 6 host-exposed HTTP/WS ports behind 1 TLS endpoint (single Let's Encrypt cert) using **Caddy**. Keep OmniProtocol 53551 direct (custom-fingerprint TLS, not proxyable). Lock down side effects (XFF spoofing, MCP auth, sub-path serving for Grafana/Prometheus, wstcp path-mode).

**Net effect:** 7 host ports → 2 (443 + 53551). One cert, automatic renewal.

## Why Caddy (decision recap)

- Project uses file-config pattern (`monitoring/prometheus.yml`, `grafana.ini`) — matches Caddy's `Caddyfile` style.
- No existing docker labels in compose → Traefik's main advantage is wasted.
- Default ACME (HTTP-01) needs zero flags vs Traefik resolver YAML.
- `proxyManager.ts:175` comment explicitly references "single nginx rule" path-mapping — Caddy `handle_path /rpc/* { reverse_proxy ... }` matches 1:1.
- ~15MB idle footprint vs Traefik ~50MB.

Decision can be reversed in T9 if a blocker shows up — config swap is mechanical.

## Risks / Blockers Identified (must address as tasks)

1. **`x-forwarded-for` spoof** — ~~`rateLimiter.ts:191-204` trusted-proxy list empty; XFF accepted unconditionally. Hard blocker.~~ **CLEARED 2026-05-14 by Epic 14 T1** (3-mode design, default off, `TRUSTED_PROXIES` env). Set `TRUSTED_PROXIES=172.16.0.0/12,127.0.0.1/32` (compose) or `XFF_MODE=strict` when Caddy lands.
2. **MCP has zero auth** — ~~`MCPServer.ts:253-343`. Exposing publicly = unauthenticated AI control surface.~~ **DEFERRED — Epic 14 T2 closed the compose port mapping and flipped default-off. Re-exposure via this epic requires bearer-auth at Caddy first (see T2).**
3. **MCP currently binds `localhost`** — `src/index.ts:629`. Today's `3001:3001` mapping hits nothing inside container — Epic 14 T2 already removed the mapping. To re-expose behind Caddy, bind `0.0.0.0` (with auth) or proxy from same docker network.
4. **CORS wildcard everywhere** — `bunServer.ts:152-156`. Behind proxy + credentials = footgun. Read-only RPC is OK today but freeze the contract.
5. **`EXPOSED_URL` propagation** — single variable feeds peer announcements (`getPeerlist.ts:26`), self-peer (`selfPeer.ts:11`), consensus (`manageConsensusRoutines.ts:123`), TLSNotary wstcp URLs (`proxyManager.ts:178-186`). Change must be tested against peer-list parsing in SDK + node.
6. **Grafana/Prometheus sub-path serving** needs `GF_SERVER_SERVE_FROM_SUB_PATH=true` + `--web.external-url`/`--web.route-prefix` respectively. Plain proxy without these breaks asset links.
7. **TLSNotary upstream behavior behind proxy** — third-party Rust binary, WS protocol. Verify it tolerates termination + Upgrade rewrite.
8. **wstcp pool path-mode** — `EXPOSED_URL=https://host/rpc/` propagates to peer URLs (`sharedState.ts:421`). SDK clients may expect `host:port` only — verify parsing.

## Out of scope

- OmniProtocol 53551 — direct exposure preserved, custom-fingerprint TLS untouched.
- Multi-node Traefik-as-edge — not needed for single-node deployment, can revisit if multi-tenant edge appears on roadmap.
- DNS-01 wildcard ACME — HTTP-01 per-host suffices; revisit if multi-subdomain pattern emerges.

## Task Breakdown (sequenced)

### Phase A — Pre-work (no proxy yet, fix prerequisites)

**T1 — Populate trusted-proxy IP list + reconfigurable XFF policy.**
- File: `src/libs/network/middleware/rateLimiter.ts:191-204`.
- Add `TRUSTED_PROXIES` env var, comma-separated CIDR list, default empty.
- When non-empty: only honor `x-forwarded-for` if remote addr ∈ trusted list. Otherwise use socket IP.
- Add `demos_rate_limit_xff_trusted` / `demos_rate_limit_xff_rejected` counters (Epic 2 will add them).
- Acceptance: existing rate-limit tests pass; new test asserts spoofed XFF is ignored when remote not trusted.

**T2 — Decide MCP auth approach.**
- Options: (a) bearer token from env `MCP_AUTH_TOKEN`, validated middleware in `MCPServer.ts:259+`. (b) basic-auth at Caddy layer (simpler). (c) keep `localhost`-bound + proxy from same docker network only (no public exposure).
- Decision: **(c) for now** — least change. MCP stays internal-only. Document that external MCP requires (a) or (b) before unblocking.
- File: `src/index.ts:626-630` — remove `host: "localhost"` if we want the docker-network proxy path, keep otherwise.
- Acceptance: clear written decision; if (c): MCP not in Caddyfile at all; if (a)/(b): auth check has a test.

**T3 — Audit MCP binding vs port mapping.**
- File: `docker-compose.yml:192` — `RPC_MCP_PORT:-3001:3001`.
- If T2 chose (c): remove the host port mapping. MCP only reachable inside docker network.
- If T2 chose (a) or (b): bind `0.0.0.0` (`src/index.ts:629`) and add auth.
- Acceptance: compose no longer publishes 3001 to host, OR MCP has auth in place.

**T4 — Verify wstcp reachability assumption.**
- `portAllocator.ts:83`, `proxyManager.ts:281`.
- Today: container uses bridge network; wstcp ports 55000-57000 are NOT in `compose ports:`. So they're already unreachable from outside the container.
- Confirm by `docker compose exec node nc -zv localhost 55001` (after a TLSNotary session is up) and `nc -zv <host-ip> 55001` (expected: refused from outside).
- If confirmed: change `wstcp --bind-addr 0.0.0.0:...` → `--bind-addr 127.0.0.1:...` in `proxyManager.ts:281`. Path-mode proxy (Phase C) routes external clients.
- If wstcp is currently reachable: that's a security finding to log + add `host_network` or explicit port mappings need replacing with proxy path-mode.
- Acceptance: confirmed binding behavior + decision documented.

### Phase B — Add Caddy to compose

**T5 — Author baseline `Caddyfile`.**
- New file: `monitoring/caddy/Caddyfile`.
- Sections:
  - `:80` block: redirect-all → HTTPS (ACME HTTP-01 lives here too).
  - `${PROXY_DOMAIN}` block: TLS auto (`tls ${ACME_EMAIL}`).
    - `handle /health* { reverse_proxy node:53550 }` (path probe for LB).
    - `handle /` and `handle /rpc/*` → RPC (53550). Path-strip `/rpc` if used.
    - `handle /signaling/* { reverse_proxy node:3005 }` — Caddy auto-handles WS Upgrade.
    - `handle /metrics { reverse_proxy node:9090 }` — basic-auth required (env-injected hash).
    - `handle /grafana/* { reverse_proxy grafana:3000 }`.
    - `handle /prometheus/* { reverse_proxy prometheus:9090 }`.
    - `handle /tlsnotary/* { reverse_proxy tlsnotary:7047 }` — WS.
    - `handle /wstcp/* { reverse_proxy {http.request.uri.path.0} }` placeholder for path-mode wstcp; concrete pattern depends on `buildWsUrl` output (see T8).
    - Strip + re-add `X-Forwarded-For` (remove inbound, set from `{remote_host}`).
- Acceptance: file passes `caddy validate` (run via `docker run --rm caddy:2 caddy validate --config /etc/caddy/Caddyfile`).

**T6 — Add `caddy` service to `docker-compose.yml`.**
- New service under `profiles: [proxy]`.
- Image: `caddy:2.8-alpine`.
- Ports: `80:80`, `443:443`, `443:443/udp` (HTTP/3).
- Volumes: `./monitoring/caddy/Caddyfile:/etc/caddy/Caddyfile:ro`, named volumes `caddy_data:/data` (cert store), `caddy_config:/config`.
- depends_on: `node: {condition: service_healthy}` (after Epic 2 healthcheck lands; in the meantime use `service_started`).
- Env: `PROXY_DOMAIN`, `ACME_EMAIL`, `METRICS_BASIC_AUTH_HASH`.
- Healthcheck: `wget --spider http://localhost:80` (Caddy admin port 2019 disabled in prod).
- `restart: unless-stopped`.
- Acceptance: `docker compose --profile proxy config` validates; `docker compose --profile proxy up caddy` starts cleanly with placeholder `PROXY_DOMAIN=localhost` and self-signed (Caddy's internal CA).

**T7 — Wire `.env.example` additions.**
- New keys:
  - `PROXY_DOMAIN=node.example.com` (must be set for ACME).
  - `ACME_EMAIL=admin@example.com`.
  - `METRICS_BASIC_AUTH_HASH=` — bcrypt hash via `caddy hash-password`.
  - `TRUSTED_PROXIES=172.16.0.0/12,127.0.0.1/32` — internal docker network + caddy.
  - `COMPOSE_PROFILES=monitoring,tlsnotary,proxy` (add `proxy`).
- Acceptance: `.env.example` has documented block with comments; readme references it.

### Phase C — Update node code for proxy-aware behavior

**T8 — Adopt path-mode `EXPOSED_URL`.**
- Files touched: `.env.example:39+` (set `EXPOSED_URL=https://${PROXY_DOMAIN}/rpc`), `src/config/loader.ts:102`, code paths in §7 of research (`getPeerlist.ts:26`, `selfPeer.ts:11`, `manageConsensusRoutines.ts:123,130`, `sharedState.ts:421,428`, `proxyManager.ts:178-186`).
- Verify `buildWsUrl` path-mode at `proxyManager.ts:183-184` produces `wss://${PROXY_DOMAIN}/rpc/<wstcpPort>/`.
- Add Caddyfile route: `handle_path /rpc/* { reverse_proxy node:53550 node:55000-57000 }` (Caddy upstream port-match by path segment — use a `handle /rpc/{port}/*` matcher).
- Cross-check SDK URL parsing: clone of `https://github.com/...` SDK; grep for `URL parsing` around peer connection. Confirm SDK accepts path-suffixed URL.
- Acceptance: integration test: spin up devnet with proxy; SDK successfully establishes peer connection through path-mode URL.

**T9 — Bind wstcp to `127.0.0.1`** (depends on T4 confirming feasibility).
- File: `src/features/tlsnotary/proxyManager.ts:281` — change `--bind-addr 0.0.0.0:${localPort}` → `--bind-addr 127.0.0.1:${localPort}`.
- Update `portAllocator.ts:83` listen check similarly if needed.
- Acceptance: TLSNotary session through proxy works end-to-end (browser SDK → Caddy `/rpc/55xxx/...` → wstcp on 127.0.0.1 → notary service).

**T10 — Grafana sub-path config.**
- File: `docker-compose.yml:207` — set `GF_SERVER_ROOT_URL: ${GRAFANA_ROOT_URL:-https://${PROXY_DOMAIN}/grafana/}` and add `GF_SERVER_SERVE_FROM_SUB_PATH: "true"`.
- Acceptance: `https://${PROXY_DOMAIN}/grafana/` loads UI with correct asset URLs.

**T11 — Prometheus sub-path config.**
- File: `docker-compose.yml:160-167` — add to `command:`: `--web.external-url=https://${PROXY_DOMAIN}/prometheus/`, `--web.route-prefix=/prometheus`.
- Acceptance: `https://${PROXY_DOMAIN}/prometheus/` serves UI; `/prometheus/api/v1/query` works.

**T12 — Lock CORS to known origins.**
- Files: `src/libs/network/bunServer.ts:152-156`, `src/features/metrics/MetricsServer.ts` (find CORS block), `src/features/mcp/MCPServer.ts:260,273`.
- Replace `Access-Control-Allow-Origin: *` with allowlist sourced from env `CORS_ALLOWED_ORIGINS` (comma-separated). Default keeps `*` for backwards-compat but emit `[CORS] warning: wildcard origin` at boot when behind proxy.
- Acceptance: configurable; default behavior unchanged for non-proxy deployments; documented in env.

### Phase D — Remove now-redundant host port mappings

**T13 — Drop host port mappings.**
- File: `docker-compose.yml`.
- Remove from `node` ports: 53550 (RPC), 3005 (signaling), 3001 (MCP, if T2=(c)), 9090 (metrics).
- Remove from `grafana`: 3000 → internal only.
- Remove from `prometheus`: 9091 → internal only.
- **Keep**: 53551 (OmniProtocol), 7047 (TLSNotary — verify in T14 whether proxy can fully replace), 9100 (node-exporter — internal already, no change), 7474/7687 (neo4j — internal-only behind proxy if exposed at all).
- Acceptance: `docker compose --profile monitoring,tlsnotary,proxy up` works end-to-end; only 80, 443, 53551 (+optionally 7047) appear in `docker compose ps`.

**T14 — Decide TLSNotary 7047 disposition.**
- Test path: SDK browser client connects via `wss://${PROXY_DOMAIN}/tlsnotary/` (Caddy → notary container).
- If upstream notary tolerates: drop host 7047 entirely.
- If notary breaks (custom WS framing, sub-path confusion): keep direct 7047 OR move notary to dedicated subdomain `notary.${PROXY_DOMAIN}` and add another Caddy vhost.
- Acceptance: documented decision + test artifact (curl/wscat session log).

### Phase E — Operations + docs

**T15 — Runbook: bringing up proxy on fresh server.**
- New file: `docs/runbooks/proxy-setup.md`.
- Sections: DNS setup, env vars to set, certificate verification (`caddy list-certificates`), how to debug ACME failures (port 80 reachable, rate limits, certbot-style staging vs prod).
- Acceptance: file exists; tested by following it on a real (or staging) server.

**T16 — Runbook: how to add a new service behind proxy.**
- New file: `docs/runbooks/proxy-add-service.md`.
- Pattern: add `handle /yourservice/* { reverse_proxy yourservice:PORT }` to `Caddyfile`, reload via `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
- Acceptance: file exists.

**T17 — Update assessment docs with proxy outcome.**
- Files: `docs/discoveries/startup-assessment-2026-05-13/03-ports-and-certs.md` (move ports from "host-exposed" to "behind-proxy"), `docs/discoveries/startup-assessment-2026-05-13/05-fragility-synthesis.md` (mark Tier 2 #5 as DONE).
- Add `docs/discoveries/startup-assessment-2026-05-13/CHANGELOG.md` referencing this epic + the PR that closed it.
- Update `docs/INDEX.md` + `docs/manifest.json` with the new runbooks.
- Update `coding-node` hindsight bank: retain a new memory pointing at the runbook + the final port disposition.
- Acceptance: docs reflect post-epic reality.

## Acceptance Criteria for Epic 1 (whole)

- Single domain `https://${PROXY_DOMAIN}/` reaches RPC root; `/grafana/`, `/prometheus/`, `/metrics`, `/signaling`, `/tlsnotary/`, `/rpc/...` all functional.
- `docker compose ps` shows only 80, 443, 53551 (and possibly 7047) as host-published ports.
- One Let's Encrypt cert visible via `caddy list-certificates`, auto-renewing.
- SDK browser client successfully completes a TLSNotary session through `/tlsnotary/` and a wstcp session through `/rpc/<port>/`.
- Rate limiter no longer trusts arbitrary XFF (`TRUSTED_PROXIES` enforced).
- All docs updated; runbooks tested on a fresh deployment.

## Test Plan

1. **Unit:** rate-limit XFF trust test (T1); CORS allowlist test (T12).
2. **Integration:** docker-compose up with `--profile proxy`; curl `/health`, `/grafana/api/health`, `/-/healthy` via Prometheus path.
3. **End-to-end:** SDK browser client (manual or scripted) connects, exchanges peer message via signaling, runs TLSNotary session.
4. **Negative:** spoofed XFF from non-trusted IP → rate limiter uses socket addr.
5. **Long-running:** 7-day uptime test → ACME renewal occurs without manual intervention.

## Definition of Done

- All 17 tasks closed in myc.
- PR merged with passing CI.
- `docs/runbooks/proxy-setup.md` walked end-to-end on a real staging server.
- `coding-node` hindsight bank carries a `reference` memory pointing at the runbook.
