# Genesis acceptance on a release image

Checks the boot rules in `docs/design/genesis-enforcement.md` against a node
image run exactly as published: its own entrypoint
(`/app/scripts/docker-entrypoint.sh`), its own user (`demos`, uid 1000) and its
own command. Nothing from the repo runs inside the node container.

```sh
testing/genesis-acceptance/run.sh --image ghcr.io/kynesyslabs/node:v1.0.0-rc.3@sha256:... --label rc3
```

Needs docker, bun (the repo's `node_modules`), python3, jq and flock on the
host. Exit codes: 0 every scenario matched, 1 at least one did not, 2 the run
could not be carried out.

## What it does

1. Waits for the shared harness lock (`../.crace.lock` next to the repo,
   `GACC_LOCK_FILE`), then refuses to start with less than 3 GB of available
   RAM, a 1-minute load above the core count, less than 10 GB of free disk or
   sustained swap-out.
2. Copies `data/genesis.json` and `data/snapshot/` out of the image
   (`docker create` + `docker cp`, the image is not run) and writes the
   fixtures with `fixtures.py`: a launch genesis (timestamp 1793318400, chain
   id 4242, `signatureDomain`, `editBinding`, `quorumParity`,
   `committeeBinding`, `commitLock` at height 0, the bundled snapshot bound by
   `snapshot.manifestSha256`) and its variants.
3. Computes the pin with `bun scripts/genesis-hash.ts --json` on the host.
4. Starts a throwaway Postgres (the image pinned in `docker-compose.yml`) and
   one node at a time on a private bridge network with no published ports. The
   node needs a route out for NTP (it exits at boot when no NTP server
   answers); its peer list is empty, so it dials no peer, and the testnet URLs
   in the bundled snapshot's validator list are only stored. The node gets a fresh
   identity in a docker volume owned by uid 1000, the genesis read-only over
   `/app/data/genesis.json`, and TLSNotary, metrics, MCP, gossip, OmniProtocol
   and L2PS messaging switched off.

| # | Scenario | Expected |
| --- | --- | --- |
| s01 | fresh-correct | boots; `getGenesisDataHash` = pin; the five forks active at 0 |
| s02 | fresh-genesis-1byte (timestamp + 1) | exit 1, no block 0 |
| s03 | fresh-no-pin | exit 1, no block 0 |
| s04 | fresh-bad-pin-format (63 hex) | exit 1, no block 0 |
| s05 | fresh-snapshot-changed (manifest + newline, `DEMOS_SNAPSHOT_DIR`) | exit 1, no block 0 |
| s06 | restart-same | boots; same block 0 |
| s07 | restart-pin-changed | exit 1, database unchanged |
| s08 | restart-fork-moved-past (`commitLock` at 1) | exit 1, database unchanged, log names `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST` |
| s09 | restart-fork-scheduled-far (`atomicWork` at 1000000) | boots; new schedule reported and stored |
| s10 | restart-unknown-fork | exit 1, database unchanged |

s06 to s10 run on the database s01 created. A copy taken after s06 is restored
before each of s07 to s10, so one result cannot leak into the next.

## Output

`<out>/<label>/summary.md` (image ref and digest, pins, the result table),
`results.tsv`, one `<scenario>.node.log` per scenario, `getNetworkInfo`
answers and the fixture genesis files. `<out>` defaults to
`testing/runs/genesis-acceptance`; `--out` or `GACC_OUT_ROOT` override it. The identity stays in the per-run temp dir, which
is deleted on exit together with every container, volume and network the run
created.

Tunables: `GACC_NODE_MEM` (2g), `GACC_PG_MEM` (512m), `GACC_NODE_CPUS` (4),
`GACC_BOOT_TIMEOUT` (600 s), `GACC_REFUSE_TIMEOUT` (300 s), `GACC_PG_IMAGE`.
