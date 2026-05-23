---
type: runbook
title: Add a New Service Behind the Caddy Proxy
date: 2026-05-14
status: active
---

# Add a New Service Behind the Caddy Proxy

Pattern for routing a new internal HTTP/WS service through the existing
`monitoring/caddy/Caddyfile`. Assumes Epic 12 reverse-proxy is already
running (see `docs/runbooks/proxy-setup.md`).

## Decision: path or subdomain?

| Trade-off | Sub-path | Subdomain |
|---|---|---|
| DNS records | none (uses existing `${PROXY_DOMAIN}`) | new A or CNAME |
| Cert count | reuses single cert | one cert per subdomain |
| Service-side config | needs to know its sub-path (root-url / base-href) | none |
| Operational simplicity | higher | slightly lower |
| Works for any service | only ones with sub-path support | yes |

Default to sub-path. Use a subdomain when the upstream service has poor
sub-path support (full Prometheus federation, raw Bittorrent trackers,
etc.).

## Sub-path recipe

### 1. Add a `handle_path` block to `monitoring/caddy/Caddyfile`

Put it **before** the catch-all `handle { reverse_proxy node:53550 }` at
the bottom. `handle_path` strips the prefix before forwarding:

```caddyfile
handle_path /myservice/* {
    reverse_proxy myservice:8080
}
```

For WebSockets: nothing extra — Caddy auto-detects `Upgrade: websocket`.

### 2. (Optional) Add basic-auth

Pattern matches `/metrics` and `/mcp` in the existing Caddyfile:

```caddyfile
handle_path /myservice/* {
    basic_auth {
        myuser {$MYSERVICE_BASIC_AUTH_HASH:$2a$14$invalidinvalid...}
    }
    reverse_proxy myservice:8080
}
```

Then add `MYSERVICE_BASIC_AUTH_HASH=` to `.env.example` (commented) and
hand the operator the `caddy hash-password` command.

### 3. Validate locally

```bash
docker run --rm \
  -v $(pwd)/monitoring/caddy:/etc/caddy:ro \
  -e PROXY_DOMAIN=node.example.com \
  -e ACME_EMAIL=ops@example.com \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expect `Valid configuration` at the bottom.

### 4. Reload the live proxy

```bash
# Reload — zero downtime, no cert dance, picks up the new route
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Fallback if `reload` rejects the new config:

```bash
docker compose restart caddy
```

### 5. Smoke test

```bash
curl -fsS "https://${PROXY_DOMAIN}/myservice/" | head -20
```

## Subdomain recipe

### 1. DNS

Add an A record `myservice.${PROXY_DOMAIN}` → host IP (or CNAME → the
root domain). Wait for propagation.

### 2. Caddyfile

Add a new top-level vhost block. Caddy auto-issues a cert for it.

```caddyfile
myservice.{$PROXY_DOMAIN} {
    tls {$ACME_EMAIL}
    reverse_proxy myservice:8080
}
```

### 3. Reload

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### 4. Watch the cert provision

```bash
docker compose logs -f caddy | grep -i myservice
```

First request may stall ~5s while ACME issues the cert; subsequent
requests are immediate.

## Common pitfalls

- **WebSocket but client sees a 502**: the upstream likely doesn't bind
  `0.0.0.0`. Caddy reaches it over the docker bridge — make sure your
  service listens on its container interface, not loopback.
- **Sub-path 404s with relative asset URLs**: the upstream service
  doesn't know its sub-path. Either configure it (most UIs have a
  `--root-url` or `BASE_HREF` setting) or switch to a subdomain.
- **Caddy basic-auth always 401**: the sentinel hash in the example
  format rejects everyone. Generate a real one with
  `caddy hash-password --plaintext 'pwd'`.
- **`caddy reload` exits non-zero**: config is invalid; `caddy validate`
  it first. Caddy keeps the previous config running on reload failure
  (no downtime), but no new routes are picked up either.

## Related

- `docs/runbooks/proxy-setup.md` — initial Caddy bring-up
- `monitoring/caddy/Caddyfile` — current routes
- Caddy reverse-proxy docs: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
