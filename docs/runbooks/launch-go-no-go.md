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
   provider runs more than `shardSize − q` launch validators: at most 3
   with `shardSize` 10 and 10 to 13 validators (2 with 9). Those are the
   committee seats the chain can lose and still sign; one party holding
   more can stop it alone. Names are compared case-insensitively and
   without surrounding spaces, so `AWS` and `aws` are one provider.
3. **T-0:** GO when at least 7 members of the first committee (block 1's
   bound committee; `q` of `shardSize` 10) are online on the same genesis
   hash, each proven to hold its identity key, and the cap holds. Online
   validators outside that committee do not count toward it. Otherwise
   NO-GO, and retry at the next agreed slot.
4. A validator counts only after it has made a signed block on the
   rehearsal network from its production host, key and image.
5. Mainnet validators run with `DEMOS_REQUIRE_VALIDATORS=true`.

Exit 0 from `scripts/launch-go-no-go.ts` is the T-0 check of rules 2 and 3
only, plus the genesis checks below. It does not check rules 1, 4 and 5:
people check those, with `scripts/validator-prove-signing.ts --verify
--require-all` for the rule 1 proofs and the rehearsal network for rule 4.

## Go/no-go check

Inputs: the mainnet genesis file (launch validators, their URLs,
`shardSize` and forks), the snapshot directory the validators boot with,
optionally the peerlist when the genesis URLs are not the ones to probe,
and an operator map:

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
  --snapshot data/snapshot \
  --operators launch-operators.json \
  --genesis-hash <agreed genesis hash> \
  [--peerlist demos_peerlist.json] [--rpc https://v1.example:53550,...] \
  [--commit <release commit>] [--json]
```

On launch day `--genesis-hash` and `--snapshot` are required: pass the
agreed hash, never let the tool pick the one most validators report, and
the snapshot directory the validators boot from.

Per validator it reports reachability, the identity the endpoint answers
with (`/info`), the genesis hash it holds (`/genesisBlock`), its head height
and its commit (`/info` `commitHash`; the image digest itself is not
exposed by the node, so it comes from the T-24h posts). Then:

- `GO` (exit 0): at least `q` members of the first committee answer with
  their own proven identity, on the agreed genesis hash (and on `--commit`
  when given); every launch validator has a complete operator/provider
  entry with no group above `shardSize − q`; the genesis schedules
  `signatureDomain`, `editBinding`, `quorumParity`, `committeeBinding` and
  `commitLock` at `activationHeight` 0; and no launch validator is one of
  the pinned committee identities (`PINNED_SHARD_IDENTITIES`), which take
  a seat on any network whose pool holds them. Without `--genesis` the
  forks cannot be checked and the result is always NO-GO.
- `NO-GO` (exit 1): each failed condition is listed. A validator answering
  with a different identity, an unproven identity, another genesis or
  another commit is shown but not counted.
- Exit 2: bad input.

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
validator without a group would escape the cap.

Without `--genesis-hash` the hash most validators report is used, and the
output warns when they disagree. That is for rehearsals only.

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

Collect the proofs into one JSON array and check them against the launch
set, read the same way as the go/no-go check reads it:

```bash
bun scripts/validator-prove-signing.ts --verify proofs.json \
  --genesis data/genesis.json --snapshot data/snapshot \
  --genesis-hash <agreed genesis hash> [--date YYYY-MM-DD] --require-all
```

`--snapshot` is required here too (exit 2 without it).

Every proof must come from a launch validator, name the agreed genesis
(and date), and verify; `--require-all` also fails on any launch
validator without a proof. Always pass `--require-all` for the rule 1
check: without it a partial set passes. Exit 0 ok, 1 not ok, 2 bad input.

## Failure drills behind the numbers

`testing/devnet/quorum-drills/` runs the quorum scenarios on a local devnet
(validator count and `shardSize` per scenario, validators stopped
mid-round, a network split, the staked-set fallback). See its README for
what each scenario asserts.
