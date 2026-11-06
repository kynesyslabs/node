---
type: runbook
title: Launch Go/No-Go and Validator Signing Proofs
date: 2026-10-28
status: proposed
---

# Launch Go/No-Go and Validator Signing Proofs

How launch day decides whether the chain starts, and the two tools behind
that decision. The rule below is **proposed** and becomes binding only once
it is approved for the launch; until then treat it as the working draft.

## The quorum in one paragraph

A block needs `q = floor(2 * shardSize / 3) + 1` signatures
(`src/libs/consensus/v2/quorum.ts`). With `committeeBinding` active (from
block 0 on mainnet) the committee for each block is fixed by chain data:
the eligible pool ranked under the parent's seed, cut to `shardSize`. An
offline committee member is a missing vote, never replaced. With
`shardSize` 10, `q` is 7: up to 3 committee members can be down and the
chain still makes blocks; a 4th stops it until one comes back.

## The go/no-go rule (proposed)

1. **T-24h:** every launch validator posts its identity, the image digest
   it will run, and a signing proof (below) for the agreed genesis block
   hash.
2. **Operator and provider cap:** no single operator and no single cloud
   provider runs more than `min(launch validators, shardSize) − q` launch
   validators: at most 3 with `shardSize` 10 and 10 or more validators, 2
   with 9, 1 with 8 and none with 7. Those are the
   committee seats the chain can lose and still sign; one party holding
   more can stop it alone. Names are compared case-insensitively and
   without surrounding spaces, so `AWS` and `aws` are one provider.
3. **T-0:** GO when at least 7 members of the first committee (block 1's
   bound committee; `q` of `shardSize` 10) are online on the agreed genesis
   block and release commit, each proven to hold its identity key, and the
   cap holds. Online validators outside that committee do not count toward
   it. Otherwise NO-GO, and retry at the next agreed slot.
4. A validator counts only after it has made a signed block on the
   rehearsal network from its production host, key and image. Its first
   start there and at launch follows `INSTALL.md` step 5, which runs
   `bun run migration:run` with the released image before `up`: the node
   does not create its schema at boot and refuses to start while a
   migration is pending.
5. Mainnet validators run with `DEMOS_REQUIRE_VALIDATORS=true`. Under
   docker compose it goes in `.env`; the shipped `docker-compose.yml`
   passes it to the node container.

6. Before T-0 no operator or provider holds more than a third of the first
   committee's votes (one validator, one vote), and every launch validator's
   region is recorded. `--plan` (below) checks this with the cap.

Exit 0 from `scripts/launch-go-no-go.ts` is the T-0 check of rules 2, 3 and
the one-third part of rule 6 (a missing region is only a warning there), plus
the genesis checks below. It does not check rules 1, 4 and 5:
people check those, with `scripts/validator-prove-signing.ts --verify
--require-all` for the rule 1 proofs and the rehearsal network for rule 4.

## The agreed genesis block hash

Every `--genesis-hash` in this runbook is the hash of block 0, the value a
node serves at `/genesisBlock` and pins with `EXPECTED_GENESIS_BLOCK_HASH`.
It is known before T-0: block 0 is built from the genesis file alone (its
fixed `timestamp`, its exact JSON with keys in file order, and the fork
schedule it declares), with no database, clock or snapshot input. Print it
from the published genesis file:

```bash
bun scripts/genesis-hash.ts --genesis mainnet/genesis.json --snapshot mainnet/snapshot
```

Use the line labelled `genesis block hash`. The `genesis data hash` on the
next line is what `EXPECTED_GENESIS_HASH` pins and what
`getGenesisDataHash` reports; it is never a `--genesis-hash` value, and
passing it would show every validator on another genesis. The tool prints
no block hash for a genesis without a fixed positive integer `timestamp`,
since each node would then stamp block 0 with its own clock.

## Plan check (before any validator is up)

The genesis rules and the validator table can be checked as soon as the
genesis file, the snapshot and the table exist, with no node running:

```bash
bun scripts/launch-go-no-go.ts --plan \
  --genesis mainnet/genesis.json --snapshot mainnet/snapshot \
  --operators mainnet/launch-validators.json [--json]
```

One `PASS`/`FAIL` line per check: genesis forks, chain id, shard size,
genesis values (no template `FILL` left), genesis file (a node would load it), block 0 validator set, launch
validators against the quorum, validator table (an entry with operator,
provider and region for each), operator and provider cap, voting power per
operator and provider, pinned identities. Exit 0 when all pass, 1
otherwise, 2 when any of the three inputs is missing. Filling the genesis
is in `docs/mainnet/genesis.md`, the table in
`docs/mainnet/launch-validators.md`.

## Go/no-go check

Inputs: the mainnet genesis file (launch validators, their URLs,
`shardSize` and forks), the snapshot directory the validators boot with,
optionally the peerlist when the genesis URLs are not the ones to probe,
and an operator map:

```json
{
  "0x<validator identity>": { "operator": "acme", "provider": "hetzner", "region": "eu-central" },
  "0x<validator identity>": { "operator": "beta", "provider": "aws", "region": "us-east" }
}
```

Run it from any machine that can reach the validators' RPC ports:

```bash
bun scripts/launch-go-no-go.ts \
  --genesis data/genesis.json \
  --snapshot data/snapshot \
  --operators launch-operators.json \
  --genesis-hash <agreed genesis block hash> \
  --commit <release commit SHA> \
  [--peerlist demos_peerlist.json] [--rpc https://v1.example:53550,...] \
  [--json]
```

`--genesis-hash`, `--commit` and `--snapshot` are required for GO; without
any of them the result is NO-GO and says which one is missing.

- `--genesis-hash` is the agreed genesis block hash (above). The tool also
  builds block 0 from `--genesis` and is NO-GO when the two differ, so the
  file on the checking machine must be the published one. It is exit 2
  when the value is not 64 hex characters (a `0x` prefix and case are
  ignored). Passing the genesis data hash instead is NO-GO with a reason
  that names the mistake.
- `--commit` is the release commit, as a full or short SHA (at least 7
  hex characters). A node reports `/info` `commitHash` as
  `<GIT_BRANCH><sha>`, and a release image carries its tag there
  (`<v1.0.0-rc.4>e30ee46...`); the `<...>` prefix, a `branch@` prefix, a
  `0x` and case are ignored, and a short SHA matches the full one it
  abbreviates. A node whose `getNetworkInfo` reports `nodeVersion.dirty`
  (built with uncommitted changes) does not match, whatever SHA it names.
  Any launch validator with a proven identity on another commit, a dirty
  build, or no commit at all is NO-GO on its own, whatever the quorum:
  mixed builds at launch are not allowed.
- `--shard-size` is only for runs without `--genesis`. With `--genesis` the
  tool reads `properties.shardSize` the way the node does (block 0 fixes
  it), and a `--shard-size` that differs is refused with exit 2, so a flag
  can never move the quorum the check applies.

Per validator it reports reachability, the identity the endpoint answers
with (`/info`), the genesis hash it holds (`/genesisBlock`), its head height
and its commit (`/info` `commitHash`; the image digest itself is not
exposed by the node, so it comes from the T-24h posts). Then:

- `GO` (exit 0): `--genesis-hash` and `--commit` were given and the genesis
  file builds that block 0; at least `q` members of the first committee
  answer with their own proven identity, on the agreed genesis block and
  release commit; every launch validator has a complete operator/provider
  entry with no group above `min(launch validators, shardSize) − q` and none holding more than a
  third of the first committee's votes; the genesis schedules
  `osDenomination`, `nonceEnforcement`, `signatureDomain`, `editBinding`,
  `nonceIntegrity`, `quorumParity`, `committeeBinding`, `commitLock`, `finalityProofs`, `identityCarryover` and `txTypeAllowList` at
  `activationHeight` 0, leaves `networkGovernance` unscheduled (`null`), declares every fork the build knows (an undeclared one would take the
  code default), gives a scheduled `gasFeeSeparation` its `treasuryAddress`,
  uses a chain id other than testnet `1` and devnet `1337`, and sets
  `shardSize` 10; and no launch validator is one of
  the pinned committee identities (`PINNED_SHARD_IDENTITIES`), which take
  a seat on any network whose pool holds them; and a node would accept
  the genesis file at its first boot (fixed timestamp, snapshot bound by
  `snapshot.manifestSha256`). Without `--genesis` the forks cannot be
  checked and the result is always NO-GO.
- `NO-GO` (exit 1): each failed condition is listed. A validator answering
  with a different identity, an unproven identity or another commit is
  shown but not counted. A launch validator with a proven identity that
  runs other rules is NO-GO on its own, whatever the quorum: another genesis
  block, other genesis data (`getGenesisDataHash`), another fork schedule
  digest, one of the mainnet forks not active, or another commit. It would abstain or split at
  launch, so its operator fixes it before the chain starts.
- Exit 2: bad input, including a malformed `--genesis-hash` or `--commit`
  and a `--shard-size` that differs from the genesis.

**Identity proof.** `/info` is a claim anyone can make, so an endpoint
(for example a `--rpc` URL) could otherwise answer for an offline
validator. The tool sends each endpoint the node's own `hello_peer`
handshake with a fresh random nonce and the agreed genesis hash, and
counts the validator only when the reply is signed by that validator's
key over the domain-separated `DEMOS_PEER_AUTH_V1` message for that nonce
and the dialed URL, checked with the node's verifier. The tool uses a
throwaway key of its own for the handshake, in a private temporary
directory it deletes afterwards. Anything else (no signature, a bad one,
a timeout) is shown as `unproven-identity` and not counted.

**Launch set and snapshot.** The launch validators are block 0's staked
set (status `2` and an integer `valid_at` of 0; a null `valid_at` never
matches, as in the node's query), as the node seeds it. A node takes it
from the snapshot directory's `validators.jsonl` when the snapshot
manifest lists one, and then ignores `genesis.validators`; from
`genesis.validators` when the snapshot has no such file; and seeds no
validators when it boots without a snapshot. `--snapshot DIR` reads the
directory with the node's own loader (integrity checks included) and
follows that order. It warns when `validators.jsonl` and
`genesis.validators` name different validators. It is NO-GO when the
directory has no manifest, when the node would refuse a
`genesis.validators` row at boot (checked with the node's own seeding),
and whenever `--snapshot` is missing: without it block 0's set is unknown.
The genesis endpoints are still probed so the output shows their state.

**First committee.** With more launch validators than `shardSize`, only
the `shardSize` drawn for block 1 can sign it. The tool computes that
committee the way the node does: the validators active at block 0,
ranked under block 0's seed (from the agreed genesis hash),
pinned identities first, cut to `shardSize`. It counts only those members
toward `q` and lists the others as reserve. When the genesis hash is not
known (no `--genesis-hash` and no agreement among the validators) and the
launch set is larger than `shardSize`, it returns NO-GO rather than count
validators that might not be in the committee.

**Operator entries.** Every launch validator needs an entry with a
non-empty string `operator` and `provider`. A missing field, an empty
string or a non-string value is NO-GO and names the validator, because a
validator without a group would escape the cap. A missing `region` is a warning here and a failure under
`--plan`.

Without `--genesis-hash` the result is NO-GO. The hash most validators
report is still used to draw the committee and show each validator's
state, which helps diagnose a rehearsal; without `--commit` the output
also lists the different commits the counted validators run.

## Signing-path proof

Each validator proves, from its production host, that its identity file
signs with the code path the node uses for blocks (identity load and the
signing worker pool that `createBlock` calls):

```bash
bun scripts/validator-prove-signing.ts \
  --genesis-hash <agreed genesis block hash> [--date YYYY-MM-DD] \
  [--identity-file /path/to/.demos_identity] [--out proof.json]
```

It prints `{ identity, algorithm, challenge, signature }` for the challenge
`demos-launch-proof:<genesis block hash>:<date>`, with the hash lowercased
and without a `0x` prefix. It never prints the mnemonic or
a private key, never creates an identity file, does not touch the block
signing record, and refuses to run when the signing stop marker
(`<identity file>.signed.json.halted`) exists. The fixed prefix keeps the
signature from ever passing as a block signature.

It loads the node's code and starts one signing worker, about 500 MB of
memory. Run it beside the node, not inside the node's container: inside a
memory-capped container it can push the node over its limit and get the
node killed (seen on a devnet with a 1.8 GB cap).

Collect the proofs into one JSON array and check them against the launch
set, read the same way as the go/no-go check reads it:

```bash
bun scripts/validator-prove-signing.ts --verify proofs.json \
  --genesis data/genesis.json --snapshot data/snapshot \
  --genesis-hash <agreed genesis block hash> [--date YYYY-MM-DD] --require-all
```

The genesis hash and identities are compared without case or a `0x`
prefix, so a proof signed with `--genesis-hash 0x<hash>` (an older tool
kept the prefix in the challenge) verifies against `--genesis-hash
<hash>` and the reverse. The signature is still checked over the challenge
exactly as it was signed.

`--snapshot` is required here too (exit 2 without it).

The tool builds block 0 from `--genesis` (read the way the node reads it)
and holds every proof to that hash, with or without `--genesis-hash`. It
is NOT OK when the file's block 0 cannot be known (no fixed timestamp),
when `--genesis-hash` names another block 0, or when the proofs name
another hash; proofs of the genesis data hash are named as that mistake.
Proofs that only agree with each other are not enough.

Every proof must come from a launch validator, name the agreed genesis
(and date), and verify; `--require-all` also fails on any launch
validator without a proof. Always pass `--require-all` for the rule 1
check: without it a partial set passes. Exit 0 ok, 1 not ok, 2 bad input.

## Failure drills behind the numbers

`testing/devnet/quorum-drills/` runs the quorum scenarios on a local devnet
(validator count and `shardSize` per scenario, validators stopped
mid-round, a network split, the staked-set fallback). See its README for
what each scenario asserts.
