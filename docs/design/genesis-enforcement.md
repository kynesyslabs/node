# Genesis and fork-schedule enforcement at boot

A validator must not take part in consensus with the wrong genesis or the wrong
fork schedule. Today a node checks its genesis only against peers, after block 0
is already in its database, and never checks the schedule it loads at a restart
against the one it ran with. This document fixes the rules a node applies to
itself at boot, before it signs anything.

## What is wrong today

| Case | Today |
| --- | --- |
| Fresh database, wrong `data/genesis.json`, `EXPECTED_GENESIS_HASH` set | Block 0 is written from the file first. The pin is compared only during peer bootstrap, and only when an anchor answers. After a refusal block 0 stays, and the next boot trusts it over the pin. |
| Restart with an existing database | `findGenesisBlock` returns as soon as block 0 exists. Neither the pin nor the file is compared with it. |
| Fork schedule edited between restarts | The schedule is re-read from the file at every boot. An edit at a height the chain has passed, or is about to pass, is loaded silently. The 50-block watch only looks at heights above the tip. |
| Unknown fork name in genesis | Logged and ignored, so an old binary runs without a fork the file schedules. |
| Snapshot | Not covered by any hash. The snapshot's `validators.jsonl` replaces the genesis validator list, so the founding validator set is unbound. A missing snapshot directory falls back to `balances` without an error. |
| `EXPECTED_GENESIS_HASH` format | Only lowercased. A leading `0x`, a trailing newline or a short value never matches and gives a confusing error. |
| Exit code | A refusal at boot exits 0, so a supervisor treats it as a clean stop. |
| Production without a pin | Allowed. |

## The launch hash

There is one value an operator pins and publishes: the **genesis data hash**,
`hashGenesisData(genesisData)` from `normalizeGenesisForHash.ts`. It is the hash
peers already advertise through `getGenesisDataHash` and the value
`EXPECTED_GENESIS_HASH` holds. It covers every field of the genesis data except
the validators' `connection_url`, including `forks` and `properties.id`.

The snapshot is bound through a new genesis field:

```json
"snapshot": { "manifestSha256": "<sha256 of the raw bytes of manifest.json>" }
```

The manifest already carries a sha256 for every snapshot file and `loadSnapshot`
verifies them, so the manifest hash binds the whole snapshot. Because the field
sits in the genesis data, the genesis data hash covers it, and so does the block
0 hash. `scripts/launch-go-no-go.ts` and the genesis tooling print the value.

## Pinned mode

A node is in pinned mode when `EXPECTED_GENESIS_HASH` is set. The value is
trimmed, a leading `0x` is removed, and it is lowercased; anything that is then
not 64 hex characters stops the boot.

With `NODE_ENV=production`, a node without a pin refuses to start unless
`DEMOS_ALLOW_UNPINNED_GENESIS=true` is set. The release image sets
`NODE_ENV=production`, so every production install either pins its genesis or
opts out explicitly. Testnet installs that predate the pin set the opt-out once; the devnet compose
overlay sets it.

### Fresh database (no block 0)

All checks run before anything is written to the database.

1. `hashGenesisData(file) == pin`.
2. `RESTORE` is off: a recovery overlay would change the data after the check.
3. The file has a `timestamp`: without one, block 0 takes the wall clock and
   every node creates a different block 0.
4. If the file declares `snapshot.manifestSha256`, the snapshot directory exists
   and the raw manifest hashes to it. If the file declares none, no snapshot may
   be present: it would be loaded without being bound by the pin.

### Restart (block 0 exists)

1. The genesis data stored in block 0 hashes to the pin.
2. The file and the stored data agree on everything except the fork schedule
   (`hashGenesisCore`), and on `properties.id`.
3. The fork schedule rules below.

### Both modes

These hold with or without a pin:

- If the file declares `snapshot.manifestSha256`, the snapshot must match it on
  a fresh database.
- A chain id in the file that differs from the one in block 0 stops the boot.
- A refusal exits with code 1, and nothing is written to the database.

## Fork schedule rules

The node keeps the last schedule it accepted in a new table,
`accepted_fork_schedule` (one row): the scheduled forks with their consensus
payloads, the chain id, the digest (`forkScheduleDigest`) and the tip at
acceptance. On a fresh database the row is written right after block 0, from the
schedule block 0 carries.

At every boot, once block 0 and the tip are known:

1. A fork name the binary does not know stops the boot when the file schedules
   it (`activationHeight` not null). An unscheduled unknown fork is still only
   logged: it changes nothing, and it lets an older binary read a newer file.
2. With no stored row (a chain created before this rule), the loaded schedule is
   accepted and stored.
3. Otherwise each fork whose height or payload differs from the stored row is
   checked. The change is allowed only if both the old height and the new height
   are null or above `tip + 50` (`WINDOW_BLOCKS`, the window the schedule watch
   already uses). A change at or below that line, including a payload change of
   a fork that is already active, stops the boot. The chain id enters consensus
   only through `signatureDomain`, so it may change (a chain that started
   without one adds it together with that fork) only while `signatureDomain`
   lies beyond the line in both versions.
4. An allowed change is stored as the new accepted schedule.

An operator who must change the schedule inside the window, for example to undo
an activation everyone agrees was wrong, sets `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST`
to the digest of the new schedule. The node prints that digest when it refuses,
so the override names one exact schedule and cannot carry a later typo.

The run-time watch from the fork-schedule policy (abstain when the schedule
differs from a strict majority of peers) is unchanged. The boot rules stop a
single node from loading a bad edit; the watch handles a node whose valid
schedule disagrees with the network's.

## Delivery on mainnet

- The genesis file is mounted read-only over `/app/data/genesis.json`. The
  image's bundled `data/genesis.json` is the testnet one and must never be used.
- `EXPECTED_GENESIS_HASH` comes from the environment; the compose file passes it
  through.
- The snapshot is mounted read-only and pointed to with `DEMOS_SNAPSHOT_DIR`.
- The go/no-go check probes every validator for its genesis data hash and fork
  schedule digest and refuses when any of them differs from the launch genesis.

## Acceptance on the release image

`testing/genesis-acceptance/run.sh --image <ref@digest>` runs the published image
as it is (its own entrypoint and user) and checks:

| Scenario | Expected |
| --- | --- |
| Fresh database, correct genesis and pin | Boots; the five mainnet forks report activation height 0. |
| Fresh database, genesis one byte off | Exit 1; block 0 not written. |
| Fresh database, no pin, production | Exit 1. |
| Fresh database, malformed pin | Exit 1. |
| Fresh database, snapshot manifest changed | Exit 1. |
| Restart, same files | Boots; same block 0. |
| Restart, pin changed | Exit 1. |
| Restart, fork moved to a past height | Exit 1. |
| Restart, fork moved beyond the window | Boots; the new schedule is stored. |
| Restart, unknown scheduled fork | Exit 1. |

## Known limits

- A validator that joins after a schedule edit must create block 0 from the
  launch file, then apply the edit, because block 0 commits to the schedule it
  was created with. Until the schedule moves on chain, the runbook covers this.
- The stored block 0 is trusted to be the one the node wrote. Someone with write
  access to the database can change both block 0 and the accepted schedule.
