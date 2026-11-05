---
type: design
title: Mainnet genesis import
date: 2026-11-05
status: active
---

# Mainnet genesis import

Mainnet starts from a fresh block 0. Testnet blocks and transactions are
not carried over. Block 0 restores one snapshot of testnet state, taken at
testnet block 563,541 (`data/snapshot`). What it restores depends on the
`identityCarryover` fork, which the mainnet genesis schedules at 0.

## What comes over

| Snapshot file | At mainnet block 0 |
|---|---|
| `gcr_main.jsonl` | Every account row comes over with its linked identities (Web2 links with their proofs and attestation signatures, wallets, Nomis, Ethos, Unstoppable Domains, Human Passport, post-quantum keys), its points and its `referralInfo`. Every balance is 0. Nonces were already 0 and `assignedTxs` empty in the export. |
| `gcr_storageprogram.jsonl` | Copied byte for byte: every storage program, its data, owner and ACL. |
| `identity_commitments.jsonl` | Copied byte for byte (6 rows). Their `block_number` fields name testnet blocks; nothing on the restore path reads them as mainnet heights. |
| `validators.jsonl` | Replaced. The testnet validator rows and stakes are dropped; the file holds the launch validators from the genesis. |

The agreed allocations in the genesis `balances` field are written over
the zeroed accounts after the restore, as before.

## The rules at block 0

With `identityCarryover` active at 0, a node refuses (`GenesisRefusal`,
before anything is written) a snapshot that:

- has a `gcr_main.jsonl` row with a non-zero balance (it is not dropped or
  zeroed silently: the operator rebuilt the wrong snapshot);
- has a manifest whose `gcr_main.jsonl` `balance_sum` is not `"0"`;
- has no `validators.jsonl`;
- has a `validators.jsonl` that differs from the genesis `validators` list
  in any entry, or lists a validator the genesis does not (and the other
  way round). An empty genesis list leaves the file as the only source.

The usual snapshot checks still run first: each file's sha256, row count
and sums must match the manifest, and the genesis must name the manifest's
sha256 in `snapshot.manifestSha256`.

Without the fork (testnet, devnet, rehearsals with a funded snapshot) the
restore is unchanged.

## Imported identities and points

The account's points come over as they are. The first link of an identity
was rewarded on testnet, so linking it again on mainnet must not pay the
first-link award a second time, to the same account or to another one.

Block 0 records the key of every imported identity in
`genesis_imported_identities`: `web2:<platform>:<userId>` for Twitter,
GitHub, Telegram and Discord, `xm|nomis|ethos:<chain>:<subchain>:<address>`
(EVM addresses lowercase), `ud:<domain>` and `humanpassport:<address>`.
The snapshot at 563,541 yields 27,290 keys. Under the fork, the first-link
check answers "not first" for any key in that table, so the award hooks
(`twitterLinked`, `githubLinked` and the others) do not run for it. The
table is derived from the snapshot that the genesis hash binds, so it is
not part of the state hash.

Consequence: unlinking an imported identity still deducts its points, as
on testnet, and linking it again pays nothing. The points of an imported
identity are kept only while it stays linked.

## Web2 unlink

Before the fork, a Web2 unlink removes every link whose username equals
the one in the request, and deducts once. The username is supplied by the
client and is not unique, so two platform accounts under one username were
removed for one deduction, and both could be linked again for two awards.
A platform account stored under two usernames could also be unlinked under
one of them while the other kept it linked.

Under the fork an unlink removes exactly one platform account:

- With a `userId` in the request, every link of that account on that
  platform is removed (ids compared in their canonical form, so `7` and
  `"7"` are one account).
- With only a `username` (what the SDK sends today), the link with that
  username is found. Every link with that link's `userId` is removed. If
  two links carry the username, the unlink is refused until the request
  names the `userId`.
- A link stored without a `userId` cannot be named by one. A request whose
  username finds only that link removes only that link. The snapshot holds
  exactly one such link (a Twitter link). It is not in
  `genesis_imported_identities`, since it has no id to key by, so a later
  link of the same Twitter account with its real id can earn the award
  once.

TLSN unlinks follow the same rules, restricted to links proven with TLSN.

## Build the snapshot and reproduce its hash

The launch snapshot is a pure function of the testnet snapshot and the
launch validator list:

```bash
bun run snapshot:verify
bun run snapshot:carryover --in data/snapshot \
    --validators mainnet/genesis.json --out mainnet/snapshot
bun run snapshot:rehash --check --outdir mainnet/snapshot
sha256sum mainnet/snapshot/manifest.json
bun scripts/genesis-hash.ts --genesis mainnet/genesis.json --snapshot mainnet/snapshot
```

`--validators` reads the genesis file's `validators` array (a bare JSON
array of the same entries also works). Each entry needs a lowercase `0x` +
64 hex `address`, `status`, `connection_url` (a URL or null),
`staked_amount` in OS units as a decimal string, and integer `first_seen`
and `valid_at`. The rows are written sorted by address.

The script:

1. verifies the input snapshot against its manifest;
2. sets each `gcr_main.jsonl` row's `balance` to `"0"`. A row that does not
   survive a JSON parse and serialise unchanged is refused, so no other
   byte of a row can change;
3. writes `validators.jsonl` from the list;
4. copies the storage program and identity commitment files;
5. writes `manifest.json`: the source manifest with the new `gcr_main.jsonl`
   and `validators.jsonl` entries, `transforms_applied.balances_zeroed` and
   `validators_from_launch_list` set to `true`, and a `carryover` block with
   the sha256 of the source manifest and of the launch list file;
6. verifies the output and refuses an output directory that is not empty.

Two runs on the same inputs give the same bytes. For
`data/snapshot` (source manifest sha256 `5dfa4b2c…7c63da4`) 1,329 of
14,216 accounts held a balance; the output is about 32 MB, the same size
as the input. Put the printed manifest sha256 into the genesis
`snapshot.manifestSha256`. The genesis hash changes with it.
