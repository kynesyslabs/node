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
   it will run, and a signing proof (below) for the agreed genesis hash.
2. **Operator and provider cap:** no single operator and no single cloud
   provider runs more than a third of the launch validators (at most 3 of
   10). With `shardSize` equal to the validator count, one party above that
   can stop the chain on its own.
3. **T-0:** GO when at least `q` (7 with `shardSize` 10) launch validators
   are online on the same genesis hash and the cap holds. Otherwise NO-GO,
   and retry at the next agreed slot.
4. A validator counts only after it has made a signed block on the
   rehearsal network from its production host, key and image.
5. Mainnet validators run with `DEMOS_REQUIRE_VALIDATORS=true`.

Rules 2 and 3 are what `scripts/launch-go-no-go.ts` checks. Rules 1 and 4
use `scripts/validator-prove-signing.ts` and the rehearsal network.

## Go/no-go check

Inputs: the mainnet genesis file (launch validators, their URLs and
`shardSize`), optionally the peerlist when the genesis URLs are not the
ones to probe, and an operator map:

```json
{
  "0x<validator identity>": { "operator": "acme", "provider": "hetzner" },
  "0x<validator identity>": { "operator": "beta", "provider": "aws" }
}
```

Run it from any machine that can reach the validators' RPC ports:

```bash
bun scripts/launch-go-no-go.ts \
  --genesis data/genesis.json \
  --operators launch-operators.json \
  --genesis-hash <agreed genesis hash> \
  [--peerlist demos_peerlist.json] [--rpc https://v1.example:53550,...] \
  [--commit <release commit>] [--json]
```

Per validator it reports reachability, the identity the endpoint answers
with (`/info`), the genesis hash it holds (`/genesisBlock`), its head height
and its commit (`/info` `commitHash`; the image digest itself is not
exposed by the node, so it comes from the T-24h posts). Then:

- `GO` (exit 0): at least `q` launch validators answer with their own
  identity, on the agreed genesis hash (and on `--commit` when given), and
  every validator has an operator/provider entry with no group above a
  third of the launch set.
- `NO-GO` (exit 1): each failed condition is listed. A validator answering
  with a different identity, another genesis or another commit is shown but
  not counted.
- Exit 2: bad input.

Without `--genesis-hash` the hash most validators report is used, and the
output warns when they disagree. Pass the agreed hash on launch day.

## Signing-path proof

Each validator proves, from its production host, that its identity file
signs with the code path the node uses for blocks (identity load and the
signing worker pool that `createBlock` calls):

```bash
bun scripts/validator-prove-signing.ts \
  --genesis-hash <agreed genesis hash> [--date YYYY-MM-DD] \
  [--identity-file /path/to/.demos_identity] [--out proof.json]
```

It prints `{ identity, algorithm, challenge, signature }` for the challenge
`demos-launch-proof:<genesis hash>:<date>`. It never prints the mnemonic or
a private key, never creates an identity file, does not touch the block
signing record, and refuses to run when the signing stop marker
(`<identity file>.signed.json.halted`) exists. The fixed prefix keeps the
signature from ever passing as a block signature.

It loads the node's code and starts one signing worker, about 500 MB of
memory. Run it beside the node, not inside the node's container: inside a
memory-capped container it can push the node over its limit and get the
node killed (seen on a devnet with a 1.8 GB cap).

Collect the proofs into one JSON array and check them against the genesis:

```bash
bun scripts/validator-prove-signing.ts --verify proofs.json \
  --genesis data/genesis.json --genesis-hash <agreed genesis hash> \
  [--date YYYY-MM-DD] --require-all
```

Every proof must come from a genesis validator, name the agreed genesis
(and date), and verify; `--require-all` also fails on any genesis
validator without a proof. Exit 0 ok, 1 not ok, 2 bad input.

## Failure drills behind the numbers

`testing/devnet/quorum-drills/` runs the quorum scenarios on a local devnet
(validator count and `shardSize` per scenario, validators stopped
mid-round, a network split, the staked-set fallback). See its README for
what each scenario asserts.
