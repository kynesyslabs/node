# Validator database backups

Decided 2026-11-27 (mainnet-launch#16). Applies to every mainnet validator.

## What a backup is for

Every block and every account is on every validator, so the chain does not
depend on any one database. The first recovery for a lost or broken database
is a resync from peers: an empty database on the same release, the node
started as usual (`docs/runbooks/backup-restore-drill.md` has the measured
timings). A dump is the faster path back for one validator and the fallback
when too few peers are reachable to resync from.

A dump never holds the validator's key or its signing state: those live in
the state volume and are backed up separately, key and signing records as one
copy taken while the node is stopped (`INSTALL.md`, Track 1 backup step;
`docs/runbooks/validator-key.md`, "Signing state files").

## Policy

| What | Rule |
|---|---|
| Cadence | One dump a day, and one right before every release upgrade, which runs `bun run migration:run` |
| Format | `pg_dump -Fc` of the node database, the format the restore drill proved |
| Where | Off the validator host, encrypted before it leaves the host |
| Retention | 7 daily dumps plus the dump taken before the last upgrade |
| Holder | Each operator holds their own dumps; the launch coordinator keeps the list of operators who confirmed the cadence |
| Check | Once a month, restore the latest dump into an empty database on another host and confirm the node starts on it |

Take a dump on a compose install:

```bash
docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' \
  > "demos-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Restore follows `docs/runbooks/backup-restore-drill.md` ("What it does"): an
empty database, `pg_restore --no-owner`, then `bun run migration:run` with
the running release before the node starts.

## Alerts

- `DbDown`: the node cannot reach its database.
- `DiskSpaceLow` (under 20 GiB free) and `DiskSpaceCritical` (under 5 GiB):
  the node's data volume is filling up
  (`monitoring/prometheus/alerts/node-health.yml`). They watch
  `DISK_SPACE_PATH`, not Postgres: when the database lives on another disk
  or host, watch that disk separately (`node_filesystem_avail_bytes`,
  `docs/runbooks/mainnet-monitoring.md`).
- Below `MIN_DISK_SPACE` (5 GiB by default) the node refuses to start, so
  `DiskSpaceCritical` means it will not come back after a restart or an
  upgrade. Free space before restarting it.
