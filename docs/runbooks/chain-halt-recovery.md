---
type: runbook
title: Chain halt and recovery
date: 2026-11-17
status: draft
---

# Chain halt and recovery

What validators do when mainnet stops making blocks, and the restart rule for
every planned restart or upgrade. The recovery order is fixed by the launch
decision of 2026-11-06:

1. **Tier 1:** restart the same chain (bring committee members back).
2. **Tier 2:** an emergency signed release, rolled out on the same chain. A
   fix shipped forward counts as the rollback.
3. **Tier 3:** a new genesis, only as the last resort.

At every tier, signing state is never wiped or deleted, and no key runs in
two places.

## How the quorum stops the chain

Each block has a committee of `shardSize` (10 on mainnet) validators, drawn
from the staked validators by the parent block's seed, and needs
`q = floor(2 * 10 / 3) + 1 = 7` of their signatures
([launch-go-no-go.md](launch-go-no-go.md), "The quorum in one paragraph").
With `committeeBinding` an offline member is a missing vote, never replaced,
and every retry at the same height draws the same committee. So:

- With N validators and N above 10, an offline validator matters only when
  it is drawn. Up to 3 offline members of one committee: the block is made.
  4 or more: the chain stops at that height until enough of those named
  members come back. Online validators outside that committee cannot help.
- Below the quorum nothing is forged and nothing splits. The rehearsals
  (rc.8 to rc.10 release images) halted with quorum lost and resumed on the
  same head, with the same hashes and the same supply.

## Roles

| Role | Decides | Holder | Backup |
|---|---|---|---|
| Incident coordinator | declares a halt, calls tier 1 restarts, says when the incident is over | TBD (owner) | TBD (owner) |
| Release owner | cuts and signs a tier 2 emergency release ([release-signing-key.md](release-signing-key.md)) | TBD (owner) | TBD (owner) |
| Re-genesis approver | approves tier 3 | TBD (owner) | TBD (owner) |

Operators act on their own validators only, on the coordinator's call.
Public updates follow the launch-week communication plan.

## Detect

1. **Alerts.** `HeightStalled` firing on every validator at once (no new
   block for 300 s), `NetworkHeadStalled` from the network watcher, and
   `SignerCountLow` before it
   ([mainnet-monitoring.md](mainnet-monitoring.md), "Alerts";
   `monitoring/network-watcher/README.md`). `HeightStalled` on one validator
   only is that validator's problem, not a halt.
2. **Compare heads.** Read the head and the hash at the head from several
   validators' RPCs (each operator on its own node). Every validator on one height and one
   hash means a halt; different hashes at one height means a fork
   (`ConflictingBlock`), which this runbook does not cover: stop and call the
   coordinator.

   ```bash
   RPC=http://127.0.0.1:53550
   nodecall() { curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
     -d "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"$1\",\"data\":$2}]}"; }
   nodecall getLastBlockNumber '{}' | jq .response
   nodecall getBlockByNumber '{"blockNumber":<height>}' | jq '.response | {number, hash, signers: ((.validation_data.signatures // {}) | keys)}'
   nodecall getFinalizedHead '{}' | jq '.response | {number, hash, ageSeconds, signatureCount}'
   nodecall getValidatorSet '{"blockNumber":<height>}' | jq '.response.validators | length'
   ```

   `getValidatorSet` lists the staked validators at a height. The response
   shapes are in [finality-read-api.md](finality-read-api.md).
3. **Name the missing members.** Each live validator logs, for the stuck
   height:

   ```
   [getShard] <n> of the 10 bound committee members for block <h> are live, below the quorum of 7: the block cannot be forged until more of them are online. Offline: <identity>, ...
   ```

   Those identities are the validators to bring back. Search with
   `docker compose logs node | grep 'below the quorum'`.
4. **Check each named validator's operator.** Process or container down,
   host down, a refused boot (the log names the reason), `SigningHalted`, or
   `ConsensusAbstaining` (another fork schedule:
   [fork-schedule-policy.md](fork-schedule-policy.md)).

## Tier 1: restart the same chain

1. The coordinator posts the halt height, its hash and the offline list.
2. Each named operator fixes the cause on its own host and starts the node
   with the same image, the same `.env` and the same volumes:

   ```bash
   ./scripts/node-doctor --production && docker compose start node
   ```

   For a container that is running but not voting, `docker compose restart
   node`. Use `docker compose up -d --no-build` only when the container is
   gone.
3. Expected log lines after the start: `[SIGNING] Restart signing floor:
   only rounds after <round> are signed`, then fast sync to the head, then
   consensus rounds. A refusal to prevote a round at or below the floor right
   after the start is by design.
4. Bring back several named members at the same time: the chain needs 7 of
   that committee. The order among them does not matter.
5. The chain resumes on its own once enough members are back. Check with
   the head command above: the height moves and the hash at the old head is
   unchanged.

**U-1 rule.** A just-restarted validator that logs
`[SEND OUR VALIDATOR PHASE] Timeout waiting for green light` for the same
block twice is restarted once more (`docker compose restart node`). On rc.11
such a validator could stay out of every round at that height (rehearsal: a
10 min halt on a 3-validator chain, cleared by one more restart). From
`v1.0.0-rc.13` the validator leaves a round the secretary abandoned and joins
the newer one on its own, so the rule is a fallback there.

### Timings from the rehearsals

| Event | Measured |
|---|---|
| Graceful stop of one validator | 29-46 s (rc.8); do not kill it to save time |
| Restart of one validator to healthy | 31-38 s (rc.11 upgrade), 90-118 s (rc.8/rc.9) |
| One of 3 validators down 120 s (quorum lost) | chain halted the whole time; resumed 64-66 s after it was healthy, no operator action (rc.8, rc.9) |
| All 3 validators stopped 30 s, then started | healthy 41 s after start; 2 blocks past the old head 207 s after the stop (rc.9) |
| 2 of 4 validators abstaining | halted ~13 min at one height; resumed 11-19 s after the two restarted, 20 blocks in 3 min 7 s (rc.10) |
| U-1 on a rolling restart | 10 min halt until a second restart (rc.11) |

These come from 3- and 4-validator rehearsals. A halt with 2 of 4 validators
*stopped*, and halts with a committee of 10, are not yet drilled on the
launch image.

## Tier 2: emergency signed release

When the same chain cannot resume on the running release (a bug stops every
committee member, or a block cannot be saved):

1. The release owner cuts a signed release from the fix
   ([release.md](release.md), [release-signing-key.md](release-signing-key.md)).
   A block that cannot be saved is never wiped: the fix must save the same
   block.
2. Operators upgrade as in [release.md](release.md), "What a validator
   runs", one validator at a time (rule below). While the chain is halted,
   the check after each upgrade is that the node is healthy and at the halt
   height; the chain resumes once 7 members of the stuck committee run the
   fix.
3. After the chain moves, every validator runs the fix, and the release
   thread carries each running digest.

## Tier 3: new genesis

Only with the re-genesis approver's sign-off. A new genesis is a new chain:
new published hashes, the 24 h rule
([genesis-hash.md](../mainnet/genesis-hash.md)), and every operator follows
INSTALL.md, "After the genesis is reissued".

## Restart and upgrade rule (all tiers, and every planned restart)

- Restart or upgrade **one validator at a time**, whatever N is.
- Before the next validator, wait until the restarted one is back in the
  committee: healthy, at the network head, and signing blocks (check below).
- Apply the U-1 rule above when it logs the green-light timeout twice for
  one block.

**Check that a validator signs blocks.** With N validators and a committee
of 10, a validator is drawn for about 10 in N blocks, so look at the last 30
blocks. Run on the validator's host; `ID` is its identity (`/info` →
`identity`):

```bash
RPC=http://127.0.0.1:53550
ID=$(curl -s "$RPC/info" | jq -r .identity)
head=$(curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
  -d '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{}}]}' | jq -r .response)
for n in $(seq $((head - 29)) "$head"); do
  curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getBlockByNumber\",\"data\":{\"blockNumber\":$n}}]}" |
    jq -r --arg id "$ID" --arg n "$n" 'select((.response.validation_data.signatures // {}) | has($id)) | "signed \($n)"'
done
```

At least one `signed <height>` line after the restart time means it is back.
With commit lock a late precommit is not always in the stored certificate,
so if no line appears, wait another 30 blocks before calling it out. The
network watcher's `demos_watch_validator_last_signed_height` shows the same
from the monitoring host.

## Do not

- Do not run `docker compose down -v`, or remove the state volume, outside
  tier 3. It deletes the key copy and its signing state.
- Do not delete or edit `<identity file>.signed.json`, `.prevote.json`,
  `.commitlock.json` or `.signed.json.halted` ([validator-key.md](validator-key.md)).
- Do not start a second copy of a key, on another host or "to test".
- Do not set `BLOCK_WATCHDOG_ENABLED`: in a network-wide stall it stops every
  validator at once ([mainnet-monitoring.md](mainnet-monitoring.md), "Block
  watchdog stays off").
- Do not edit the genesis file, `shardSize` or a fork height on one validator.
- Do not set `DEMOS_SIGNING_RECORD_REBIND`, `DEMOS_IDENTITY_TAKEOVER` or
  `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST` without the coordinator's call, and
  remove them after the one start that needs them.
- Do not restart validators that are signing in the hope of speeding up a
  halt: every restart sits out rounds.
