# Backup / wipe / restore drill

Timed backup, wipe and restore of one validator on a throwaway 4-node devnet
(mainnet-launch #16, G16-b). Follows the conventions of `../quorum-drills/`
(prebuilt image, generated compose file, per-run dir, auto-teardown) and reuses
its `gen-inputs.py` for genesis and peerlist.

```
NODE_IMAGE=<local image> BASE_PORT=65000 testing/devnet/backup-restore-drill/run.sh
NODE_IMAGE=<local image> BASE_PORT=65000 VARIANT=isolated testing/devnet/backup-restore-drill/run.sh
```

Everything else (environment, phases, checks, caveats):
[`docs/runbooks/backup-restore-drill.md`](../../../docs/runbooks/backup-restore-drill.md).

Run dirs under `runs/` hold devnet keys and logs and are gitignored.
