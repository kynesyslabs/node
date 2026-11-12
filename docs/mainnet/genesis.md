---
type: runbook
title: Mainnet genesis file
date: 2026-11-05
status: active
---

# Mainnet genesis file

`docs/mainnet/genesis.template.json` is the mainnet genesis with every
value the code fixes already set and every owner decision left as a
`FILL: ...` string. A node refuses to boot on a file that still holds a
`FILL` value in the chain id, a fork height, `sudoPubkey` or `balances`
(and, with the genesis pinned, the timestamp), before it writes block 0.
The plan check below reports each of them, so an unfilled template can
never boot by accident.

The template sets no identity, no chain id and no allocation. Those are
decided by the genesis owners and filled in once.

## What is already fixed

| Field | Value | Why |
|---|---|---|
| `properties.shardSize` | `10` | the launch committee: quorum 7, at most 3 seats lost |
| `mutables.minBlocksForValidationOnlineStatus` | `4` | same as testnet |
| `forks.osDenomination`, `nonceEnforcement`, `signatureDomain`, `editBinding`, `nonceIntegrity`, `quorumParity`, `committeeBinding`, `commitLock`, `finalityProofs`, `identityCarryover`, `stakeApplyChecks`, `txTypeAllowList`, `instantMessagingBinding`, `nativeSendBinding`, `canonicalAddresses`, `feeBinding`, `blockCaps`, `unpinnedCommittee`, `telegramSenderBinding`, `xmRemoveCanonical`, `tokenStakingGate`, `web2ProofBinding`, `tlsnProofEnforcement` | `activationHeight: 0` | mainnet starts with every safety fork on; `web2ProofBinding` takes only web2 proofs that sign the bound message (SDK ≥ 4.0.20 `createWeb2ProofPayload` with a claim), and `tlsnProofEnforcement` refuses every TLSN identity claim until the node verifies the notary signature itself; at height 0 block 0 records `osDenomination` as applied for a snapshot that is already in OS units, and a node refuses such a snapshot under any other height. `identityCarryover` makes block 0 import user data without balances and refuse any other snapshot ([genesis-import.md](genesis-import.md)) |
| `forks.xmProofBinding`, `forks.atomicWork`, `forks.canonicalSigners` | `activationHeight: null` | not scheduled at launch; a later activation is a coordinated schedule change |
| `forks.networkGovernance` | `activationHeight: null` | network-upgrade proposals and votes are refused at launch; go/no-go is NO-GO on a genesis that schedules it. Turning governance on is a later, height-pinned schedule change |
| `forks.tokenStakingGate` | `activationHeight: 0` | token staking is off at launch: the validators are the ones in `validators`, and a `validatorStake` or `validatorUnstake` transaction is refused at intake and at apply with "token staking is not enabled on this network (fork tokenStaking)". A node whose build does not know the fork refuses to boot on this genesis |
| `forks.tokenStaking` | `activationHeight: null` | token staking opens by network upgrade. Opening it is a later, height-pinned schedule change: with `tokenStaking` at H, stakes and unstakes are taken in and applied from block H + 1 under the `stakeApplyChecks` rules. The change ships as a signed release that sets only `tokenStaking` and leaves every active fork at 0 ([fork-schedule-policy.md, Changing the schedule](../runbooks/fork-schedule-policy.md#changing-the-schedule)); go/no-go is NO-GO on a genesis that schedules it |
| `forks.gasFeeSeparation` | `activationHeight: 0`, with the treasury the owners fill | a native transaction pays the fee its `transaction_fee` names, split between the burn and treasury accounts (the rpc share goes to treasury while no operator is named), and with `feeBinding` that fee is all it pays: no flat gas on top, so transfers keep the total supply. Without the fork the fee is a flat 1 DEM per transaction that no account receives |
| `status` | `"confirmed"` | as on testnet |

This list matches `MAINNET_FORKS` in `scripts/launch-go-no-go.ts` and the
genesis acceptance harness (`testing/genesis-acceptance/`); a test keeps
them equal.

## What the owners fill

| Field | Fill with |
|---|---|
| `properties.id` | the mainnet chain id, an integer. go/no-go and the plan check refuse testnet `1` and devnet `1337`: every signature binds to the chain id, so a reused id lets a testnet transaction replay on mainnet |
| `properties.name`, `properties.currency` | network name and currency symbol |
| `properties.sudoPubkey` | the lowercase `0x` + 64 hex key that may sign award transactions, or delete the field to accept none |
| `forks.gasFeeSeparation.treasuryAddress` | the mainnet treasury account. The node refuses the entry without it and refuses the zero address, and block 0 creates the burn and treasury accounts |
| `snapshot.manifestSha256` | `sha256sum` of the launch snapshot's `manifest.json`. Keep the field: the launch tools model block 0 on the snapshot path, and the plan check and the height-1 check both require the snapshot |
| `balances` | the agreed allocations, `[["0x<64 hex address>", "<amount>"], ...]`, each address lowercase. An entry replaces the balance an address has in the snapshot, it is not added to it, so write the whole balance the account starts with, never a top-up. The amount is in the snapshot's unit: these balances are written over the snapshot before block 0 applies `osDenomination`. Over a DEM snapshot (its manifest's `fork_state` has no applied `osDenomination`) enter DEM, and block 0 multiplies it by 10^9 with every other balance; over a snapshot already in OS units enter OS (1 DEM = 10^9 OS) |
| `timestamp` | the launch time in seconds as a positive integer string. Block 0 is built from it, so the block 0 hash is known only once it is fixed |
| `validators` | the launch validators, one object each: `address`, `status` `"2"`, `connection_url`, `staked_amount`, `first_seen` `0`, `valid_at` `0`. `staked_amount` is in OS units (1 DEM = 10^9 OS): the node seeds this list after block 0 applies `osDenomination` and stores each stake as written. When the snapshot carries `validators.jsonl`, the node seeds from that file instead. Under `identityCarryover` the launch snapshot is built from this list (`bun run snapshot:carryover --validators mainnet/genesis.json`), and block 0 refuses a snapshot whose `validators.jsonl` differs from it |

### Forks this build does not know yet

The template declares exactly the forks this build knows, and go/no-go
refuses a genesis that leaves one out (an undeclared fork takes the code
default, which nobody reviewed for mainnet). A fork that only a later
release knows is added to the template when
that release is the launch release: a node refuses to boot on a genesis
that schedules a fork it does not know, so the genesis and the release
must agree. The test in `scripts/launch-go-no-go.plan.test.ts` fails as
soon as the release knows a fork the template does not declare.

## Check the filled file

Before any validator is up, run the plan check on the filled genesis, the
launch snapshot and the validator table
([launch-validators.md](launch-validators.md)):

```bash
bun scripts/launch-go-no-go.ts --plan \
  --genesis mainnet/genesis.json \
  --snapshot mainnet/snapshot \
  --operators mainnet/launch-validators.json
```

It prints one `PASS` or `FAIL` line per check (genesis forks, chain id,
shard size, genesis values (no template `FILL` left), whether a node
would load the file, block 0 validator set,
launch validators against the quorum, the validator table, the operator
and provider cap, voting power per operator and provider, pinned
identities) and exits 0 only when all pass.

Then print the values to publish:

```bash
bun scripts/genesis-hash.ts --genesis mainnet/genesis.json --snapshot mainnet/snapshot
sha256sum mainnet/genesis.json
```

It must exit 0 and print no `problem:` line. Besides the hashes, it reports
what a validator would hit on this file, and the same checks fail
`node-doctor --production` on the validators' hosts:

- `properties.shardSize` outside 3-100: the node refuses the genesis at boot;
- fewer validators active at block 0 (status `"2"` and `valid_at` 0) than
  the quorum of `shardSize`, 2/3 + 1, in the set block 0 seeds (the
  snapshot's `validators.jsonl` when it has one, otherwise `validators`):
  the node boots but no block after block 0 can be forged;
- a validator `connection_url` in that set that is not an http(s) URL with a
  host (and, if it names a port, one in 1-65535). Each one is exactly the
  `EXPOSED_URL` that operator runs with, port included; peers dial it.
  A validator without a URL is not reported, because the node accepts it:
  `null` in either list, and a missing or empty URL in a `validators.jsonl`
  row (a genesis `validators` entry without one is refused at boot). Before
  publishing, check separately that every launch validator has a URL.

What each value covers, how they are published, the 24 h rule and the
height-1 check after launch are in [genesis-hash.md](genesis-hash.md).

## After publication

The published file is never edited, by its owners or by an operator.
A changed validator URL, a different key order or reformatting builds a
different block 0, and a node on that file cannot join. Operators mount the
file and snapshot read-only (see `INSTALL.md`, "Joining the network —
required steps before real-world use"); a bare-metal node points
`DEMOS_GENESIS_FILE` and `DEMOS_SNAPSHOT_DIR` at them.
Any change is a new genesis with new published values, under the 24 h rule.
