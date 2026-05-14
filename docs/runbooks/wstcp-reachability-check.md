---
type: runbook
title: Verify wstcp Pool Reachability
date: 2026-05-14
status: active
---

# Verify wstcp Pool Reachability

The TLSNotary feature spawns `wstcp` proxies on ports 55000-57000 inside
the node container. Depending on deployment mode, these ports may or may
not be reachable from outside the host. Epic 14 audited this and
recorded a verdict, but operators should verify in their own environment
before making security decisions.

## The verdict

| Deployment | Reachability |
|---|---|
| Containerized via `docker-compose.yml` (default) | **De facto internal only** — bridge network, no `ports:` mapping for 55000-57000, `0.0.0.0` bind stays in container namespace. |
| Bare-metal via `scripts/run` with `ufw allow 55000:60000/tcp` (`README.md:189`) | **Host-exposed** — wstcp binds host's `0.0.0.0` directly. |

## One-liner to verify

Run after at least one `requestTLSNproxy` call has been made (the pool
is lazy — empty until first SDK request).

```bash
docker compose exec node ss -tlnp 'sport >= :55000 && sport <= :57000' \
  2>/dev/null | tee /tmp/inside.txt
nc -z -w2 "${EXPOSED_HOST:-127.0.0.1}" 55000-57000 2>&1 \
  | grep -i succ | tee /tmp/outside.txt
echo "INSIDE_LISTENERS=$(wc -l </tmp/inside.txt) \
OUTSIDE_REACHABLE=$(wc -l </tmp/outside.txt)"
```

Interpretation:

- `INSIDE_LISTENERS > 0 && OUTSIDE_REACHABLE = 0`
  → de facto internal (containerized default). Safe.
- `INSIDE_LISTENERS > 0 && OUTSIDE_REACHABLE > 0`
  → host-exposed. Either bare-metal mode OR manual port publish.
  Confirm the operator opened the firewall on purpose.

## Why this matters

Epic 12 T9 plans to flip the wstcp bind from `0.0.0.0` to `127.0.0.1` to
reduce attack surface. That flip is **safe only in containerized
deployments behind a co-located reverse proxy** (the proxy reaches the
container's bridge IP, not loopback). In bare-metal mode the flip would
break external SDK clients.

Before applying Epic 12 T9 in your environment, run this check. If the
verdict is "host-exposed", postpone T9 until the reverse proxy is in
place.

## Related

- `src/features/tlsnotary/portAllocator.ts:83`
- `src/features/tlsnotary/proxyManager.ts:281`
- `docs/discoveries/startup-assessment-2026-05-13/03-ports-and-certs.md`
- `docs/discoveries/startup-assessment-2026-05-13/06-epic-1-reverse-proxy.md` (Epic 12 T9)
- `docs/discoveries/startup-assessment-2026-05-13/08-epic-3-blockers.md` (Epic 14 T0)
