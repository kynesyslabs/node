---
type: runbook
title: Reverse-Proxy Setup (Caddy)
date: 2026-05-14
status: active
---

# Reverse-Proxy Setup (Caddy)

Single-cert HTTPS for every HTTP/WS service the node exposes. Engaged
via the `proxy` compose profile (opt-in — no impact when off).

## What you get

| URL | Upstream | Auth |
|---|---|---|
| `https://${PROXY_DOMAIN}/` | RPC `node:53550` | rate limit only |
| `https://${PROXY_DOMAIN}/signaling/` | Signaling WS `node:3005` | rate limit only |
| `https://${PROXY_DOMAIN}/tlsnotary/` | TLSNotary `tlsnotary:7047` | rate limit only |
| `https://${PROXY_DOMAIN}/mcp/` | MCP `node:3001` | basic-auth (rejects all by default) |
| `https://${PROXY_DOMAIN}/metrics` | Node metrics `node:9090` | basic-auth |
| `https://${PROXY_DOMAIN}/grafana/` | Grafana `grafana:3000` | Grafana login |
| `https://${PROXY_DOMAIN}/prometheus/` | Prometheus `prometheus:9090` | none (read-only UI) |

OmniProtocol (`:53551`) stays direct — its custom-fingerprint TLS cannot
survive proxy termination.

## Prerequisites

1. **DNS**: `${PROXY_DOMAIN}` must resolve to your host's public IP.
2. **Firewall**: ports 80 + 443 (TCP + UDP for HTTP/3) open inbound.
3. **Epic 14 must be deployed first.** Caddy will set `X-Forwarded-For`;
   the node needs `TRUSTED_PROXIES` populated to honour it (see step 4).

## Step-by-step

### 1. Edit `.env`

```bash
# Activate the proxy profile
COMPOSE_PROFILES=monitoring,tlsnotary,proxy

# Public DNS name + ACME contact
PROXY_DOMAIN=node.example.com
ACME_EMAIL=ops@example.com

# Tell the node to trust XFF from Caddy. The docker bridge default is
# 172.16.0.0/12. Localhost added for direct probe access.
TRUSTED_PROXIES=172.16.0.0/12,127.0.0.1/32

# Generate a basic-auth hash for /metrics
docker run --rm caddy:2 caddy hash-password --plaintext 'YOUR_PASSWORD_HERE'
# Paste output:
METRICS_BASIC_AUTH_HASH=$2a$14$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Grafana sub-path
GRAFANA_ROOT_URL=https://node.example.com/grafana/
GRAFANA_SERVE_FROM_SUB_PATH=true

# Lock down CORS — recommended once you have a known frontend
CORS_ALLOWED_ORIGINS=https://app.example.com
```

### 2. Bring up the stack

```bash
docker compose up -d
docker compose ps
```

Expected: `demos-caddy` running and `(healthy)`.

### 3. Watch ACME bootstrap

```bash
docker compose logs -f caddy
```

First-time provisioning takes ~30s. Look for `obtained certificate` lines.

### 4. Smoke test

```bash
# RPC root + health
curl -fsS "https://${PROXY_DOMAIN}/health" | jq

# Grafana
curl -fsS -o /dev/null -w "%{http_code}\n" "https://${PROXY_DOMAIN}/grafana/api/health"

# Prometheus
curl -fsS "https://${PROXY_DOMAIN}/prometheus/-/healthy"

# Metrics (basic-auth)
curl -u metrics:YOUR_PASSWORD_HERE -fsS "https://${PROXY_DOMAIN}/metrics" | head -20

# Signaling (WS — use wscat)
# wscat -c "wss://${PROXY_DOMAIN}/signaling/"
```

### 5. Inspect cert state

```bash
docker compose exec caddy caddy list-certificates
```

You should see one cert per domain, expiring in ~90 days (Let's Encrypt
default; Caddy auto-renews at the ⅔ mark).

## Common failures

### `error obtaining certificate: failed to authenticate`

ACME HTTP-01 challenge failed. Check:
- Port 80 reachable from internet (`curl http://${PROXY_DOMAIN}/`)
- DNS A record matches host
- No CDN intercepting `/.well-known/acme-challenge/...`

Retry: `docker compose restart caddy`.

### `Let's Encrypt rate limit exceeded`

Used the production endpoint too many times. Switch to staging while
debugging:

```
# In monitoring/caddy/Caddyfile, top-level block:
{
    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
```

Then `docker compose restart caddy`. Staging certs are not browser-trusted
but unblock the rate limit. Remove the override once stable.

### Grafana shows broken assets

You set `GRAFANA_ROOT_URL` with a sub-path but forgot
`GRAFANA_SERVE_FROM_SUB_PATH=true`. Both must be set together. Fix and
`docker compose restart grafana`.

### Prometheus sub-path caveats

The Caddyfile uses `handle_path /prometheus/*` which strips the prefix.
Prometheus itself runs at root, so:
- Direct UI at `https://${PROXY_DOMAIN}/prometheus/` mostly works.
- A few internal asset links assume root and produce 404s in the UI.
- Federation / remote-write callbacks that expect `/prometheus/api/...`
  need the operator to flip Caddy to `handle /prometheus/*` (no strip)
  + Prom `--web.route-prefix=/prometheus` + Grafana datasource update.
  Out of scope for the default setup; document as a follow-up if/when
  external federation becomes a requirement.

For most operators the UI-only sub-path is sufficient. If full sub-path
support is required, run Prometheus on a dedicated subdomain
(`prometheus.${PROXY_DOMAIN}`) — Caddy needs only an extra vhost.

### `/mcp/` returns 401 even with credentials

Default `MCP_BASIC_AUTH_HASH` is a sentinel that rejects all callers
(Caddyfile comment explains). Generate a real hash:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'mcp-password-here'
# Copy output into .env as MCP_BASIC_AUTH_HASH=...
docker compose restart caddy
```

Then call: `curl -u mcp:mcp-password-here https://${PROXY_DOMAIN}/mcp/sse`.

Reminder: MCP itself has no built-in auth (see `mcp-security.md`). Caddy
basic-auth is the only auth layer. Set `MCP_ENABLED=true` in `.env` too
when re-enabling the server.

## Rolling back

```bash
# Just stop caddy — other services keep running unchanged
docker compose stop caddy
# Or remove from active profiles
sed -i 's/,proxy//' .env
docker compose up -d
```

Host ports `53550 53551 3005 9090 3000 9091 7047` keep working direct.

## Related

- `monitoring/caddy/Caddyfile` — single source of truth for routes
- `docs/runbooks/proxy-add-service.md` — adding a new internal service
- `docs/runbooks/mcp-security.md` — MCP threat model
- `docs/discoveries/startup-assessment-2026-05-13/06-epic-1-reverse-proxy.md` — full plan
