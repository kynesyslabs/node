---
type: runbook
title: Verify TLSNotary Proxy Pool Reachability
date: 2026-11-17
status: active
---

# Verify TLSNotary Proxy Pool Reachability

Each TLSNotary proxy session listens inside the node process on one port of
`TLSNOTARY_PROXY_PORT_MIN`-`MAX` (55000-55063 under compose, 55000-57000 on
bare metal), on `WSTCP_BIND_HOST`. The relay that replaced `wstcp` admits only
the websocket that carries the session's secret id, but the ports are still
meant for a reverse proxy on the same host only.

## The verdict

| Deployment | Reachability |
|---|---|
| Containerized via `docker-compose.yml` (default) | **Host loopback only** — compose sets `WSTCP_BIND_HOST=0.0.0.0` inside the container and publishes the window on `127.0.0.1`. |
| Bare metal (`./run`) | **Host loopback only** — `WSTCP_BIND_HOST` defaults to `127.0.0.1`. Setting it to `0.0.0.0` exposes the window on every interface; do not, and do not open it in the firewall. |

## One-liner to verify

Run after at least one `requestTLSNproxy` call has been granted (a session
listens only while it lives, at most 5 minutes).

```bash
sudo ss -tlnp 'sport >= :55000 && sport <= :57999' | tee /tmp/listeners.txt
nc -z -w2 "${EXPOSED_HOST:?public address of this host}" 55000-57999 2>&1 \
  | grep -i succ | tee /tmp/outside.txt
echo "LISTENERS=$(($(wc -l </tmp/listeners.txt) - 1)) OUTSIDE_REACHABLE=$(wc -l </tmp/outside.txt)"
```

Run the `nc` line from another machine for a true outside view.

- `OUTSIDE_REACHABLE = 0` → only the local reverse proxy reaches the sessions.
- `OUTSIDE_REACHABLE > 0` → a port is exposed: check `WSTCP_BIND_HOST`, the
  compose `ports:` mapping and the firewall.

## Related

- `src/features/tlsnotary/proxyRelay.ts`
- `src/features/tlsnotary/portAllocator.ts` (`proxyBindHost`)
- `docs/runbooks/tlsn-reverse-proxy.md`
