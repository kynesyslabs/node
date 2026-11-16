---
type: runbook
title: Genesis key custody (treasury, allocations, sudo key)
date: 2026-11-17
status: draft
---

# Genesis key custody

The mainnet genesis names three kinds of keys that hold value or authority
from block 0:

| Key | Where the genesis names it | What it controls |
|---|---|---|
| Treasury | `forks.gasFeeSeparation.treasuryAddress` | the treasury share of every fee from block 0 |
| Allocation keys | `balances` | each starting balance |
| Award key | `properties.sudoPubkey` | award transactions (points) |

Under `identityCarryover` block 0 imports testnet accounts with every balance
at 0, so the total supply is exactly the sum of `balances`
([genesis-import.md](../mainnet/genesis-import.md)). A balance published to a
key nobody controls is lost for good: the genesis cannot change after it is
published ([genesis-hash.md](../mainnet/genesis-hash.md), "The 24 h rule").

Validator keys follow [validator-key.md](validator-key.md). Release signing
keys follow [release-signing-key.md](release-signing-key.md).

## The private custody record

Holder names, contact details and backup locations never go into this
repository. They go into one private custody record kept by the genesis
owner. For each key it holds:

- the address (`0x` + 64 lower-case hex);
- the role (treasury, allocation, award key);
- the starting balance in OS, with the DEM figure beside it;
- the holder and the recovery holder (a second person);
- where the encrypted backup is, and who holds its passphrase;
- the date and result of the proof of control (below).

| Field | Value |
|---|---|
| Genesis owner (keeps the record, signs off the allocation list) | TBD (owner) |
| Treasury holder | TBD (owner) |
| Treasury recovery holder | TBD (owner) |
| Award key (`sudoPubkey`) holder | TBD (owner) |
| Allocation list sign-off date (at the latest T-24 h, before publication) | TBD (owner) |

## Rules for every key

1. **Fresh key.** Generate a new key for mainnet. Never reuse a key that was
   used on testnet, a devnet or a rehearsal chain. The launch tools refuse a
   treasury other than the agreed one (`launch-go-no-go.ts
   --expected-treasury`), but they cannot tell a reused key from a fresh one.
2. **Offline generation.** Generate the key on a trusted machine that is not
   a validator host and, where possible, not connected to a network. From a
   checkout of the release tag:

   ```bash
   IDENTITY_FILE=<path to the new key file> bun run keygen
   ```

   `keygen` writes a new mnemonic to `IDENTITY_FILE` with mode `600` and never
   overwrites an existing file. It prints no mnemonic and no private key. It
   writes the public key as bare hex to `public.key` in the working
   directory; the address is `0x` followed by that hex, in lower case.
3. **File mode.** The key file stays `600`, owned by the holder, in a
   directory other users cannot read.
4. **Encrypted backup.** Keep one encrypted copy off the machine (for example
   with age or gpg). The backup and its passphrase are held by different
   people, and the recovery holder is one of them.
5. **No copies in transit.** Never put a mnemonic in chat, tickets, email,
   shell history or logs. Send only the address to the genesis owner.
6. **Address format.** Lower-case `0x` + 64 hex. The genesis tools refuse
   mixed case and duplicates (`mergeGenesisBalances.ts`, `genesisPin.ts`).

## Proof of control before publication

Before the genesis record is published, every allocation address and the
treasury prove that their holder controls the key. This is a blocking step:
a genesis is not published while any proof is missing.

The proof is a **signed challenge**: the holder signs a fixed text with the
key and sends the signature and the address. No transaction is ever sent
with a mainnet key before launch, not even on a devnet: that would break the
fresh-key rule above. `scripts/validator-prove-signing.ts` signs with any
identity file:

```bash
bun scripts/validator-prove-signing.ts --genesis-hash <genesis block hash> \
  --identity-file <key file> --out proof.json
```

It signs `demos-launch-proof:<genesis block hash>:<date>`, prints no secret,
and writes `{ identity, algorithm, challenge, signature }`. Its `--verify`
mode accepts only launch validators, so it cannot check these proofs. No
script in the repository verifies a proof for a non-validator address: the
genesis owner checks each one by hand with the SDK's ed25519 verify
(`ucrypto.verify`) against the address, and records the result.

Pass: every proof verifies, and the custody record
names the holder of every address.

## Rotation

The treasury address and `sudoPubkey` are in the genesis. Changing either
after publication means a new genesis, new hashes and a new 24 h window
before launch. After launch, no supported procedure moves them: the treasury
receives fees at the address in block 0. Rotate an allocation key after
launch by sending the balance to a new key generated under the same rules.

## Loss or exposure

- **Lost key, backup intact.** The recovery holder restores from the
  encrypted backup on a trusted machine. Make a new backup.
- **Lost key and backup.** Before publication: replace the address in the
  allocation list and run the proof of control again. After publication or
  launch: the balance cannot be recovered. Tell the genesis owner.
- **Exposed key (mnemonic seen by someone else).** Before publication:
  replace the address. After launch: move the balance to a fresh key at
  once. An exposed treasury or award key after launch is a security incident:
  the genesis owner decides the response, which may need an emergency
  release ([chain-halt-recovery.md](chain-halt-recovery.md), tier 2).
