# Same-height commit race harness

Reproduces, on a local 4-validator devnet, the fork where one member commits
block X at height H while the others' tallies fail, retry H and certify a
second block Y with the same signers. It runs the stack, injects the fault
at a chosen height, and decides pass/fail by itself.

```
testing/devnet/consensus-race/run.sh [--image IMAGE] [--src TREE] <control|race|race-strict> [label]
```

- `--image` (or `IMAGE`): a prebuilt node image. Default
  `demos-node:candidate-5979a716`. The harness never builds images.
- `--src` (or `SRC_TREE`): a source tree whose `src/` is bind-mounted
  read-only over the image's `/app/src`, to test code without a rebuild. The
  tree must match the image's dependencies (same `package.json` deps).
- `label`: free text (`[A-Za-z0-9_-]`) that ends up in the run dir name.

Exit code 0 means pass (or, for `race-strict`, a fork that was detected),
1 means fail, 2 means the run could not be carried out (preflight, boot,
timing). Each run appends a row to `runs/results.tsv`.

## What it does

1. Preflight: aborts when free disk is under 10 GB, available RAM under
   4 GB, the 1-minute load above 32, the host is swapping, or an image is
   missing (`MIN_DISK_GB`, `MIN_RAM_MB`, `MAX_LOAD` override the limits).
2. Inputs: four fresh identities, the devnet genesis with `shardSize` 4 (so
   quorum is 3), those four as validators and a timestamp `GENESIS_DELAY`
   (120 s) in the future, and a peerlist that seeds only node-1. Block 1
   cannot be forged before genesis time + `CONSENSUS_TIME`, so the chain
   waits for all four nodes: a node that joins after the first blocks may
   never learn the others' height on code that drops sync data above its
   head, and would sit at genesis.
3. Bring-up: postgres, then the nodes one at a time, each waited on until it
   serves.
4. Lockstep: waits until all four hold the same head with the same hash.
5. Fault at a target height H (head + 2), from netshoot sidecars that share
   each node's network namespace (`--network container:<node>`,
   `NET_ADMIN`), using `iptables -m string` on the plain-JSON HTTP traffic
   (`OMNI_MODE=HTTP_ONLY`). The round start is the `SECRETARY:` line that
   follows `We are forging block H` in any node's log; A is never the
   secretary of H.
   - **control**: once every node holds H-1, outgoing `proposeBlockHash`
     is dropped on every node except A (a guess: not the secretary of H-1).
     If round H names A as its secretary, the rule moves at round start,
     before anyone proposes. A's proposal gathers 4 votes and A commits X;
     the others' proposals fail.
   - **race**: once every node holds H-1, `proposeBlockHash` is dropped on
     all four, and lifted on A only when round H starts. Same outcome, but
     A's release races the round.
   - **race-strict**: as race, and before its release A also stops
     announcing and serving its blocks: outgoing `syncNewBlock` and
     `updateSyncData` and incoming `getBlocks` are dropped until the other
     three hold H, then lifted. This is a committer that becomes unreachable
     for block data between its insert and its push.

   In every mode a member other than A gets its proposals back once its
   own first vote tally at H is in and A holds H, so its retry of the height
   runs against a committed block, as in the incident. Rules carry a
   `crace-` comment and are all removed at the end of the fault window.
6. Settle: waits until three nodes are `SETTLE_BLOCKS` (3) past H, then a
   `DETECT_WINDOW` (60 s) for the height probes to run.
7. Verdict: the hash every node holds at H, the `[FORK]` log lines and the
   `demos_conflicting_block_total` metric (from `:9090/metrics` inside each
   container; `n/a` on code without the metric).
   - control / race: **PASS** when all four hold one block at H.
   - race-strict: **PASS** when all four hold one block at H;
     **FORK-DETECTED** when they diverge and at least one node logged
     `[FORK]` and counted the metric; **FAIL** otherwise.

## Runs and logs

Everything goes to `runs/<UTC time>-<mode>-<label>/` (gitignored, mode 700):
`inputs/` (identities, genesis, peerlist: devnet keys, never commit them),
`logs/01-preflight.log` .. `07-verdict.log` per step, `05-fault.log` with a
timestamped line per rule change and tally, `node-N.log` (full container
logs, collected at teardown), `verdict.json`, and `run.log` with the whole
run. `runs/results.tsv` collects one row per run.

## Isolation on a shared host

The compose project is unique per run (`crace-<run id>`), there are no
`container_name`s, no published ports (the harness uses `docker exec`), and
postgres and the nodes' state dirs are on tmpfs: no named volumes. Memory
caps: 2 GB per node (`NODE_MEM`), 1 GB postgres, 64 MB per sidecar. A trap
collects logs, removes the sidecars and runs `docker compose down -v` on any
exit, including Ctrl-C. Only containers the run started are touched.

## Tuning

`CONSENSUS_TIME` (10), `GENESIS_DELAY` (120), `LOCKSTEP_TIMEOUT` (300), `ROUND_TIMEOUT` (90),
`FAULT_MAX` (150, cap on how long any rule stays), `SETTLE_BLOCKS` (3),
`SETTLE_TIMEOUT` (180), `DETECT_WINDOW` (60), `NETSHOOT_IMAGE`, `RUNS_DIR`.

## Notes

- Gossip is off (`GOSSIP_ENABLED=false`): its sidecar cannot start in the
  Bun-only image. Without gossip a node that falls behind relies on block
  pushes, sync data and the height probe.
- `LOG_LEVEL` stays `info`, which prints every level (`debug` would print
  debug lines only): the round-start and secretary lines that time the
  fault are debug lines, the vote tally is an info line.
- On code without the same-height fix, control ends in a fork: A holds X
  at H and stays there (`Committee of 1 is below the floor`), the other
  three certify Y with 3 votes and move on. Depending on timing the same
  code can instead stall with A alone at H; both are a FAIL.
- Without the commit lock, race-strict ends in FORK-DETECTED: when nobody
  can fetch the committed block from its only holder, the others still
  certify a second one. With `commitLock` active (the devnet genesis
  activates it at 0) the others are locked on the block A committed and
  certify that same block in their retry, so race-strict is expected to
  PASS.
