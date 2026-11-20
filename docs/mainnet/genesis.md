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
`FILL` value in a fork height or fork payload, `sudoPubkey` or `balances`
(and, with the genesis pinned, the timestamp), before it writes block 0.
The plan check below reports each of them, so an unfilled template can
never boot by accident.

The template sets the mainnet chain id, `8587492`, and no identity and no
allocation. Those are decided by the genesis owners and filled in once.

## What is already fixed

| Field | Value | Why |
|---|---|---|
| `properties.id` | `8587492` | the mainnet chain id the owners decided. go/no-go and the plan check refuse `0`, testnet `1`, devnet `1337` and `31337` (the fork rehearsals' and local EVM development chains' default): every signature binds to the chain id, so a reused id lets a transaction signed on another network replay on mainnet |
| `properties.shardSize` | `10` | the launch committee: quorum 7, at most 3 seats lost |
| `mutables.minBlocksForValidationOnlineStatus` | `4` | same as testnet |
| `forks.osDenomination`, `nonceEnforcement`, `signatureDomain`, `editBinding`, `nonceIntegrity`, `quorumParity`, `committeeBinding`, `commitLock`, `finalityProofs`, `identityCarryover`, `stakeApplyChecks`, `txTypeAllowList`, `instantMessagingBinding`, `nativeSendBinding`, `canonicalAddresses`, `feeBinding`, `blockCaps`, `unpinnedCommittee`, `telegramSenderBinding`, `xmRemoveCanonical`, `tokenStakingGate`, `tokenStaking`, `nftValidatorGating`, `web2ProofBinding`, `tlsnProofEnforcement`, `xmProofBinding`, `storageFeeSettlement`, `referenceBlockRoom10`, `l2psSettlement`, `tlsnVerified` | `activationHeight: 0` | mainnet starts with every safety fork on; `web2ProofBinding` takes only web2 proofs that sign the bound message (SDK ≥ 4.0.20 `createWeb2ProofPayload` with a claim), and `xmProofBinding` takes only cross-chain identity proofs that sign the `demos-xm:v1` message, so clients need `@kynesyslabs/demosdk` 4.0.21; and `tlsnProofEnforcement` refuses every TLSN identity claim that carries the structure-only marker; L2PS settles from block 0: under `l2psSettlement` an `l2psBatch` moves L1 balances through a PLONK-proven net-change record that every validator verifies (the verification key ships in the image, pinned by its digest in the code), and the entry node's local L2PS proof path is off; TLSNotary runs from block 0: under `tlsnVerified` the node verifies a presentation itself, in the verifier wasm whose sha256 the payload pins, and accepts only the notary keys the payload lists (see the owner-filled fields below); `storageFeeSettlement` credits the storage fee of a Storage Program create or write to burn and treasury like a network fee, so the total supply stays the genesis total; `referenceBlockRoom10` lets a transaction's reference block be up to 10 blocks behind the head (deep window 50 blocks), so a transaction confirmed under load or approved after a few seconds still lands; at height 0 block 0 records `osDenomination` as applied for a snapshot that is already in OS units, and a node refuses such a snapshot under any other height. `identityCarryover` makes block 0 import user data without balances and refuse any other snapshot ([genesis-import.md](genesis-import.md)) |
| `forks.atomicWork` | `activationHeight: null` | not scheduled at launch; a later activation is a coordinated schedule change |
| `forks.l2psGate` | `activationHeight: null` | the L2PS kill switch, not scheduled at launch. Scheduled at a height on the running chain, it refuses every L2PS transaction, request and pending proof and stops the L2PS services; go/no-go is NO-GO on a genesis that schedules it |
| `forks.nftValidatorGating` | `activationHeight: 0` | validator seats are backed by an allowlisted Solana Node NFT from block 0, not by bonded DEM. Every genesis validator carries `nft_mint`, `nft_owner` and `nft_proof_tx` (see `validators` below). go/no-go reads each proof on Solana before the genesis is sealed; a node building block 0 checks the NFT fields offline (allowlisted mint, well-formed owner and proof, no mint backing two seats, no `nft_exempt`) and never reads Solana. From block 1 a `validatorStake` carries amount 0 and a proof that the NFT's wallet backs the validator, a `validatorChallenge` evicts a seat whose NFT left that wallet, seat transactions pay no gas and the unstake lock is 20 blocks. Pool admission holds a sender to 3 stakes or challenges a minute and 2 in the pool, and keeps a refused proof refused for 10 minutes without reading Solana again. No eviction and no unstake takes the active set below the committee floor (7 of shardSize 10). go/no-go is NO-GO on a genesis that does not schedule it at 0, on a block 0 seat without a valid NFT field set or with a proof that does not check out on Solana, on an `nft_exempt` seat, and on a build without its allowlist digest pin ([validator-staking.md](../runbooks/validator-staking.md)) |
| `forks.tlsnDisabled` | `activationHeight: null` | the TLSNotary kill switch, not scheduled at launch. Scheduled at a height on the running chain, it refuses `tlsn_request`, `tlsn_store` and any `tlsnotary` edit before any fee or burn and issues no attestation token; go/no-go is NO-GO on a genesis that schedules it |
| `forks.tlsnVerified` payload limits | `maxPresentationBytes` `65536`, `freshnessWindowSec` `3600`, `futureSkewSec` `60` | the largest presentation the node verifies or stores (1024 to 1048576 bytes); how long before the block time an attested connection may have been made (1 to 604800 s), which at 3600 s is shorter than the 500-block `tlsn_request` token at 10 s blocks, so users must store or link within an hour of attesting ([tlsn-notary.md](../runbooks/tlsn-notary.md), section 1); and how far after the block time an attested time may lie, for a notary whose clock runs ahead (0 to 600 s). Every validator judges a presentation with the values of the block it lands in, so they are consensus values and change only by a scheduled release |
| `forks.networkGovernance` | `activationHeight: null` | network-upgrade proposals and votes are refused at launch; go/no-go is NO-GO on a genesis that schedules it. Turning governance on is a later, height-pinned schedule change |
| `forks.tokenStakingGate` | `activationHeight: 0` | stakes and unstakes are refused at intake and at apply with "token staking is not enabled on this network (fork tokenStaking)" unless `tokenStaking` is active, which it is from block 0. Kept so that a later release can close seat intake again by moving `tokenStaking`. A node whose build does not know the fork refuses to boot on this genesis |
| `forks.tokenStaking` | `activationHeight: 0` | seat intake is open from block 1. With `nftValidatorGating` at 0 every stake is an NFT seat: a stake of any amount but 0 is refused at intake and at apply, so no DEM is ever bonded and the bonded-stake rules of `stakeApplyChecks` never run. go/no-go is NO-GO on a genesis that does not schedule it at 0 |
| `forks.gasFeeSeparation` | `activationHeight: 0`, with the treasury the owners fill | a native transaction pays the fee its `transaction_fee` names, split between the burn and treasury accounts (the rpc share goes to treasury while no operator is named), and with `feeBinding` that fee is all it pays: no flat gas on top, so transfers keep the total supply. Without the fork the fee is a flat 1 DEM per transaction that no account receives |
| `status` | `"confirmed"` | as on testnet |

This list matches `MAINNET_FORKS` in `scripts/launch-go-no-go.ts` and the
genesis acceptance harness (`testing/genesis-acceptance/`); a test keeps
them equal.

## What the owners fill

| Field | Fill with |
|---|---|
| `properties.name`, `properties.currency` | network name and currency symbol |
| `properties.sudoPubkey` | the lowercase `0x` + 64 hex key that may sign award transactions, or delete the field to accept none |
| `forks.gasFeeSeparation.treasuryAddress` | the mainnet treasury account. The node refuses the entry without it and refuses the zero address, and block 0 creates the burn and treasury accounts |
| `forks.tlsnVerified.notaryKeys[].hex` | the public keys from the notary key ceremony (2 holders, as for the release key): `demos-notary-1`, the key the running notary signs with, and `demos-notary-standby`, the cold standby a rotation switches to without a new ceremony. Each is `alg` `k256` and a 33-byte compressed secp256k1 key, lowercase `02` or `03` + 64 hex (the prover only requests secp256k1). The node refuses at boot a P-256 or uncompressed key, a point not on the curve, a repeated key or id, and any field it does not know; go/no-go also refuses the devnet, spike and test-vector keys of this repository (`KNOWN_TEST_NOTARY_KEYS`). The notary key ceremony owners provide them |
| `forks.tlsnVerified.verifierWasmSha256` | the sha256 of `native/tlsn-verify/dist/demos_tlsn_verify.wasm` in the launch release, 64 lowercase hex. It pins the verifier, and so the presentation format, every validator runs. The release owner fills it from the release build |
| `snapshot.manifestSha256` | `sha256sum` of the launch snapshot's `manifest.json`. Keep the field: the launch tools model block 0 on the snapshot path, and the plan check and the height-1 check both require the snapshot |
| `balances` | the agreed allocations, `[["0x<64 hex address>", "<amount>"], ...]`, each address lowercase. An entry replaces the balance an address has in the snapshot, it is not added to it, so write the whole balance the account starts with, never a top-up. The amount is in OS (1 DEM = 10^9 OS), a decimal integer string. Under `identityCarryover`, the only mainnet path, the snapshot is already in OS units: the carry-over builder refuses any other (`scripts/state-snapshot/carryover.ts`), so a DEM figure entered here would start the account with a billionth of its allocation. A build script that takes whole DEM multiplies by 10^9 before it writes the field. Write the total supply in OS (with the DEM figure beside it) into the allocation sign-off ([genesis-key-custody.md](../runbooks/genesis-key-custody.md)) |
| `timestamp` | the launch time in seconds as a positive integer string. Block 0 is built from it, so the block 0 hash is known only once it is fixed |
| `validators` | the launch validators, one object each: `address`, `status` `"2"`, `connection_url`, `staked_amount` `"0"`, `first_seen` `0`, `valid_at` `0`, `nft_mint`, `nft_owner`, `nft_proof_tx`. The NFT fields name the allowlisted Node NFT that backs the seat, the Solana wallet holding it and the finalized Solana transaction, signed by that wallet, whose `demos-validator:` memo names the address; `bun scripts/genesis-seeds.ts` writes them ([validator-staking.md](../runbooks/validator-staking.md)). No two seats share a mint, and no entry is `nft_exempt` (test networks only). `staked_amount` is in OS units (1 DEM = 10^9 OS) and is `"0"`: a seat is backed by its NFT. When the snapshot carries `validators.jsonl`, the node seeds from that file instead and, on a mainnet chain id, holds those rows to the same NFT fields offline, as go/no-go does; the carry-over check compares the NFT fields of each row with its genesis entry. Under `identityCarryover` the launch snapshot is built from this list (`bun run snapshot:carryover --validators mainnet/genesis.json`), and block 0 refuses a snapshot whose `validators.jsonl` differs from it |

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
  --operators mainnet/launch-validators.json \
  --expected-treasury <agreed treasury address> \
  --expected-notary-keys <id:hex,id:hex from the notary key ceremony>
```

It prints one `PASS` or `FAIL` line per check (genesis forks, the
treasury against `--expected-treasury`, the `tlsnVerified` notary keys
against `--expected-notary-keys`, chain id,
shard size, genesis values (no template `FILL` left), whether a node
would load the file, block 0 validator set,
launch validators against the quorum, the validator table, the operator
and provider cap, voting power per operator and provider, the beneficial
owner cap, region share, stake share, pinned identities) and exits 0 only
when all pass.

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
