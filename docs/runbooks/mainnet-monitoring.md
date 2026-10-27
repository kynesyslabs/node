---
type: runbook
title: Mainnet Monitoring and Alerting
date: 2026-10-22
status: active
---

# Mainnet Monitoring and Alerting

## Layout

One monitoring host, off the validators, runs the stack in `monitoring/`
(Prometheus, Alertmanager, Grafana). It scrapes every validator's metrics
endpoint over a private address. Validators run no Prometheus of their own.

```
validator-1 (METRICS_BIND=10.0.0.11) <--\
validator-2 (METRICS_BIND=10.0.0.12) <---+-- monitoring host: Prometheus -> Alertmanager -> Slack
validator-3 (METRICS_BIND=10.0.0.13) <--/
```

## Metrics port binding

`docker-compose.yml` publishes the node's metrics port on loopback by default:
`${METRICS_BIND:-127.0.0.1}:${METRICS_HOST_PORT:-9090}:9090`. The endpoint has
no authentication and lists peers and heights, so it must not face the internet.

To let the monitoring host in, set `METRICS_BIND` in the validator's `.env` to
the address of the private interface (a VPN or VPC address), or leave the
default and reach `127.0.0.1:9090` through an SSH tunnel. Never use `0.0.0.0`.
Restrict the port to the monitoring host's address in the firewall as well.

Nothing else depends on the host-side port: the bundled Prometheus and the
Caddy proxy reach the node as `node:9090` over the compose network.

## Setup on the monitoring host

1. In `monitoring/prometheus/prometheus.yml`, replace the `demos-node` target
   (`node:9090`, which only resolves inside the validators' compose network)
   with the validators' private `address:port` list. Keep the job name
   `demos-node`; the alert rules and the Grafana dashboards select on it.
2. Put the Slack incoming-webhook URL, alone on one line, in
   `monitoring/secrets/slack_webhook` (gitignored). `chmod 644` it so the
   container user can read it. Compose mounts it at `/run/secrets/slack_webhook`
   and Alertmanager reads it through `api_url_file`.
3. `cd monitoring && docker compose up -d`. Alertmanager listens on
   `127.0.0.1:9093` only.

## Alerts

Rules are in `monitoring/prometheus/alerts/consensus.yml`. Each fires per
validator (`instance` label).

| Alert | Condition | Severity | Meaning |
|-------|-----------|----------|---------|
| HeightStalled | no new block for 300 s, held 2 min | critical | The node has stopped advancing. If the whole network stalls, this fires on every validator at once: compare heights across validators before acting on one. |
| BlockHashMismatch | more than 3 peer disagreements on the candidate block hash in 10 min, held 5 min | warning | This node and its peers are building different blocks (mempool or clock divergence). |
| MissedSignatures | 3 or more blocks in 15 min where the node was drawn into the shard and did not sign | warning | The node is online but not taking part in consensus. |
| ForkScheduleMismatch | at least one validator reports a different fork schedule, held 5 min | critical | Genesis fork schedules differ; see `fork-schedule-policy.md`. |
| ConsensusAbstaining | the node is skipping rounds because most validators differ from it, held 1 min | critical | The node has taken itself out of consensus; see `fork-schedule-policy.md`. |
| MempoolBacklog | mempool above 8000 transactions, held 5 min | warning | Blocks are not draining the pool. Keep the threshold below the mempool hard cap, so the alert fires before the pool rejects transactions. |

The existing alerts in `node-health.yml`, `errors.yml` and `subsystems.yml` are
loaded from the same directory and use the same receiver.

Routing: critical and warning both go to the one Slack receiver. Critical
alerts wait 10 s before the first message and repeat hourly; warnings repeat
every 4 hours. Alerts are grouped per alert name and validator.

## Block watchdog stays off

`BLOCK_WATCHDOG_ENABLED` stays `false` on mainnet. The watchdog stops the node
with exit code 42 when no block arrives for the timeout. In a network-wide stall
that takes every validator down at the same moment and leaves nothing running to
restart the chain from, which defeats the rollback drill. `HeightStalled` is the
replacement: it tells the operators about the stall and leaves the decision to
them.

## Testing the routing

First confirm Prometheus sees Alertmanager: `curl -s 127.0.0.1:9091/api/v1/alertmanagers`
lists it under `activeAlertmanagers`.

Send a synthetic alert straight to Alertmanager, from the monitoring host:

```bash
curl -fsS -X POST http://127.0.0.1:9093/api/v2/alerts \
  -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"RoutingTest","severity":"critical","instance":"test"},
        "annotations":{"summary":"Routing test","description":"Synthetic alert, ignore."}}]'
```

A Slack message arrives after the critical group wait (10 s). With `amtool`
(shipped in the Alertmanager image):

```bash
docker exec demos-alertmanager amtool check-config /etc/alertmanager/alertmanager.yml
docker exec demos-alertmanager amtool config routes test --config.file=/etc/alertmanager/alertmanager.yml severity=warning alertname=MempoolBacklog
docker exec demos-alertmanager amtool alert add RoutingTest severity=critical instance=test --alertmanager.url=http://localhost:9093
docker exec demos-alertmanager amtool silence add alertname=RoutingTest --alertmanager.url=http://localhost:9093 --comment="routing test done"
```

To check a rule itself, query Prometheus (`:9091`) for its expression, for
example `demos_consensus_abstaining`, and look at Alerts in the UI.
