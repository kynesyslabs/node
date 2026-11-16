---
type: runbook
title: Mainnet launch validator table
date: 2026-11-05
status: active
---

# Mainnet launch validator table

Who runs each launch validator, and where. The launch coordinator keeps
the table; go/no-go reads it as a JSON file. Start from
[launch-validators.example.json](launch-validators.example.json):

```json
{
  "0x<validator identity>": { "operator": "acme", "provider": "hetzner", "region": "eu-central" }
}
```

| Column | Meaning |
|---|---|
| identity (the key) | the validator's public key, lowercase `0x` + 64 hex, as listed in the genesis or the snapshot's `validators.jsonl` |
| `operator` | the organisation that controls the host and the key |
| `provider` | the cloud or data-centre company the host runs on (`self-hosted` plus the site for own hardware) |
| `region` | the provider's region or data-centre location |

Names are compared case-insensitively and without surrounding spaces, so
`AWS` and `aws` are one provider. Use one spelling per company anyway.

## The rules

With `shardSize` 10 a block needs 7 signatures, so the chain survives 3
missing committee members and stops at the 4th.

1. `properties.shardSize` is 10.
2. At least 7 launch validators; every one has an entry with all four
   columns.
3. No operator and no provider runs more launch validators than the
   committee can lose: `min(launch validators, 10) - 7`. That is 3 with 10
   or more launch validators, 2 with 9, 1 with 8 and 0 with 7: with 9 no
   operator or provider runs more than 2, with 8 every one is at a
   different operator and provider, and 7 cannot pass at all.
4. No operator and no provider holds more than a third of the first
   committee's votes (more than 3 of 10). One validator is one vote: stake
   does not weigh votes. Rule 3 implies it at 10 to 13 validators; the
   check is kept separate so a change of rule 3 cannot loosen it.
5. No launch validator is one of the pinned committee identities.

Region is recorded so two "different" providers in one data centre are
visible; it is not capped.

## Check it

```bash
bun scripts/launch-go-no-go.ts --plan \
  --genesis mainnet/genesis.json \
  --snapshot mainnet/snapshot \
  --operators mainnet/launch-validators.json \
  --expected-treasury <agreed treasury address>
```

Each rule prints one `PASS` or `FAIL` line, followed by the counts per
operator and provider. Exit 0 when every check passes, 1 otherwise,
2 on bad input. `--json` prints the same as JSON. At T-0 the same file is
passed to the full go/no-go check (`docs/runbooks/launch-go-no-go.md`),
where a missing region is only a warning.

Before launch each operator also runs, on each host:

```bash
./scripts/node-doctor --production              # Docker host
./scripts/node-doctor --production --env-from env   # bare-metal host
```

which checks every value of the mainnet parameter sheet
([parameters.env](parameters.env), explained in [parameters.md](parameters.md):
`PROD`, `DEMOS_REQUIRE_VALIDATORS`, the `abstain` mismatch policy, block
timing, fees, stake floor and ZK points, which every validator must run with
the same values), a synchronised clock, outbound NTP, both genesis pins, and
that no one-start switch is left set. Each operator then confirms on the
launch thread that they run the published sheet: a Docker host posts the
`docker inspect` output from INSTALL.md ("Run a released image", step 10); a
bare-metal host has no container to inspect, so it posts the `node-doctor
--production --env-from env` output, run from the node checkout in the shell
that starts the node. That reads the process environment over `.env`, as the
node does, and prints each sheet value it found on its `PASS` line.

The node does not create its database schema at boot, so before its first
start each validator creates it once, with the released image (Docker host;
`SUFFIX` is the install's `INSTANCE_SUFFIX`, INSTALL.md "Run a released image",
step 3):

```bash
docker compose pull node &&
docker compose up -d --wait postgres &&
docker compose run --rm --no-deps --name "demos-migrate$SUFFIX" node bun run migration:run &&
docker compose up -d --no-build
```

A bare-metal host makes its first start `./run -c true`, which creates the
schema on the launcher's empty Postgres. A node started without the schema
stops at boot, before block 0, and names the command
(`INSTALL.md`, step 8 of "Run a released image";
`docs/runbooks/database-migrations.md`).
