---
type: runbook
title: TLSNotary reverse-proxy routing (/tlsn/<port>/)
status: active
---

# TLSNotary reverse-proxy routing

The browser SDK opens `wss://<node-domain>/tlsn/<port>/` for both the notary and
each per-target **wstcp** proxy. The node's public reverse proxy must route
`/tlsn/<port>/` to the matching local port **as a WebSocket** (HTTP upgrade). If
it doesn't, the attest websocket closes with `CloseEvent: { code: 1006 }`.

This is required on **every** node that serves TLSN to a browser. The node image
(this is baked in — see the Dockerfile `wstcp` stage) and the published proxy
port range are repo-managed; the reverse proxy is the only piece an operator may
need to touch by hand.

## ⚠️ Two non-obvious gotchas

Both produce the **same** browser symptom — `CloseEvent 1006` — so check both.

**1. `Connection: Upgrade` must be capital-U.** `wstcp` 0.2.1 checks the
`Connection` header case-sensitively. The common nginx snippet uses
`proxy_set_header Connection "upgrade";` (lowercase), which `wstcp` rejects:

```
Invalid WebSocket handshake request: assertion failed: `values.any(|v| v.trim() == "Upgrade")`; value="upgrade"
```

→ the handshake never completes, every `/tlsn/<port>/` 502s, and the browser sees
`CloseEvent 1006`. Use **capital `Upgrade`**.

**2. The query string must be forwarded (`$is_args$args`).** The notary reads its
`sessionId` from the URL query (`/tlsn/<notary-port>/notarize?sessionId=…`). An
nginx `proxy_pass` that rebuilds the path as `…/$2;` **without** `$is_args$args`
drops the query on the WebSocket upgrade. The notary then answers:

```
Failed to deserialize query string: missing field `sessionId`
```

→ the upgrade fails and the browser sees `CloseEvent 1006`. The tell that it's
*this* one (not the casing bug): `/tlsn/<notary-port>/info` still returns `200`
while `notarize` fails. **This bit prod once — keep `$is_args$args`.**

## Caddy (repo-managed — automatic)

Deploying with the `proxy` compose profile applies
`monitoring/caddy/tlsnotary-modes/subpath.caddy`, which routes `/tlsn/<port>/`
for the notary and the wstcp proxies. Caddy's `reverse_proxy` performs the
upgrade with the correct casing — no manual step. Just redeploy.

## nginx (hand-maintained nodes)

Add this `location` inside the node's `listen 443 ssl; server_name <domain>;`
block, then `sudo nginx -t && sudo systemctl reload nginx`:

```nginx
# /tlsn/<port>/ -> 127.0.0.1:<port> — ONE block for the notary AND the wstcp
# proxies. The explicit port class is a security control: a bare `(\d+)`
# catch-all would let /tlsn/<port>/ reach any loopback port (RPC 53550,
# MCP 3001, ...). Keep it tight.
#   7047 / 7147  = the TLSNotary notary (TLSNOTARY_PORT; 7047 main/testnet,
#                  7147 devnet). Add your value here if you changed it.
#   5[567]\d{3}  = the 55000-57999 wstcp allocation window.
location ~ ^/tlsn/(7047|7147|5[567]\d{3})/?(.*)$ {
    # $is_args$args is REQUIRED — the notary reads sessionId from the query
    # (…/notarize?sessionId=…). Drop it and every notarize upgrade dies with
    # `CloseEvent 1006` (gotcha #2 above).
    proxy_pass http://127.0.0.1:$1/$2$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";   # capital U — wstcp is case-sensitive
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

The notary port is already covered by the class above. If your `TLSNOTARY_PORT`
is non-default, add it to the alternation
(`^/tlsn/(<your-port>|7047|7147|5[567]\d{3})/…`). **Do not** replace this with a
bare `^/tlsn/(\d+)/` catch-all: it reaches every loopback port *and* is the shape
that tends to lose `$is_args$args` — both failure modes have hit prod.

Prerequisites (both already handled by deploying this branch):

1. **wstcp baked into the image** — `docker exec <node> ls /app/.cargo/bin/wstcp`
   must exist.
2. **Proxy port range published on loopback** so nginx can reach it — e.g.
   `127.0.0.1:55000-55063` (mainnet) / `127.0.0.1:55100-55163` (devnet), matching
   `TLSNOTARY_PROXY_PORT_MIN/MAX`. Confirm with
   `docker port <node> | grep 55` and `sudo ss -ltn | grep ':55'`.

## Verify

```bash
# expect HTTP 101 (Switching Protocols)
curl -s -o /dev/null -w '%{http_code}\n' -k \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://<node-domain>/tlsn/<a-live-proxy-port>/
```

`101` → routing + upgrade are correct. `502` → the location is missing, the port
isn't published/reachable, or `Connection` is lowercase.

Notary query-string check (catches gotcha #2) — send an upgrade with a bogus
`sessionId` and read what the notary says:

```bash
curl -sk -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://<node-domain>/tlsn/<notary-port>/notarize?sessionId=x"
```

- `Session id x does not exist` → the query reached the notary; **good**.
- `missing field sessionId` → the proxy is dropping the query, you're missing
  `$is_args$args`. (`/tlsn/<notary-port>/info` returning `200` alongside this
  confirms the route is otherwise fine.)

## Note: HTTPS RPC

The browser client (HTTPS page) cannot call a plain-HTTP node RPC (mixed
content). The node RPC must be reachable over HTTPS at the URL the client is
built with. Production nodes already terminate TLS at the public domain; only
custom-port dev setups (`...:53650` with no TLS) need a dedicated `listen <port>
ssl` block in front of the RPC.
