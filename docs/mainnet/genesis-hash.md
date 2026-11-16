---
type: runbook
title: Mainnet genesis hash, publication and the height-1 check
date: 2026-11-05
status: active
---

# Mainnet genesis hash

Line references are to `v1.0.0-rc.11` (`167cf232`). Every value below is
printed by one command, which runs the node's own code:

```bash
bun scripts/genesis-hash.ts --genesis mainnet/genesis.json --snapshot mainnet/snapshot
sha256sum mainnet/genesis.json
```

## The values

A genesis has five published values. They cover different bytes, so all five
are published together, and none of them stands in for another.

| Value | Covers | Used as |
|---|---|---|
| File checksum | every byte of the file | download integrity; what each operator confirms they mounted |
| Genesis data hash ("the genesis hash") | the parsed content, canonicalised | `EXPECTED_GENESIS_HASH` (boot pin), `getGenesisDataHash` |
| Genesis block hash (block 0 hash) | block 0 as built from the parsed file, key order included | `EXPECTED_GENESIS_BLOCK_HASH`, `/genesisBlock`, `--genesis-hash` of the launch tools |
| Fork schedule digest | the scheduled forks and the chain id | `forkScheduleDigest` in `getNetworkInfo` |
| Snapshot manifest sha256 | the raw `manifest.json` bytes, and through its per-file sha256 list, the whole snapshot | `snapshot.manifestSha256` inside the genesis |

"The genesis hash" in the launch tracker means the genesis data hash. It is
the boot pin. Launch-day tools (`launch-go-no-go.ts`,
`validator-prove-signing.ts`, `launch-height1-check.ts`) take the block 0 hash
instead, since that is what a running node serves. Every mainnet validator
sets both pins.

### File checksum

`sha256sum` of the file as published. No node computes it: the node parses the
file (`readGenesisFile`, `src/libs/blockchain/routines/findGenesisBlock.ts:83-89`, a JSON string
holding JSON is parsed a second time), so whitespace never reaches either hash.
It is the only value that changes on every byte, which is why operators confirm
it under the 24 h rule below.

### Genesis data hash

`hashGenesisData` in `src/libs/blockchain/genesis/normalizeGenesisForHash.ts:178-181`:

1. `canonicalGenesisForHashing` (`:68-140`) copies every top-level key except
   `validators` unchanged (`:87-107`): `properties` (chain id, shard size),
   `mutables`, `forks`, `balances`, `timestamp`, `status`, `snapshot` and any
   other key.
2. Each `validators[]` entry loses `connection_url` (`:111-120`), and the
   entries are sorted by `address`, compared as strings (`:122-134`).
3. `stableStringify` (`:152-166`) serialises with object keys sorted at every
   depth and no whitespace. Arrays keep their order, and primitives go through
   `JSON.stringify`, so `"10"` and `10` differ, and `10` and `10.0` do not.
   Key order therefore never affects this hash.
4. `Hashing.sha256` (`src/libs/crypto/hashing.ts:15-16`): SHA-256 of the
   UTF-8 string, as 64 lowercase hex characters with no `0x`.

So the genesis file's own validator URLs, validator order, key order and
whitespace do not enter the data hash. Changing anything else changes it,
including the forks block, the chain id, the timestamp, a balance and the
snapshot binding.

Under `identityCarryover` (the mainnet path) a validator URL does change the
data hash. Block 0 seeds the validators from the snapshot's
`validators.jsonl`, which holds each `connection_url`
([genesis-import.md](genesis-import.md)). Its sha256 is listed in
`manifest.json`, the manifest's sha256 is `snapshot.manifestSha256` in the
genesis, and that field is part of the data hash. A changed URL therefore
means a new snapshot, a new genesis, new hashes and a new 24 h window
([genesis.md](genesis.md)). `scripts/genesis-hash.ts` does not compare the
genesis `validators` URLs with `validators.jsonl`; `launch-go-no-go.ts --plan`
does, so run `--plan` before the hash step.

Where the node uses it:

- On a fresh database it hashes the genesis file (`data/genesis.json`, or
  `DEMOS_GENESIS_FILE`) and refuses to boot on a mismatch with
  `EXPECTED_GENESIS_HASH` (`freshGenesisProblems`,
  `src/libs/blockchain/genesis/genesisPin.ts:283-288`, called from
  `findGenesisBlock.ts:241-250`). A production node with no pin
  refuses to start unless `DEMOS_ALLOW_UNPINNED_GENESIS=true`; a node whose genesis
  has the mainnet chain id refuses to start without a pin in any mode, and
  refuses to start while `DEMOS_ALLOW_UNPINNED_GENESIS=true` is set, pinned or
  not (`pinRequirementProblem` in `genesisPin.ts`).
- `getGenesisDataHash` hashes the genesis data stored inside block 0
  (`src/libs/network/handlers/blockHandlers.ts:18-36`), so it reports what the
  node actually started from.

Checked by hand: recomputing steps 1 to 4 outside the node (Python,
`sort_keys`, compact separators) on `testing/devnet/genesis.devnet.json` gives
the data hash the tool prints, `bb672b88…54b0741f`.

### Genesis block hash (block 0 hash)

`buildGenesisBlock` in `src/libs/blockchain/genesis/buildGenesisBlock.ts:26-85`:

- The genesis transaction gets the file's `timestamp` through `parseInt`, or
  the host clock when it is missing or falsy (`:48-52`). Its hash goes into
  `ordered_transactions` (`:59-61`, `:67`).
- `content.extra.genesisData = JSON.stringify(genesisData)` (`:69-71`): the
  parsed file re-serialised in the file's own key order, with validator URLs
  and validator order included. Whitespace is gone.
- `content.timestamp` is the same timestamp, and `content.previousHash` is `"0x0"` (`:66-68`).
- Hash: `sha256(serializeBlockContent(content, 0))` (`:80-82`), which is
  `JSON.stringify(content)` (`src/forks/serializerGate.ts:64-75`) over the
  content fields `Block` sets (`src/libs/blockchain/block.ts:36-53`).

Two files with the same data hash can therefore build different blocks 0. Two
such cases are an edited validator URL and a re-ordered key. Nodes on different
blocks 0 cannot pair. `EXPECTED_GENESIS_BLOCK_HASH` closes this: a fresh node
refuses to write any other block 0, and an existing node refuses to run on one
(`blockPinProblem`, `genesisPin.ts:145-153`, called at `findGenesisBlock.ts:207-208`
and `:267-270`). The genesis needs a fixed positive integer timestamp, or the
hash is per host and the tool prints none (`genesisTimestampProblem`,
`genesisPin.ts:176-191`).

`/genesisBlock` serves the stored block 0 record (`src/libs/network/server_rpc.ts:342-355`).
A RESTORE overlay would change block 0, so it is refused whenever a pin is set
(`genesisPin.ts:290-292`, checked by `findGenesisBlock.ts:241-250` before the
overlay at `:255-258` is applied).

### Fork schedule digest

`forkScheduleDigest` in `src/libs/peer/routines/forkScheduleAgreement.ts:71-83`
takes the loaded fork config (genesis entries over code defaults). It keeps every
fork whose `activationHeight` is not null, drops `description`, and hashes
`stableStringify({ chainId, forks })` with SHA-256. A fork the genesis leaves
out still appears here when its code default is scheduled. Go/no-go requires
each validator to report this digest.

### Snapshot manifest sha256

`snapshotManifestHash` is the SHA-256 of the raw `manifest.json` bytes
(`src/libs/blockchain/genesis/loadSnapshot.ts:536-541`; the tool's copy is
`scripts/genesis-hash.ts`, `snapshotManifestSha256`). The genesis binds it as
`snapshot.manifestSha256` (`declaredManifestHash`, `genesisPin.ts:156-170`). A
node refuses a snapshot that hashes differently, and a pinned genesis that binds
no snapshot while one is present (`freshGenesisProblems`, `genesisPin.ts:247-258`,
`:294-299`). The manifest lists a sha256
per snapshot file, which the loader verifies, so this one value binds the
whole snapshot. It is inside the genesis, so it is also covered by the data
hash and the block 0 hash.

Measured on this commit (the devnet file, not mainnet's):

```
genesis block hash:  1bf42791b45d91e5d6ad09e50ba07bee952ee73142989e771b3c8d5be58be241
genesis data hash:   bb672b8824101838c51f7c396d921947be2d69ada5e026fdf5c51a7a54b0741f
fork schedule digest: 49e37fba014fe35aa733bc1cf61fdaf089fc178e69163e0781a347a97c33780d (chain id 1337)
```

## Publication

The genesis owner publishes one record, the same in every channel:

```
genesis file sha256:      <sha256sum of genesis.json>
genesis data hash:        <EXPECTED_GENESIS_HASH>
genesis block hash:       <EXPECTED_GENESIS_BLOCK_HASH, --genesis-hash>
fork schedule digest:     <digest> (chain id <id>)
snapshot manifest sha256: <snapshot.manifestSha256>
release:                  <tag> <commit> <image@digest>
```

- Where: in the GitHub release of the launch tag, plus at least two channels
  outside GitHub that are under different control, for example the operator
  mailing list and the validator chat's pinned message. An operator compares
  at least two channels before booting. The release workflow drafts that
  release with `checksums.txt` (tag, commit, `image@digest` and the source
  archive's sha256) as its notes; it knows nothing about the genesis. Before
  publishing the draft, the genesis owner adds the record above to the notes
  and attaches the genesis file and the snapshot as assets. The tag message
  cannot carry the image digest, since the image is built after the tag.
- Operators never edit the file, not even a validator URL or key order. Any
  edit changes block 0, and the node then refuses to boot against
  `EXPECTED_GENESIS_BLOCK_HASH`. The file is mounted read-only (see INSTALL.md,
  "Pin the network's genesis").
- Each operator acknowledges by posting the file sha256 of the copy they
  mounted. The launch coordinator tracks the acknowledgements.
- The same release notes carry the announcement copy of
  [`parameters.env`](parameters.env). In that copy the two commented pin
  lines at the end are replaced by
  `EXPECTED_GENESIS_HASH=<genesis data hash>` and
  `EXPECTED_GENESIS_BLOCK_HASH=<genesis block hash>`, copied from the record
  above. Operators append that copy to `.env` (INSTALL.md, "Run a released
  image", step 3) and run
  `./scripts/node-doctor --production --parameters <announcement copy>`,
  which fails when either pin differs from the copy. The pin lines in the
  repository file stay commented until the genesis is published; the
  release that follows publication fills them in.

## The 24 h rule

If any byte of the genesis file changes less than 24 hours before the planned
launch time, launch is postponed. The new launch time is at least 24 hours
after the corrected file is published, so every operator has a full day with
the final file. The same applies to the snapshot, since its manifest hash is
inside the genesis.

- The clock starts when the record above is published in all channels. It
  does not start at the commit.
- The genesis owner confirms that the file has not changed since that time. The
  launch coordinator confirms, at the go/no-go call, that every launch
  validator acknowledged the published file sha256. Without both, the call is
  NO-GO.
- This is a people rule. No script can see when an operator received the file.

## The height-1 check

Run it right after block 1 is produced, before any transaction is sent:

```bash
bun scripts/launch-height1-check.ts --genesis mainnet/genesis.json \
    --snapshot mainnet/snapshot --genesis-hash <genesis block hash> \
    [--rpc URL,URL,...] [--balances 100|all] [--timeout MS] [--json]
```

Without `--rpc` it checks every validator staked at block 0, at its
`connection_url`. For each node it checks these, one line each:

- `block-0`: `/genesisBlock` serves the agreed block 0 hash.
- `head`: the chain is past block 0.
- `block-1-parent`: block 1's `previousHash` is that block 0.
- `validators`: `getValidators` at block 0 returns exactly block 0's staked set,
  as the node seeds it: the snapshot's `validators.jsonl` when it has one,
  otherwise `genesis.validators`. Address, status, `valid_at` and stake must
  match.
- `balances`: `getAddressInfo` returns the published balance for every
  `genesis.balances` entry and for the largest snapshot accounts (100 by
  default, `--balances all` for all of them). A `genesis.balances` entry
  overrides the snapshot row of the same account, as the node does.

Across nodes, `block-1-agreement` checks that every node holds the same block 1.

Denomination: stakes and balances are compared in the unit the node stores. The
osDenomination migration (x 10^9) runs at block 0, before genesis validators
are seeded, when its effective height (the genesis entry, or the code default
0 when the entry is absent) is 0 and the snapshot is not already migrated; an
already migrated snapshot under any other height is refused
(`src/libs/blockchain/genesis/applyForksAtGenesis.ts:92-118`). At a later
height it runs through the block hook over every row
(`src/libs/blockchain/chainBlocks.ts:420-440`). A value off by exactly 10^9 is
named as such. The node replies with amounts as decimal strings, and any other
shape is reported as unreadable.

A node answers state for its tip only. So the validator and balance comparison
runs only while every block after block 0 is empty and the head is within
`--max-scan` (default 20). Otherwise those two lines read `SKIP` with the
reason. If any node could not be checked in full (block 1 unread, or its
state skipped), the result is inconclusive (exit 3), even when the others
pass: every launch validator has to be proven.

Exit codes: 0 PASS, 1 FAIL, 2 bad input, 3 inconclusive. The check reads what
each node reports about itself. It is run against every launch validator, so
one node with a different state shows up as that node's failure.
