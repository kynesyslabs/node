---
type: runbook
title: Fork Schedule Policy
date: 2026-10-22
status: active
---

# Fork Schedule Policy

Fork activation heights live in each node's `genesis.json` and are not part of
what peers compare when they pair. A validator that missed a genesis edit pairs
with everyone and then splits from them at the activation height. The node
therefore re-compares its schedule with its peers while it runs.

## The rule

Inside the 50 blocks before the nearest scheduled fork, a node abstains from
consensus when it is the odd one out: a strict majority of the validators that
answered report a different schedule from its own. It does not forge and does
not vote. It keeps syncing blocks from its peers, so it can rejoin.

- Only staked validators are compared. A non-validator peer's answer is ignored,
  so extra connections cannot sway the count. On a bare dev network with no
  staked set, every peer counts.
- The comparison runs every 100 blocks, and every 10 blocks inside the window.
- A node that starts, or restarts, with the tip already inside the window
  compares before its first consensus round and waits for the answer (at most a
  few seconds), so it does not forge on an unchecked schedule. A comparison that
  reaches no validator is retried on the next round and does not hold the node
  back.
- A minority of differing validators never makes the node abstain. It is logged
  and shown by `demos_fork_schedule_mismatch`, and the alert `ForkScheduleMismatch`
  fires, but the node keeps taking part: it is the one with the schedule most of
  its peers share.
- When the majority differs inside the window, the node logs one
  `[FORK SCHEDULE] Abstaining` error naming the differing validators and the
  nearest scheduled height, sets `demos_consensus_abstaining` to 1, and every
  consensus round then ends early with a `[consensusRoutine] Abstaining` line,
  logged at most once a minute.
- While abstaining, the comparison is repeated every 30 seconds, so the node
  does not depend on new blocks to notice that the situation has changed.
- The flag clears (gauge back to 0) when a comparison finds that no majority
  differs, wherever the tip is: after the operator fixed `genesis.json` and
  restarted, or after the fork activated and the schedules agree again. Once the
  tip is past the nearest scheduled height the window is over, so from then on
  the node stays out only while most validators still disagree with it. A
  comparison that reaches no validator changes nothing.
- Outside the window the node only logs a warning and raises
  `demos_fork_schedule_mismatch`; it never newly abstains.

`FORK_SCHEDULE_MISMATCH_POLICY` selects the behaviour: `abstain` (default) or
`warn`, which keeps the old log-only behaviour. Any other value stops the node
at startup.

## Limits

- A node on the right schedule abstains if most validators carry the wrong one.
  Before acting on an alert, confirm the node's own `genesis.json` against the
  hash published with the release. If it matches, the node is on the right side
  and the other validators need the fix.
- The window is measured from the node's own schedule. A node that is missing a
  fork its peers have has no scheduled height ahead and never enters the
  window, so it is reported by `ForkScheduleMismatch` but does not abstain.
  The release sequence below exists to prevent this case.

## Changing the schedule

A fork schedule is only edited outside the window, and only by shipping a new
signed release. A hand edit of `genesis.json` on a live validator is not allowed.

1. Publish the new genesis, with its hash, in a signed release.
2. Every validator updates and restarts on it before the window opens, that is,
   more than 50 blocks before the nearest scheduled height.
3. Watch `demos_fork_schedule_mismatch` and `ConsensusAbstaining` on all
   validators. Agreement shows as 0 everywhere; the window opening on an
   unresolved mismatch means abstention.

## Launch stance (proposed decision)

After launch, future forks stay in each node's `genesis.json` and are delivered
by signed release as above, until an on-chain schedule exists. There is no
runtime way to change the schedule, which keeps this policy simple: the schedule
a node holds is the schedule its release shipped with.
