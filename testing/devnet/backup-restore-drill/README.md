# Backup / wipe / restore drill

Timed backup, wipe and restore of one validator on a throwaway 4-node devnet
(mainnet-launch #16, G16-b). Follows the conventions of `../quorum-drills/`
(prebuilt image, generated compose file, per-run dir, auto-teardown) and reuses
its `gen-inputs.py` for genesis and peerlist.

```
# startup check first (minutes): 4 nodes up, RPC served, head >= 2, then teardown
NODE_IMAGE=<local image> BASE_PORT=65000 SMOKE=1 testing/devnet/backup-restore-drill/run.sh

NODE_IMAGE=<local image> BASE_PORT=65000 testing/devnet/backup-restore-drill/run.sh
NODE_IMAGE=<local image> BASE_PORT=65000 VARIANT=isolated testing/devnet/backup-restore-drill/run.sh
```

Before anything timed starts the script checks that:

- gossip is on for every node. It is by default; `GOSSIP_ENABLED=false` is
  refused unless `ALLOW_GOSSIP_OFF=1` (a validator with gossip off never
  catches up after a restart, so the timings would mean nothing);
- the image user (uid 1000) can read the inputs, and can write each read-write
  volume and tmpfs of the node services and the image directories it probes (an
  INFO row lists them; a path not listed was not probed). A root-owned volume
  stops the run with a message; `FIX_OWNERSHIP=1` chowns `1000:1000` only this
  drill's own volumes instead.

Everything else (environment, phases, checks, caveats):
[`docs/runbooks/backup-restore-drill.md`](../../../docs/runbooks/backup-restore-drill.md).

`test/run-fake-tests.sh` runs the script against a fake `docker`, no Docker
needed.

Run dirs under `runs/` hold devnet keys and logs and are gitignored.
