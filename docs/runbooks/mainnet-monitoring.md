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
validator-2 (METRICS_BIND=10.0.0.12) <---+-- monitoring host: Prometheus -> Alertmanager -> Slack / paging / dead-man
validator-3 (METRICS_BIND=10.0.0.13) <--/
```

## Metrics port binding

`docker-compose.yml` publishes the node's metrics port on loopback by default:
`${METRICS_BIND:-127.0.0.1}:${METRICS_HOST_PORT:-9090}:9090`. The endpoint has
no authentication by default and lists peers and heights, so it must not face
the internet.

`METRICS_BEARER_TOKEN` adds a second line of defence: with it set, `/metrics`
answers only `Authorization: Bearer <token>` (`/health` stays open). Put the
same token in a file on the monitoring host and add
`authorization: { credentials_file: <file> }` to the `demos-node` scrape job;
the Caddy `/metrics` route forwards the token on its own.

To let the monitoring host in, set `METRICS_BIND` in the validator's `.env` to
the address of the private interface (a VPN or VPC address), or leave the
default and reach `127.0.0.1:9090` through an SSH tunnel. Never use `0.0.0.0`.
Restrict the port to the monitoring host's address in the firewall as well.

Nothing else depends on the host-side port: the bundled Prometheus and the
Caddy proxy reach the node as `node:9090` over the compose network.

A bare-metal validator (`./run`) has no compose layer: the metrics server
itself binds `METRICS_HOST`, which defaults to `127.0.0.1`. Set
`METRICS_HOST` to the private interface's address in its `.env` so the
monitoring host can scrape it; until then `NodeDown` fires for that node.

## Setup on the monitoring host

Run every command in this runbook from the repository root (the directory that
contains `monitoring/` and `scripts/`), except the `docker exec` commands, which
do not depend on the working directory.

1. In `monitoring/prometheus/prometheus.yml`, replace the `demos-node` target
   (`node:9090`, which only resolves inside the validators' compose network)
   with one `static_configs` entry per validator, each with its own `instance`
   label (`validator-1`, `validator-2`, ...; the commented template at the end of
   the file shows the shape). Keep the job name `demos-node`; the alert rules
   and the Grafana dashboards select on it. One target per validator is what
   makes a single validator's NodeDown, HeightStalled or DiskSpaceLow fire on
   its own instead of as one merged alert. Do the same for the optional
   `node-exporter` job (`--profile full` in the validator's compose) if you
   want host metrics such as the Postgres volume's free space.
2. Put the three webhook URLs, each alone on one line, in
   `monitoring/secrets/slack_webhook`, `pager_webhook` and `deadman_webhook`
   (gitignored; see `monitoring/secrets/README.md`). `chmod 644` them so the
   container user can read them. Compose mounts them at `/run/secrets/` and
   Alertmanager reads them through `api_url_file` / `url_file`.
3. `docker compose -f monitoring/docker-compose.yml up -d`. Alertmanager listens on
   `127.0.0.1:9093` only. Then send a test alert to each receiver and confirm
   that a person sees it (the Slack message, the page, and the heartbeat at the
   dead-man service): the heartbeat does not test the `slack` or `paging`
   webhooks, and a placeholder URL left in a secret file is not detected at
   start. Use `amtool alert add` against the running Alertmanager, one alert per
   route (see "Testing the routing" below for the full commands):
   `docker exec demos-alertmanager amtool alert add RoutingTest severity=critical instance=test --alertmanager.url=http://localhost:9093`
   (critical reaches Slack and paging) and the same with `severity=warning`
   (Slack only). Silence `RoutingTest` afterwards.
4. `./scripts/check-monitoring.sh` (needs `promtool` and `amtool`) checks the
   config, runs the rule unit tests in `monitoring/prometheus/tests/` and
   checks that each severity reaches the right receiver.

## Alerts

Rules are in `monitoring/prometheus/alerts/consensus.yml` and `node-health.yml`.
Each fires per validator (`instance` label).

| Alert | Condition | Severity | Meaning |
|-------|-----------|----------|---------|
| HeightStalled | no new block for 300 s, held 2 min; keeps firing 10 min after it clears | critical | The node has stopped advancing. If the whole network stalls, this fires on every validator at once: compare heights across validators before acting on one. |
| BlockHashMismatch | more than 3 peer disagreements on the candidate block hash within 10 min, **latched 7 days** | warning | This node and its peers are building different blocks (mempool or clock divergence). Check the mempool, clock skew and the log for the tx-set diff. Does not resolve by itself: see "Clearing a latched alert". |
| ConflictingBlock | a peer holds a different block with a verified quorum at a height where this node has one, **latched 7 days** | critical | A fork. The node does not switch chains on its own. Search the log for `[FORK]` for the height and both hashes, decide which chain to keep. See "Clearing a latched alert". |
| ForeignSignature | a peer block carries a signature by this node's key that the node never recorded, **latched 7 days** | critical | The key runs somewhere else and this node stopped signing; see `validator-key.md`. A double-sign signal: does not resolve by itself, see "Clearing a latched alert". |
| SigningHalted | `demos_signing_halted` is 1, for as long as signing is stopped | critical | The stop holds across restarts only while `demos_signing_halt_marker_present` is 1. If it is 0, the marker write failed: keep the node stopped until every other copy of the key is stopped. |
| PrecommitEquivocation | a committee member precommitted two different blocks at one height and round, **latched 7 days** | critical | That member's key runs twice or its signing state was rolled back. The log line `[commitLock] Equivocation` names it. A double-sign signal: does not resolve by itself, see "Clearing a latched alert". |
| MissedSignatures | 3 or more blocks in 15 min where the node was drawn into the shard and did not sign | warning | The node is online but not taking part in consensus. |
| ForkScheduleMismatch | at least one validator reports a different fork schedule, held 5 min | critical | Genesis fork schedules differ; see `fork-schedule-policy.md`. |
| ConsensusAbstaining | the node is skipping rounds because most validators differ from it, held 1 min | critical | The node has taken itself out of consensus; see `fork-schedule-policy.md`. |
| MempoolBacklog | mempool above 8000 transactions, held 5 min | warning | Blocks are not draining the pool. Keep the threshold below the mempool hard cap, so the alert fires before the pool rejects transactions. |
| ClockOffset | the host clock more than 1 s from NTP, held 15 min | warning | The validator's host NTP is not keeping time; see [Validator clock](#validator-clock). |

The existing alerts in `node-health.yml`, `errors.yml` and `subsystems.yml` are
loaded from the same directory and use the same routing. Among them:

| Alert | Condition | Severity | Meaning |
|-------|-----------|----------|---------|
| NodeDown | `up == 0` for 1 min on a validator's `demos-node` target | critical | That validator's metrics endpoint is unreachable (crash, host down, firewall). Each validator alerts on its own `instance`. Check the process and the host first; if several fire at once suspect the network path to the monitoring host. A removed single target is not detected, only "no target at all". |
| MempoolStuck | transactions pending and none included in a stored block for 10 min | warning | Block production has stalled while the pool fills. |
| DiskSpaceLow | under 20 GiB free on the filesystem of `DISK_SPACE_PATH` (Docker: the `/app/data` volume; otherwise the working directory), held 10 min | warning | Prune logs, snapshots and Docker build cache, or grow the volume. |
| DiskSpaceCritical | under 5 GiB free, held 2 min | critical | The node refuses to start below `MIN_DISK_SPACE` (default 5 GiB) and Postgres fails writes on a full disk. Neither alert sees the Postgres volume when it is on another filesystem; watch it through node-exporter's `node_filesystem_avail_bytes`. |
| DeadMansSwitch | always firing | none | Heartbeat to the `deadman` receiver. It proves only that Prometheus, Alertmanager and the path to the dead-man receiver work. If the external watchdog stops receiving it, one of those is down: check the monitoring host first. It does **not** prove that the `paging` or `slack` webhooks work: a wrong or forgotten URL there fails silently while the heartbeat stays healthy (see the test alert in setup step 3). |

The rules have promtool unit tests in `monitoring/prometheus/tests/`; run
`promtool test rules monitoring/prometheus/tests/*.test.yml` after editing them.

Routing: `critical` (and an explicit `page`) goes to **both** the **paging**
receiver and **Slack** (the paging route has `continue: true`, the next route
sends the same alert to Slack), waits 10 s before the first message and repeats
hourly. `warning` and `info` go to **Slack** only, warnings repeating every 4
hours. `DeadMansSwitch` goes to its own **deadman** receiver only and is re-sent
every minute (`group_interval: 1m` with `repeat_interval: 50s`; a `repeat_interval`
of 1m would skip every other flush and re-send only every 2 minutes, so keep it
below `group_interval`). Alerts are grouped per alert name and validator. All three
receiver URLs are placeholders in `monitoring/secrets/`.

## Clearing a latched alert

`BlockHashMismatch`, `ConflictingBlock`, `ForeignSignature` and
`PrecommitEquivocation` keep firing for 7 days after the last event, through
restarts and lost scrapes, because a fork or a double-sign is not over when the
counter stops moving. `ForeignSignature` and `PrecommitEquivocation` are
double-sign signals and must not auto-resolve after 10 minutes. A recording rule
keeps the 10 minute burst size as its own series
(`demos:consensus_block_hash_mismatch:increase10m`,
`demos:conflicting_block:increase10m`, `demos:foreign_signature:increase10m`,
`demos:precommit_equivocation:increase10m`) and the alert is its 7 day maximum.
Only metrics the node exports today are used.

Run the `docker compose` commands below from the repository root, as in setup.

1. Investigate and resolve the fork, mismatch or double-sign first (for
   `ForeignSignature` and `PrecommitEquivocation`: every copy of the key found
   and stopped, see `validator-key.md`).
2. Acknowledge: add an Alertmanager silence for the alert and instance
   (`docker exec demos-alertmanager amtool silence add alertname=ConflictingBlock instance=validator-2 --duration=7d --comment="<ticket>" --alertmanager.url=http://localhost:9093`).
   `amtool silence add` lasts 1 hour unless told otherwise, and the alert keeps
   firing for up to 7 days (the critical route repeats hourly), so always pass
   `--duration=7d` or an explicit `--end`. This stops the pages; the alert stays
   visible in Prometheus.
3. Clear: at least 10 minutes after the last event, delete the recorded series
   for that instance through the Prometheus admin API. The admin API is **not
   enabled by default**, and `monitoring/docker-compose.yml` does not enable it.
   **Security: Prometheus is published on all interfaces, without
   authentication** (the `"${PROMETHEUS_PORT:-9091}:9090"` port line in
   `monitoring/docker-compose.yml` has no `127.0.0.1:` prefix, unlike
   Alertmanager). `--web.enable-admin-api` opens unauthenticated delete,
   snapshot and tombstone-cleaning APIs to anyone who can reach that port. So
   **before enabling the flag**, bind the port to loopback: in the `ports:` of
   the `prometheus` service in `monitoring/docker-compose.yml`, change
   `"${PROMETHEUS_PORT:-9091}:9090"` to
   `"127.0.0.1:${PROMETHEUS_PORT:-9091}:9090"` (apply it in the same
   `up -d prometheus` as the flag). Do not rely on a firewall rule such as
   `ufw deny 9091`: Docker publishes ports through its own iptables rules,
   which ufw and plain INPUT rules do not filter, so the port would stay open
   unless the rule is in the `DOCKER-USER` chain. **Remove the flag again as
   soon as the series is deleted** (the loopback binding can stay).
   - Enable: add `- --web.enable-admin-api` to the `command:` list of the
     `prometheus` service in `monitoring/docker-compose.yml` (next to
     `--web.enable-lifecycle`), then run
     `docker compose -f monitoring/docker-compose.yml up -d prometheus`. Use
     `up -d`, not `restart`: `restart` keeps the old flags. The data volume
     is kept, so the latch survives the recreate.
   - Delete (`curl` needs `-g` and `--data-urlencode` because of the `{}` and
     `"` in the selector):
     `curl -g -X POST http://127.0.0.1:9091/api/v1/admin/tsdb/delete_series --data-urlencode 'match[]=demos:conflicting_block:increase10m{instance="validator-2"}'`.
     The series name is the one in the table below for the alert. The counter
     itself is not touched, so the evidence stays in the TSDB. The alert
     clears within about a minute.
   - Remove: delete the `- --web.enable-admin-api` line again and run
     `docker compose -f monitoring/docker-compose.yml up -d prometheus`.
4. Expire the silence from step 2 once the series is deleted. Otherwise the
   7 day silence keeps running, and a repeat double-sign or fork on the same
   validator (same alert name and instance) fires with no page and no Slack
   message for days. Get the id with
   `docker exec demos-alertmanager amtool silence query alertname=ConflictingBlock instance=validator-2 --alertmanager.url=http://localhost:9093`
   (add `-q` to print only the id), then
   `docker exec demos-alertmanager amtool silence expire <id> --alertmanager.url=http://localhost:9093`.
   The id is also printed by `amtool silence add` in step 2. A silence is
   expired, not deleted: it stays visible as expired.
5. If the series is not deleted, the alert expires by itself 7 days after the
   last event; leave the silence in place until then. A second double-sign on
   that validator during those 7 days stays silenced (no page), so watch the
   node logs and the dashboard in that window.

The latch lives only in the Prometheus data. Retention must be at least 7 days
(`PROMETHEUS_RETENTION`, 15 days by default) and the Prometheus data volume
(`prometheus_data`) must persist; a shorter retention shortens the latch, and a
wiped volume loses it.

| Alert | Recorded series to delete |
|-------|---------------------------|
| BlockHashMismatch | `demos:consensus_block_hash_mismatch:increase10m` |
| ConflictingBlock | `demos:conflicting_block:increase10m` |
| ForeignSignature | `demos:foreign_signature:increase10m` |
| PrecommitEquivocation | `demos:precommit_equivocation:increase10m` |

## Validator clock

Validators run host NTP (chrony or `systemd-timesyncd`), and the node uses the
host clock as is: it never corrects its own time, so one bad time server
cannot move every validator that trusted it. The node only measures the
offset. At boot and every 10 minutes it asks four public NTP servers and takes
the median of the answers within 2 s of each other, when at least two agree.

- `demos_clock_offset_seconds`: host clock minus that median; positive means
  the host is ahead. The node logs a warning above 1 s.
- `demos_clock_probe_agreeing_servers`: servers that agreed in the last probe.
  Below 2 the offset was not updated (no outbound UDP 123, or the servers
  disagree), and the node keeps running on the host clock.

Limits: members refuse to sign a block stamped more than 5 s ahead of their
clock, and every node rejects a block more than `BLOCK_TIMESTAMP_TOLERANCE`
(60 s) in its future. With `PROD=true` a node whose host is off by more than
that tolerance, by two or more agreeing servers, refuses to start.

When `ClockOffset` fires, on the validator: `chronyc tracking` (or
`timedatectl timesync-status`) shows the source and the offset. Fix the time
service; the node needs no restart, the next probe clears the alert.

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

A Slack message and a page (the paging webhook) both arrive after the critical group wait (10 s). With `amtool`
(shipped in the Alertmanager image):

```bash
docker exec demos-alertmanager amtool check-config /etc/alertmanager/alertmanager.yml
docker exec demos-alertmanager amtool config routes test --config.file=/etc/alertmanager/alertmanager.yml severity=warning alertname=MempoolBacklog
docker exec demos-alertmanager amtool alert add RoutingTest severity=critical instance=test --alertmanager.url=http://localhost:9093
docker exec demos-alertmanager amtool silence add alertname=RoutingTest --alertmanager.url=http://localhost:9093 --comment="routing test done"
```

To check a rule itself, query Prometheus (`:9091`) for its expression, for
example `demos_consensus_abstaining`, and look at Alerts in the UI.
