---
type: runbook
title: TLSNotary reverse-proxy routing (/tlsn/<port>/)
status: active
---

# TLSNotary reverse-proxy routing

The browser SDK opens `wss://<node-domain>/tlsn/<port>/` for the notary and
`wss://<node-domain>/tlsn/<port>/<session-id>` for its proxy session. The node's
public reverse proxy must route `/tlsn/<port>/` to the matching local port **as a
WebSocket** (HTTP upgrade), keeping the rest of the path. If it doesn't, the
attest websocket closes with `CloseEvent: { code: 1006 }`.

This is required on **every** node that serves TLSN to a browser. The relay runs
inside the node process and the published proxy port range is repo-managed; the
reverse proxy is the only piece an operator may need to touch by hand.

## What a proxy session is

`requestTLSNproxy` opens a session only when all of these hold:

- TLSNotary is on for this node (`TLSNOTARY_ENABLED=true`);
- the call comes over the HTTP RPC, signed over its body and naming this node
  as the audience (the `body-hash` and `audience` auth headers; the older
  `identity:timestamp` form is refused with 401), and the signer is the sender
  of the `tlsn_request` whose hash is the `tokenId`. A `owner` field in the
  body, if sent, must name the same account;
- that `tlsn_request` is confirmed on chain, for the same host as `targetUrl`,
  and its block is less than 30 minutes old;
- the token has opened fewer than 3 sessions on this node. A new request for a
  token ends its live session first, so a token has at most one;
- the signer has fewer than 2 live sessions and the caller's address (an IPv6
  /64 counts as one) fewer than 4; at most 6 calls per minute per account and 20
  per address.

Each session listens on one port of the window and accepts **one** websocket,
and only on a path whose last segment is its 64-hex session id (403 otherwise,
409 for a second websocket). It dials the address the target's name resolved to
when the session was granted, and it ends, freeing its port, when:

- 5 minutes have passed since it was granted (or the token expires, if that is
  sooner), connected or not;
- a connected session relays nothing for 60 s;
- the client sends more than `2 × TLSNOTARY_MAX_SENT_DATA + 16 KiB`, or the
  target sends more than `2 × TLSNOTARY_MAX_RECV_DATA + 32 KiB`;
- either side closes.

Sessions listen on `WSTCP_BIND_HOST`: `127.0.0.1` by default (bare metal behind a
reverse proxy on the same host), `0.0.0.0` inside the compose container, where
the window is published on loopback only.

## ⚠️ Two non-obvious gotchas

Both produce the **same** browser symptom — `CloseEvent 1006` — so check both.

**1. The path after `/tlsn/<port>/` must be forwarded.** The proxy session reads
its session id from the last path segment and refuses the upgrade with `403`
without it. The nginx block below forwards it as `$2`. (The old `wstcp` relay
also needed `Connection: Upgrade` with a capital U; the in-process relay
accepts either casing, and the snippet keeps the capital for the notary.)

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
for the notary and the proxy sessions. Caddy's `reverse_proxy` performs the
upgrade with the correct casing — no manual step. Just redeploy.

## nginx (hand-maintained nodes)

Add this `location` inside the node's `listen 443 ssl; server_name <domain>;`
block, then `sudo nginx -t && sudo systemctl reload nginx`:

```nginx
# /tlsn/<port>/ -> 127.0.0.1:<port> — ONE block for the notary AND the proxy
# sessions. The explicit port class is a security control: a bare `(\d+)`
# catch-all would let /tlsn/<port>/ reach any loopback port (RPC 53550,
# MCP 3001, ...). Keep it tight.
#   7047 / 7147  = the TLSNotary notary (TLSNOTARY_PORT; 7047 main/testnet,
#                  7147 devnet). Add your value here if you changed it.
#   5[567]\d{3}  = the 55000-57999 proxy session window.
location ~ ^/tlsn/(7047|7147|5[567]\d{3})/?(.*)$ {
    # $is_args$args is REQUIRED — the notary reads sessionId from the query
    # (…/notarize?sessionId=…). Drop it and every notarize upgrade dies with
    # `CloseEvent 1006` (gotcha #2 above).
    proxy_pass http://127.0.0.1:$1/$2$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
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

1. **TLSNotary on for the node** — `TLSNOTARY_ENABLED=true`, or every
   `requestTLSNproxy` answers `503 PROXY_DISABLED`.
2. **Proxy port range published on loopback** so nginx can reach it — e.g.
   `127.0.0.1:55000-55063` (mainnet) / `127.0.0.1:55100-55163` (devnet), matching
   `TLSNOTARY_PROXY_PORT_MIN/MAX`. Confirm with
   `docker port <node> | grep 55` and `sudo ss -ltn | grep ':55'`.

## Verify

```bash
# expect HTTP 403: the session answered and refused the wrong session id
curl -s -o /dev/null -w '%{http_code}\n' -k \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://<node-domain>/tlsn/<a-live-proxy-port>/not-the-session-id
```

`403` → routing reaches the live session (only the holder of the session id gets
`101`). `502` → the location is missing, the port isn't published/reachable, or
no session is live on that port. A live port is in the `websocketProxyUrl` a
`requestTLSNproxy` answer carries.

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
