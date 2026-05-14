---
type: runbook
title: Interpret the /health Endpoint
date: 2026-05-14
status: active
---

# Interpret the /health Endpoint

The node's `/health` route is the single source of operational truth for
external probes (load balancers, k8s readiness, monitoring). Epic 13 T7
extended it to surface subsystem state, boot sequence, port drift, and
swallowed errors.

## Quick check

```bash
curl -fsS http://localhost:53550/health | jq
```

200 + `status` reflects node state. 503 means the node should not
receive traffic.

## Status precedence

`status` is one of, in order of severity:

| Status | HTTP | When |
|---|---|---|
| `ok` | 200 | All subsystems ready, boot complete, mainLoop alive |
| `degraded` | 200 | At least one optional subsystem failed (L2PS, MCP, TLSNotary) but core flow intact |
| `dormant` | 200 | Peer list was empty at boot — signaling/MCP/TLSN/mainLoop were skipped on purpose. Adds `X-Demos-Dormant: true` response header |
| `failing` | 503 | Chain DB unreachable, mempool count failing, OR mainLoop dead while not in dormant mode |

For k8s readiness probes: 503 is the only "not ready" signal. dormant +
degraded are 200 because the node is intentionally in that state.

## Response shape

```jsonc
{
  // PR #797 contract (preserved, do not break)
  "version": "1.0.0",
  "version_name": "...",
  "accepting": true,
  "mempool_size": 42,
  "uptime_s": 1234,

  // Epic 13 T7 additions
  "status": "ok",
  "dormant": false,
  "boot": {
    "complete": true,
    "steps_total": 14,
    "steps_ready": 14,
    "steps_failed": 0,
    "steps_skipped": 0,
    "current": null            // step name when boot is still running
  },
  "subsystems": {
    "chain":     { "status": "ready", "since": 1731578400000, "port": null,  "lastError": null },
    "rpc":       { "status": "ready", "since": 1731578400500, "port": 53550, "lastError": null },
    "main_loop": { "status": "ready", "since": 1731578430000, "port": null,  "lastError": null },
    "..."
  },
  "ports": {
    "rpc":       { "requested": 53550, "actual": 53550, "drifted": false },
    "signaling": { "requested": 3005,  "actual": 3007,  "drifted": true }
  },
  "main_loop": {
    "heartbeat_age_s": 1,
    "iterations_total": 1234,
    "exited": false,
    "exit_reason": null
  },
  "errors": {
    "uncaught_total": 0,
    "unhandled_rejection_total": 0,
    "last_uncaught": null
  }
}
```

## Subsystem status values

| Status | Meaning |
|---|---|
| `pending` | Registered, not started yet |
| `running` | Init in progress (mainly used for mainLoop pre-first-heartbeat) |
| `ready` | Fully operational |
| `failed` | Errored out — see `lastError` |
| `skipped` | Operator disabled OR dormant-mode skip — see `extra.reason` |
| `dormant` | (reserved for future use) |

## Slim sibling endpoint

For ops dashboards that only need subsystem state:

```bash
curl -fsS http://localhost:53550/health/subsystems | jq
```

Returns `{ dormant, subsystems }` only. Same rate-limit allowlist as
`/health` (bypasses the rate limiter).

## Probe recipes

### Load balancer

```
GET /health
Expect 2xx; consider Connection: close.
```

The LB does not need to parse the body — 503 means "remove from rotation",
2xx means "keep in rotation". Dormant nodes stay in rotation because they
can still serve read-only RPC.

### k8s readiness

```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 53550
  initialDelaySeconds: 60
  periodSeconds: 10
```

### Manual sanity check

```bash
# Are all subsystems up?
curl -fsS http://localhost:53550/health | \
  jq '.subsystems | to_entries[] | select(.value.status != "ready" and .value.status != "skipped")'

# What boot step are we on?
curl -fsS http://localhost:53550/health | jq '.boot'

# Did a port drift?
curl -fsS http://localhost:53550/health | jq '.ports | to_entries[] | select(.value.drifted)'
```

## Common failure patterns

### `status: failing`, `subsystems.chain.status: failed`

Postgres unreachable. Check:
```bash
docker compose ps postgres
docker compose logs postgres | tail -50
```

### `status: failing`, `main_loop.exited: true`

mainLoop crashed. `main_loop.exit_reason` carries the error message;
deeper context in `errors.last_uncaught`. Note that the node keeps
serving RPC even after mainLoop death (intentional — Epic 14 T3). Block
production has stopped.

### `status: dormant`

See `docs/runbooks/dormant-mode.md`.

### `errors.uncaught_total` rising

Subsystems are throwing into the global uncaughtException handler. The
node continues but is likely in an inconsistent state. Inspect
`errors.last_uncaught.message` + recent logs.

## Related metrics

Every field in `/health` has a Prometheus mirror — see
`monitoring/prometheus/alerts/*.yml` for the alert rules built on top.

- `demos_subsystem_up{subsystem}` — 1 when ready/running
- `demos_dormant_mode` — 1 when dormant
- `demos_main_loop_heartbeat_seconds` — staleness of last heartbeat
- `demos_boot_complete` — 1 when all required steps are done
- `demos_uncaught_exception_total{source}` — counter

## Related

- `docs/runbooks/dormant-mode.md`
- `docs/discoveries/startup-assessment-2026-05-13/07-epic-2-healthcheck-observability.md`
- `src/libs/network/server_rpc.ts` — the route itself
- `src/utilities/subsystemRegistry.ts` — registry + tracker source
