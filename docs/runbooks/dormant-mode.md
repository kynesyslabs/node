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
curl -sS http://localhost:53550/health | jq '.status'
# "dormant"

curl -sS http://localhost:53550/health | jq '.dormant'
# true

# Prometheus
demos_dormant_mode == 1

# Boot log
[BOOT] DORMANT MODE: peer list empty; signaling / MCP / TLSNotary / ...

# Response header: /health is a readiness probe and refuses a dormant node
# (both routes are GET-only, so -I / HEAD gets a 404: dump headers instead)
curl -sS -D - -o /dev/null http://localhost:53550/health
HTTP/1.1 503 Service Unavailable
X-Demos-Dormant: true

# /health/live (liveness) still answers 200 with the same header
curl -sS -D - -o /dev/null http://localhost:53550/health/live
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
curl -sS http://localhost:53550/health | jq '{status, dormant, subsystems: (.subsystems | to_entries | map(select(.value.status=="skipped")))}'

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
{
  "<peer-public-key-hex>": "https://bootstrap.example.com"
}
```

Use another validator's key and URL. On this node's RPC port, only the exact
bound host (`RPC_BIND`) is skipped, plus, for a wildcard bind (`0.0.0.0` or
`::`), a numeric loopback address the listener accepts (`127.0.0.0/8`, `::1`,
or IPv4-mapped `127.0.0.0/8`). A hostname bind such as `RPC_BIND=localhost`
matches only that hostname, and a numeric bind only that same address, so
with `RPC_BIND=localhost` an entry for `http://127.0.0.1:53550` is dialed.
Other spellings, including `localhost` on a wildcard bind and this node's
public URL, are dialed. If they answer as this node, boot is refused and the
error log names the URL. Remove that entry from the peer list by hand before
restarting.

For an instance started with `scripts/docker-run`, rerun the launcher with
the same flags. Its `up` command copies the edited host peer list into the
matching state volume before recreating the node. For example:

```bash
scripts/docker-run up -d --force-recreate node                 # default
scripts/docker-run --port 53650 up -d --force-recreate node    # --port instance
scripts/docker-run --devnet up -d --force-recreate node        # devnet
scripts/docker-run --proxy up -d --force-recreate node         # proxy
scripts/docker-run --db 5433 up -d --force-recreate node       # custom DB port
```

Include every flag used to start the instance when combining options (for
example, `--port 53650 --db 5433`). `--proxy` is not safe on a host that
already runs another proxied instance because Caddy binds fixed ports 80/443.
A proxy instance started with additional profile flags needs those flags too.
For a plain stack started directly with Compose, copy the peer list into its
state volume before running `docker compose up -d --force-recreate node`.

Watch the boot log for `[PEER] peerBootstrap` / `[BOOT] subsystem
signaling: pending -> ready`.

### Use `demos_peerlist.json.example`

The repo ships a placeholder (`"0x<64-hex public key of a known validator>":
"https://<host>:53550"`). Copy it, then replace both values with a real
validator's public key and URL; the placeholder itself is skipped and leaves
the node with no peers:

```bash
cp demos_peerlist.json.example demos_peerlist.json
# edit demos_peerlist.json: set a real validator key and URL
scripts/docker-run up -d --force-recreate node # add original flags before up
```

### Force re-bootstrap (advanced)

If all saved peers are unreachable, stop the node and replace the stale
entries in `demos_peerlist.json` with a reachable validator's public key
and URL, using the format in "Seed a peer manually" above. An empty list
or an unedited example has no usable seed for bootstrap.

```bash
scripts/docker-run stop node # add the original launcher flags before stop
```

Edit `demos_peerlist.json` as described above, then use the launcher with
the original flags to sync the file and recreate the node:

```bash
scripts/docker-run up -d --force-recreate node # add original flags before up
```

## Will it exit dormant mode by itself?

**No.** Today the gate is evaluated once at boot. If you add a peer to
`demos_peerlist.json` while the node is dormant, you must recreate it for
the change to take effect. Periodic re-evaluation is tracked in Epic 13 follow-ups
(not in this commit).

## How to silence the alert during expected outages

For planned bootstrap maintenance (or single-node dev work) the
`NodeDormant` Prom alert can be inhibited at alertmanager. In dev,
simpler: bring the node up with a one-element local peer list.

## Verify after recovery

```bash
curl -sS http://localhost:53550/health | jq '{status, dormant, peers: .subsystems.signaling.status, mainLoop: .subsystems.main_loop.status}'
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
