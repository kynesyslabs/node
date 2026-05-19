---
type: runbook
title: Diagnose & Recover from Dormant Mode
date: 2026-05-14
status: active
---

# Diagnose & Recover from Dormant Mode

The node entered "dormant mode" when its peer list was empty at boot.
RPC + metrics keep answering, but consensus is frozen: signaling, MCP,
TLSNotary, mainLoop, DTR, and L2PS were all skipped.

The dormant path lives at `src/index.ts:589-594` (the `enough_peers=false`
gate). Pre-Epic 13 this was silent — the node looked healthy. Now it
surfaces explicitly.

## How to recognise it

Any of these = dormant:

```bash
curl -fsS http://localhost:53550/health | jq '.status'
# "dormant"

curl -fsS http://localhost:53550/health | jq '.dormant'
# true

# Prometheus
demos_dormant_mode == 1

# Boot log
[BOOT] DORMANT MODE: peer list empty; signaling / MCP / TLSNotary / ...

# Response header
HTTP/1.1 200 OK
X-Demos-Dormant: true
```

Prom alert `NodeDormant` fires after 10 minutes in this state.

## Why it happens

1. **First boot with no `demos_peerlist.json`.** Common for the very
   first node in a new network or a fresh local dev setup. Bootstrap the
   peer list with `EXPOSED_URL` and any known seed peer.
2. **All bootstrap peers are down.** Common in development environments
   where you stopped the only other node.
3. **Network egress blocked.** Firewall or DNS issue. The node never
   reached any peer to add it to the list.
4. **Identity mismatch.** The node identity changed (e.g. you wiped
   `.demos_identity.key`) — known peers won't recognise the new key. Not
   strictly dormant-mode but presents identically.

## Triage

### 1. Confirm dormant state and check the peer file

```bash
curl -fsS http://localhost:53550/health | jq '{status, dormant, subsystems: (.subsystems | to_entries | map(select(.value.status=="skipped")))}'

# Peer list
cat demos_peerlist.json | jq length
# Expect > 0
```

If the peer file is empty or missing, that's the proximate cause.

### 2. Check connectivity to a known peer

```bash
# Pick a peer from your network's bootstrap list
PEER_URL="https://bootstrap.example.com/health"
curl -fsS "$PEER_URL"
```

503 / timeout / refused → the peer is down or unreachable from this
host. Try a second peer. If all fail, egress is the problem.

### 3. Check egress

```bash
# DNS
dig +short bootstrap.example.com
# Reachability on the node's RPC port
nc -zv bootstrap.example.com 443
```

### 4. Inspect bootstrap logs

```bash
docker compose logs node | grep -E "(PEER|BOOT|peerBootstrap)" | tail -50
```

## Recovery

### Seed a peer manually

Edit `demos_peerlist.json` to include at least one reachable peer:

```json
[
  {
    "identity": "<peer-public-key-hex>",
    "connection": { "string": "https://bootstrap.example.com" }
  }
]
```

Restart the node:

```bash
docker compose restart node
```

Watch the boot log for `[PEER] peerBootstrap` / `[BOOT] subsystem
signaling: pending -> ready`.

### Use `demos_peerlist.json.example`

The repo ships a minimal example:

```bash
cp demos_peerlist.json.example demos_peerlist.json
docker compose restart node
```

### Force re-bootstrap (advanced)

If the node has stale peers that all became unreachable, wiping the
peer list forces re-discovery:

```bash
docker compose stop node
rm demos_peerlist.json
cp demos_peerlist.json.example demos_peerlist.json
docker compose start node
```

## Will it exit dormant mode by itself?

**No.** Today the gate is evaluated once at boot. If you add a peer to
`demos_peerlist.json` while the node is dormant, you must restart for it
to take effect. Periodic re-evaluation is tracked in Epic 13 follow-ups
(not in this commit).

## How to silence the alert during expected outages

For planned bootstrap maintenance (or single-node dev work) the
`NodeDormant` Prom alert can be inhibited at alertmanager. In dev,
simpler: bring the node up with a one-element local peer list.

## Verify after recovery

```bash
curl -fsS http://localhost:53550/health | jq '{status, dormant, peers: .subsystems.signaling.status, mainLoop: .subsystems.main_loop.status}'
# Expect: status "ok" (or "degraded"), dormant false, signaling "ready", main_loop "ready"
```

If `main_loop.status` stays `pending` after several seconds, check
`/health.main_loop.heartbeat_age_s` — it should be small (< 5s) when the
loop is alive.

## Related

- `docs/runbooks/health-endpoint.md`
- `src/index.ts:589-594` — the gate
- `docs/discoveries/startup-assessment-2026-05-13/05-fragility-synthesis.md` — original assessment
- Prom alert: `monitoring/prometheus/alerts/node-health.yml` — `NodeDormant`
