---
type: discovery
title: Exposed network surface — listening ports, bind hosts, CORS, XFF
date: 2026-06-02
status: active
slug: security-scan-2026-06-02
---

# 01 — Exposed network surface

Read-only enumeration of every TCP/UDP listener the node and its compose
stack open, the bind host (loopback vs all-interfaces), whether the host
publishes the port via `docker-compose.yml`, and the CORS / X-Forwarded-For
posture of the HTTP surfaces. All citations use `file:line`. No remediation
applied — every issue is filed as a finding (`SEC-2026-06-02-NNN`).

## 1. Listener inventory

The table below is authoritative for what a freshly-started node binds.
Sources: `src/libs/network/bunServer.ts:21`, `src/libs/omniprotocol/integration/startup.ts:52`, `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts:102`, `src/index.ts:838`, `src/features/metrics/MetricsServer.ts:60-64` + `src/features/metrics/constants.ts:38-42`, `.env.example:39-122`, `docker-compose.yml`.

| Port (default) | Service                          | Protocol     | Bind inside container | Compose host publish | Auth in front | Notes |
|----------------|----------------------------------|--------------|-----------------------|----------------------|---------------|-------|
| 53550 (RPC_PORT) | Demos HTTP RPC (BunServer)     | HTTP/1.1     | `0.0.0.0` (`bunServer.ts:21`) | `${RPC_PORT}:${RPC_PORT}` (`docker-compose.yml:180`) | None (CORS `*`, no auth) | Primary attack surface. Hosts `POST /` JSON-RPC + 13+ GETs. |
| 53551 (OMNI_PORT) | OmniProtocol TCP/TLS         | TCP + TLSv1.3 | `0.0.0.0` (`startup.ts:52`) | `${OMNI_PORT}:${OMNI_PORT}` (`docker-compose.yml:181`) | Mutual-TLS in code; `requestCert` driven by config (`TLSServer.ts:98`) with `rejectUnauthorized: false` and custom verifier (`TLSServer.ts:99,150-…`) | Custom fingerprint — Caddyfile refuses to proxy (`Caddyfile:17`). |
| 3005 (RPC_SIGNALING_PORT) | WebRTC signaling (Bun WS) | HTTP→WS upgrade | `0.0.0.0` (no `hostname:` → `Bun.serve` default, `signalingServer.ts:103-116`) | `${RPC_SIGNALING_PORT}:${RPC_SIGNALING_PORT}` (`docker-compose.yml:182`) | None on the upgrade itself; per-message handshake | WebSocket on the wire. |
| 3001 (RPC_MCP_PORT) | Model Context Protocol (SSE)  | HTTP/SSE     | `localhost` (`src/index.ts:838`) | NOT published — line commented out (`docker-compose.yml:183-192`) | None (SDK has no built-in auth — see `docs/runbooks/mcp-security.md`) | Default `MCP_ENABLED=false` (`src/config/defaults.ts:63`). When enabled it only listens on container loopback; only reachable via `docker exec` or a reverse-proxy mount (Caddy mount documented at `monitoring/caddy/Caddyfile:82-87`). |
| 9090 (METRICS_PORT) | Prometheus scrape (`/metrics`) | HTTP/1.1   | `0.0.0.0` (`.env.example:122` → `MetricsService.host` → `MetricsServer.ts:60-64`) | `${METRICS_HOST_PORT:-9090}:9090` (`docker-compose.yml:196`) | None on the listener itself | Plus `/health`, `/healthz`, `/` info — all unauthenticated (`MetricsServer.ts:78-118`). |
| 7047 (TLSNOTARY_PORT) | TLSNotary sidecar (upstream image) | HTTP    | container-side per upstream | `${TLSNOTARY_PORT:-7047}:7047` (`docker-compose.yml:78`) | None | Upstream image `ghcr.io/tlsnotary/tlsn/notary-server:v0.1.0-alpha.12` (`docker-compose.yml:67`). |
| 9091 (PROMETHEUS_PORT) | Prometheus UI/API           | HTTP/1.1     | container-side `0.0.0.0` (image default) | `${PROMETHEUS_PORT:-9091}:9090` (`docker-compose.yml:241`) | None | UI lifecycle API enabled (`--web.enable-lifecycle`, `docker-compose.yml:225`). |
| 3000 (GRAFANA_PORT) | Grafana UI                     | HTTP/1.1     | container-side `0.0.0.0` (image default) | `${GRAFANA_PORT:-3000}:3000` (`docker-compose.yml:305`) | Form-login, default `admin/${GRAFANA_ADMIN_PASSWORD:-demos}` (`docker-compose.yml:268-269`, `.env.example:262-263`) | Anonymous off; sign-up off. |
| 9100 (NODE_EXPORTER_PORT) | host metrics              | HTTP/1.1     | container-side `0.0.0.0` (image default) | `${NODE_EXPORTER_PORT:-9100}:9100` (`docker-compose.yml:335`) | None | Profile-gated `full` (`docker-compose.yml:324`). |
| 7474 (NEO4J_HTTP_PORT) | Neo4j HTTP / Browser          | HTTP/1.1     | container-side `0.0.0.0` (image default) | `${NEO4J_HTTP_PORT:-7474}:7474` (`docker-compose.yml:361`) | Form-login, default `neo4j/${NEO4J_AUTH#neo4j/}` = `changeme-please` (`docker-compose.yml:355`) | Profile-gated `neo4j`. |
| 7687 (NEO4J_BOLT_PORT) | Neo4j Bolt                    | TCP (Bolt)   | container-side `0.0.0.0` (image default) | `${NEO4J_BOLT_PORT:-7687}:7687` (`docker-compose.yml:362`) | Same as 7474 | Profile-gated `neo4j`. |
| 80 / 443 / 443/udp | Caddy reverse-proxy             | HTTP / HTTPS / HTTP-3 | container-side `0.0.0.0` | `80:80`, `443:443`, `443:443/udp` (`docker-compose.yml:396-398`) | Per-route — see §5 | Profile-gated `proxy`. Terminates TLS for RPC / Signaling / MCP / Metrics / Grafana / Prometheus / TLSNotary. |

Postgres is intentionally **internal-only** — `ports:` stanza commented (`docker-compose.yml:59-60`).

## 2. Bind-host findings

### SEC-2026-06-02-001 — RPC HTTP listener binds `0.0.0.0` by default with no operator opt-out
- **Severity**: high
- **CWE**: CWE-1327 (Binding to an Unrestricted IP Address)
- **Where**: `src/libs/network/bunServer.ts:21` — `constructor(port: number, hostname = "0.0.0.0")`; `src/libs/network/server_rpc.ts:25` instantiates `new BunServer(port)` without overriding hostname.
- **What**: The HTTP RPC server is hard-defaulted to `0.0.0.0`. There is no `RPC_HOST` / `RPC_BIND` env variable, no config key, no CLI flag. A bare-metal operator who wants the node reachable only on `localhost` (e.g. behind a host-side nginx/Caddy) has no documented way to do so without editing source.
- **Impact**: any operator who runs the node outside docker compose exposes the RPC port to every interface, including public ones. In docker compose the port is also host-published unconditionally (`docker-compose.yml:180`).
- **Recommendation**: thread an `RPC_HOST` env → `Config.server.rpcHost` (default keeps `0.0.0.0` for back-compat) and pass it into `new BunServer(port, host)`. Document in `.env.example`.

### SEC-2026-06-02-002 — WebRTC signaling server omits `hostname:` and silently binds `0.0.0.0`
- **Severity**: medium
- **CWE**: CWE-1327
- **Where**: `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts:103-116` — `Bun.serve({ port, fetch, websocket })` with no `hostname:` key. Bun's default for omitted hostname is `0.0.0.0`.
- **What**: Identical pattern to SEC-001 — the listener is `0.0.0.0`-bound implicitly, with no override path. Compounded by an unguarded WebSocket upgrade: `server.upgrade(req)` succeeds for any caller (`signalingServer.ts:106`), there is no origin check on the HTTP-→-WS handshake.
- **Impact**: any reachable client can complete the WebSocket upgrade and begin sending signaling frames. Per-frame validation may still reject, but the connection slot is consumed and the per-IP signaling traffic budget is not bounded by the RPC rate limiter (this server is a separate listener — see §3).
- **Recommendation**: add `hostname:` from config (mirror RPC fix). Add an `Origin:` header allowlist on `upgrade()` when `CORS_ALLOWED_ORIGINS` is non-wildcard. Apply a connection-budget per source IP.

### SEC-2026-06-02-003 — Metrics server defaults to `0.0.0.0` in `.env.example` AND is host-published unconditionally
- **Severity**: high
- **CWE**: CWE-200 (Exposure of Sensitive Information to an Unauthorized Actor), CWE-1327
- **Where**:
  - `.env.example:122` — `METRICS_HOST=0.0.0.0`
  - `src/features/metrics/constants.ts:38-42` — `DEFAULT_SERVER_CONFIG.hostname = Config.getInstance().metrics.host`
  - `src/features/metrics/MetricsServer.ts:60-64` — `Bun.serve({ port: this.config.port, hostname: this.config.hostname, … })`
  - `docker-compose.yml:196` — `"${METRICS_HOST_PORT:-9090}:9090"` — always published, no profile gate
- **What**: the Prometheus scrape surface is reachable on every host interface without authentication. The endpoint emits `/metrics` (full process-internal counters: chain DB, mempool size, peer table, consensus round durations, custom counters via `MetricsService.getMetrics()`), `/health`, `/healthz`, and `/` info banner with the version string (`MetricsServer.ts:78-118`).
- **Impact**: any reachable client can fingerprint the node version, observe consensus liveness and peer-table size, and use the metrics stream to side-channel state changes. Combined with finding 001 the operational telemetry is fully public.
- **Recommendation**: default `METRICS_HOST=127.0.0.1` and require operators to explicitly opt into `0.0.0.0`. Behind Caddy the scrape route already enforces basic-auth (`Caddyfile:93-98`) — direct host port should be gated similarly or removed from the compose `ports:` stanza unless `METRICS_HOST` is loopback.

### SEC-2026-06-02-004 — OmniProtocol TCP server binds `0.0.0.0` and host-publishes; trust model relies on custom certificate verifier
- **Severity**: medium
- **CWE**: CWE-295 (Improper Certificate Validation), CWE-1327
- **Where**:
  - `src/libs/omniprotocol/integration/startup.ts:52` — `const host = config.host ?? "0.0.0.0"`
  - `src/libs/omniprotocol/server/TLSServer.ts:94-141` — `tls.createServer` with `rejectUnauthorized: false` and a custom secure-connection handler doing manual verification
  - `docker-compose.yml:181` — `"${OMNI_PORT}:${OMNI_PORT}"` unconditional publish
- **What**: the OmniProtocol listener is internet-reachable by default and disables Node's built-in cert chain check, deferring rejection to `handleSecureConnection`. Any defect in that custom verifier — incomplete chain walking, missing revocation, hostname mismatch tolerance — becomes a remote-trust bypass.
- **Impact**: a buggy or bypassable custom verifier turns into an authn bypass on the peer protocol. Confidence in the verifier deserves a focused audit (out of scope for S3 — see §07 follow-up).
- **Recommendation**: document the custom-verification contract; add a regression test that proves `rejectUnauthorized: false` cannot be reached by an attacker holding a CA-signed cert not in the demos peer set; add `OMNI_HOST` env to allow loopback-only deployments.

## 3. Rate-limiting scope — listeners NOT covered

The middleware applied in `src/libs/network/server_rpc.ts:54-56` is the
`RateLimiter` only for the RPC `BunServer`. Other listeners run their own
`Bun.serve` and bypass it entirely:

- Metrics server — `src/features/metrics/MetricsServer.ts:60`.
- Signaling server — `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts:103`.
- MCP SSE transport — `src/features/mcp/MCPServer.ts` (Express + SSE).
- OmniProtocol TCP — `src/libs/omniprotocol/server/TLSServer.ts:104`.

### SEC-2026-06-02-005 — Non-RPC listeners have no rate limiting
- **Severity**: medium
- **CWE**: CWE-770 (Allocation of Resources Without Limits or Throttling)
- **Recommendation**: extract the per-IP token bucket from `middleware/rateLimiter.ts` into a transport-agnostic helper and wrap every `Bun.serve` / `tls.createServer` callback with it (or front everything through Caddy with `rate_limit` directives). See §07 cross-ref for follow-up.

## 4. CORS posture

`src/libs/network/bunServer.ts:177-271` defines the CORS middleware:

- `CORS_ALLOWED_ORIGINS` env is read with `loadCorsAllowedOrigins()`
  (`bunServer.ts:179-188`). Empty / unset / `*` → wildcard.
- `.env.example:190` ships `CORS_ALLOWED_ORIGINS=` (empty) → wildcard by default.
- A one-shot startup warning fires only when both `PROXY_DOMAIN` is set
  AND not `localhost` (`bunServer.ts:190-207`). Operators who do not deploy
  Caddy never see the warning.
- Wildcard mode omits `Vary: Origin` deliberately (`bunServer.ts:222-224`)
  — correct given `*` semantics; documented as a Greptile P2 fix.

### SEC-2026-06-02-006 — CORS default is `Access-Control-Allow-Origin: *` for unauthenticated public surface
- **Severity**: medium (high once credentialed flows ship)
- **CWE**: CWE-942 (Permissive Cross-domain Policy with Untrusted Domains)
- **Where**: `src/libs/network/bunServer.ts:179-188`, `.env.example:190`.
- **What**: every browser on the internet can read every response from `RPC_PORT` if it can reach the node. The handler responses include `/info` (version + peer count), `/publickey` (node identity), `/peerlist`, `/diagnostics`, `/public_logs`, `/genesis`, and any JSON-RPC `POST /` result.
- **Impact today**: passive disclosure to a browser-loaded attacker page; combined with finding 001/003, this is reachable from any origin the victim's browser hits.
- **Impact when cookies / bearer tokens are introduced**: the wildcard combined with `Access-Control-Allow-Credentials` would be an XS-CSRF surface. Currently `Allow-Credentials` is never set so the browser would refuse to send creds — the risk is bounded to the public read surface UNTIL credentialed auth ships. The startup warning already documents this gap (`bunServer.ts:200-205`).
- **Recommendation**: hard-fail on boot when `PROD=true` and CORS is wildcard (no warning-only path). Document `CORS_ALLOWED_ORIGINS` as mandatory for any non-dev deploy. The MCP runbook (`docs/runbooks/mcp-security.md`) hints at this pattern.

### SEC-2026-06-02-007 — CORS preflight responds 204 to disallowed origins instead of omitting the listener
- **Severity**: informational
- **Where**: `src/libs/network/bunServer.ts:241-249`. Preflight returns 204 with no `Access-Control-Allow-Origin` for disallowed origins. The browser will reject the actual request, but the listener confirms its existence and the 204 silences any error log on the server side.
- **Note**: this is a deliberate design — the comment says "still return 204 so the request isn't logged as an error." Documenting only for completeness; not a defect.

## 5. X-Forwarded-For / proxy-trust posture

Source: `.env.example:65-85`, `src/libs/network/routines/getRemoteIP.ts` (handler), `src/libs/network/middleware/rateLimiter.ts`.

Three modes documented:

| `XFF_MODE` | Behavior |
|------------|----------|
| `off` (auto when `TRUSTED_PROXIES` empty) | Proxy headers ignored, socket IP only — safe default |
| `strict` (auto when `TRUSTED_PROXIES` set) | Honor headers iff socket address ∈ `TRUSTED_PROXIES` |
| `legacy` | Trust `X-Forwarded-For` from **any** source — explicitly labeled INSECURE (`.env.example:84`) |

### SEC-2026-06-02-008 — `XFF_MODE=legacy` is an opt-in foot-gun that fully disables rate-limit source-IP attribution
- **Severity**: high (when set), informational (when unset)
- **CWE**: CWE-348 (Use of Less Trusted Source) / CWE-290 (Authentication Bypass by Spoofing)
- **Where**: `.env.example:78-85`.
- **What**: `legacy` mode trusts any `X-Forwarded-For` header without verifying the socket origin. An unauthenticated attacker can set the header to any value and either bypass per-IP rate limits or attribute traffic to a victim's IP. The default is empty (auto → `off`), which is safe — but the flag exists and is silently honored if set.
- **Recommendation**: refuse to boot when `XFF_MODE=legacy` AND `PROD=true` (mirror finding 006). Log `[STARTUP] WARNING: XFF_MODE=legacy is insecure` on every boot regardless of PROD. Consider deprecating the mode in the next minor release.

### SEC-2026-06-02-009 — `TRUSTED_PROXIES` empty by default; auto-mode falls to `off` but operator behind a proxy gets all traffic bucketed
- **Severity**: low (correctness, not exploit)
- **CWE**: CWE-1188 (Insecure Default Initialization of Resource)
- **Where**: `.env.example:67-76`.
- **What**: if an operator deploys the node behind a CDN/proxy without setting `TRUSTED_PROXIES`, the rate limiter sees every request as coming from the proxy IP and rate-limits the proxy itself rather than per-client. This is a self-DoS risk, not an attack surface.
- **Recommendation**: document the docker-compose-default value (`172.16.0.0/12,127.0.0.1/32`, per `.env.example:74`) as the recommended bake-in for the compose stack. Caddy already strips inbound `X-Forwarded-*` (`Caddyfile:56-59`) which makes `strict` mode safe with the docker bridge in `TRUSTED_PROXIES`.

## 6. Caddy proxy route auth posture

Source: `monitoring/caddy/Caddyfile:1-120`, `docker-compose.yml:390-433`.

| Path                     | Upstream        | Auth in Caddyfile | Default credential | Notes |
|--------------------------|-----------------|-------------------|--------------------|-------|
| `/` (catch-all)          | `node:53550`    | None              | n/a                | RPC unchanged |
| `/signaling/*`           | `node:3005`     | None              | n/a                | WSS |
| `/mcp/*`                 | `node:3001`     | basic-auth        | Sentinel `$2a$14$invalid…` (rejects everything) (`Caddyfile:84`, mirrors compose env default `docker-compose.yml:408`) | Operator must set `MCP_BASIC_AUTH_HASH` to enable |
| `/metrics`               | `node:9090`     | basic-auth        | Same sentinel default (`Caddyfile:95`, `docker-compose.yml:407`) | Internal Prometheus scrapes via docker bridge bypasses this |
| `/grafana/*`             | `grafana:3000`  | None at proxy     | Grafana form-login (default `admin/demos`) | Sub-path mount |
| `/prometheus/*`          | `prometheus:9090` | None            | n/a                | UI lifecycle API enabled upstream — be careful |
| `/tlsnotary/*` (subpath mode) | `tlsnotary:7047` | None         | n/a                | Configurable via `TLSNOTARY_PROXY_MODE` |

### SEC-2026-06-02-010 — Grafana host-published on `:3000` with default password `demos`, bypassing Caddy basic-auth entirely
- **Severity**: high
- **CWE**: CWE-521 (Weak Password Requirements), CWE-1188
- **Where**: `docker-compose.yml:304-305` (`"${GRAFANA_PORT:-3000}:3000"`), `docker-compose.yml:268-269` (`GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-demos}`), `.env.example:263`.
- **What**: regardless of whether the operator deploys the Caddy proxy, the Grafana UI is host-published on `:3000` and accepts `admin/demos` until the operator overrides it. The compose comment at `.env.example:15` notes this is "fine for solo, not for shared." But the default ports stanza is unconditional — there is no profile or env gate that requires the password change before exposing.
- **Recommendation**: refuse to boot Grafana with the literal `demos` password when `PROD=true`. Make the `:3000` host publish conditional on `GRAFANA_PORT` being explicitly set OR profile-gate the port mapping. Document the override-or-die rule prominently in `.env.example`.

### SEC-2026-06-02-011 — Neo4j defaults `neo4j/changeme-please` AND host-publishes 7474/7687 when profile enabled
- **Severity**: high (when neo4j profile enabled)
- **CWE**: CWE-521, CWE-1188
- **Where**: `docker-compose.yml:349-371`, default at `docker-compose.yml:355`.
- **What**: same shape as finding 010. When an operator opts into the `neo4j` profile (CGC / KYC features), the ports are host-published and the default credential is the upstream-suggested `changeme-please`. Bolt (7687) is also exposed — a Bolt endpoint with default creds is a database takeover.
- **Recommendation**: require `NEO4J_AUTH` to be explicitly set (no default) when the `neo4j` profile is selected; refuse to start otherwise. Bind Bolt to loopback unless explicitly opted in.

### SEC-2026-06-02-012 — Prometheus `--web.enable-lifecycle` exposes config-reload and shutdown endpoints
- **Severity**: medium (host-published direct on `:9091`) / low (behind Caddy, no auth at proxy)
- **CWE**: CWE-862 (Missing Authorization)
- **Where**: `docker-compose.yml:225`, `docker-compose.yml:241`.
- **What**: with `--web.enable-lifecycle`, `POST /-/reload` and `PUT /-/quit` are exposed on the Prometheus port. Combined with the unauthenticated `:9091` host publish and the no-auth `/prometheus/*` proxy route, anyone reachable can reload the scrape config or shut Prometheus down (DoS the observability stack).
- **Recommendation**: drop `--web.enable-lifecycle` unless operators specifically need it; gate behind the same basic-auth as `/metrics`; bind `:9091` to loopback by default.

### SEC-2026-06-02-013 — Caddy basic-auth sentinel uses a deliberately-invalid bcrypt; correct shape but worth verifying it rejects in practice
- **Severity**: informational
- **Where**: `docker-compose.yml:407-408`, `monitoring/caddy/Caddyfile:84,95`.
- **What**: the placeholder `$2a$14$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi` is a bcrypt hash of a value no plaintext password should match. The 22-char block after `$14$` is the salt and the rest is the digest — bcrypt verification will run `crypt(provided, "$2a$14$invalidinvalidinvalidinvalidi")` and compare to `nvalidinvalidinvalidinvalidi`. The string `i` is base-64-bcrypt-legal so the parse should succeed and verification should always return `false`. Worth a one-shot unit test to confirm Caddy doesn't accept the empty string here.
- **Note**: doc-only finding; the design intent is correct.

## 7. Counted listeners summary

Minimum stack (no profiles, `docker compose up postgres node`):
- 4 host-published TCP listeners: `RPC_PORT 53550`, `OMNI_PORT 53551`, `RPC_SIGNALING_PORT 3005`, `METRICS_HOST_PORT 9090`.
- 0 of those 4 require authentication on the listener itself.

Default profile (`COMPOSE_PROFILES=monitoring,tlsnotary` per `.env.example`):
- + 3 host-published listeners: `TLSNOTARY_PORT 7047`, `PROMETHEUS_PORT 9091`, `GRAFANA_PORT 3000`.
- Of those 3: Grafana has form-login (default cred — finding 010); Prometheus has none; TLSNotary has none.

With proxy + monitoring + neo4j + full:
- + Caddy `:80/:443/:443udp`, node-exporter `:9100`, neo4j `:7474/:7687`. All `:9100` and `:7474`/`:7687` are unauthenticated at the listener or default-credentialed (finding 011).

## 8. Findings produced

| ID | Severity | Title |
|----|----------|-------|
| SEC-2026-06-02-001 | high | RPC HTTP listener `0.0.0.0` with no opt-out |
| SEC-2026-06-02-002 | medium | Signaling server `0.0.0.0` + unguarded WS upgrade |
| SEC-2026-06-02-003 | high | Metrics `0.0.0.0` + unconditional host publish |
| SEC-2026-06-02-004 | medium | OmniProtocol `0.0.0.0` + `rejectUnauthorized: false` |
| SEC-2026-06-02-005 | medium | Non-RPC listeners lack rate limiting |
| SEC-2026-06-02-006 | medium → high | CORS default `*` for unauthenticated public surface |
| SEC-2026-06-02-007 | informational | CORS preflight 204 for disallowed origin |
| SEC-2026-06-02-008 | high (if set) | `XFF_MODE=legacy` is an opt-in foot-gun |
| SEC-2026-06-02-009 | low | Empty `TRUSTED_PROXIES` self-DoS behind a proxy |
| SEC-2026-06-02-010 | high | Grafana default `admin/demos`, host-published `:3000` |
| SEC-2026-06-02-011 | high (with profile) | Neo4j default `neo4j/changeme-please`, host-published 7474/7687 |
| SEC-2026-06-02-012 | medium | Prometheus `--web.enable-lifecycle` + no auth |
| SEC-2026-06-02-013 | informational | Caddy basic-auth sentinel verification |

## 9. Cross-references

- `02-secrets-in-tree.md` — owns the default-credential findings end-to-end (Grafana, Neo4j, Postgres) and the `PROD=true` startup-gate recommendation.
- `04-authentication-and-authorization.md` — owns the per-endpoint auth posture for `/publickey`, `/peerlist`, `/genesis`, `/diagnostics`, `/public_logs`, MCP, and rate-limit details. Findings here intentionally stop at listener-level posture.
- `06-docker-and-deployment.md` — owns image hardening, volume permissions, healthcheck behavior, and the broader docker-compose risk surface.
- `docs/runbooks/mcp-security.md` — pre-existing threat model for MCP; cited above and NOT duplicated.

## 10. Reproduction notes (read-only)

These commands were planned but **not executed** (the audit charter forbids
running the node). Documented here so a follow-up CI run can confirm:

```bash
# Listener enumeration on a running node (do this in a throwaway VM):
ss -lntp | grep -E ':(53550|53551|3005|3001|9090|7047|9091|3000|9100|7474|7687|80|443)'

# CORS posture probe (no auth, no body):
curl -sS -H "Origin: https://evil.example" -I http://127.0.0.1:53550/info | grep -i access-control

# Verify XFF_MODE handling (expect socket IP, not header IP, in default config):
curl -sS -H 'X-Forwarded-For: 1.2.3.4' http://127.0.0.1:53550/ | jq .yourIP
```
