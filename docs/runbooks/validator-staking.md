---

## type: runbook
title: Validator Staking, Unstaking and Exit
date: 2026-11-11
status: active

# Validator Staking, Unstaking and Exit

A validator seat is a stake of at least 1000 DEM backed by a Demos Node NFT.
The NFT stays in your Solana wallet; you prove you hold it with one signed
Solana transaction, then stake from the node's identity. This runbook walks
through the whole lifecycle: proof, stake, top-up, unstake, exit, and what
happens if the NFT leaves your wallet.

Every command below runs from the node's checkout directory and signs with
the node's identity file (`.demos_identity`, or `--identity <file>`).

## Before you start

- The node is running, synced, and reachable on its public URL.
- `HELIUS_API_KEY` is set in `.env`. The node refuses to start without it; it
verifies proofs against Solana and relays the staking page's lookups.
- The Solana wallet that holds the Node NFT, with a little SOL for one
transaction fee. The mint must be on the node's allowlist
(`data/nft-allowlist.json`).
- `EXPOSED_URL` is set in `.env`. The stake records it as your validator's
connection URL and refuses to run without a valid one. `--rpc` only picks
the node the transaction is submitted through; without it the script takes
the first entry of `demos_peerlist.json`.

Seat states, as `getValidatorInfo` reports them:


| Status    | Code | Meaning                                             |
| --------- | ---- | --------------------------------------------------- |
| active    | `2`  | Holds a seat and signs blocks                       |
| unstaking | `3`  | Asked to leave; still seated until the lock elapses |
| exited    | `0`  | No seat; a new proof is needed to re-enter          |




## 1. Prove the NFT

The proof is one Solana transaction signed by the wallet that holds the NFT:
a transfer of the NFT from your token account to that same account, plus a
memo `demos-validator:<your node address>`. The NFT does not move. The node
records the signed bytes on Demos and an anchor node sends them to Solana.

Pick one of the two ways.

### A. Browser wallet on the staking page

The node serves the page at `http://<node url>/staking` while it holds no
seat. Once seated the page answers 404.

1. Open the page. It shows the node's validator address.
2. Connect a wallet. Phantom, Solflare, Backpack, MetaMask and other Wallet
  Standard wallets are listed.
3. Pick the Node NFT from the list, or paste its mint.
4. Press **Sign proof** and approve the transaction in the wallet. The page
  waits for Solana finality, up to three minutes, then prints the exact
   stake command. **Copy command** copies it.

**Phantom needs https or localhost.** Phantom refuses to connect on a plain
http page unless the host is `localhost` or `127.0.0.1`. The other wallets
listed above connect over http. For Phantom, tunnel the node's RPC port to
your machine and open the page through the tunnel:

```sh
ssh -N -L 53550:127.0.0.1:53550 <user>@<node host>
```

Then open `http://localhost:53550/staking`. Replace `53550` with the node's
`RPC_PORT` if you changed it. With a password login, ssh asks for the
password and nothing else is needed. For a Docker node the port is published
on the host, so the same tunnel works. Leave the ssh session open until the
page prints the stake command.

### B. Command line with a key file

```sh
bun run validator:nft-proof --mint <MINT> --keypair <key file>
```

The key file is a `solana-keygen` JSON byte array, a base58 private key as
exported by Phantom or Solflare, or a BIP-39 mnemonic (`--account <n>` picks
the account index). The command waits for Solana finality and prints the
stake command.

To prove and stake in one step:

```sh
bun run validator:stake --amount 1000 --nft-mint <MINT> --solana-keypair <key file>
```



## 2. Stake

```sh
bun run validator:stake --amount 1000 --nft-proof <solana signature>
```

The node checks, against Solana, that the proof is finalized, was signed by
the wallet that holds the NFT, names this node's address in its memo, and is
less than a day old. Make the proof and stake on the same day; an older proof
is refused and you sign a new one. The mint must be on the allowlist and the
wallet must still hold the NFT when the stake is confirmed.

If another validator's seat is backed by the same NFT, your stake evicts it:
the newer proof wins. The reverse also holds, so keep the NFT where it is.

### Top-up

The same command without a proof adds to an existing seat:

```sh
bun run validator:stake --amount 500
```

A top-up must not carry `--nft-proof`. Topping up while unstaking cancels the
unstake and makes the seat active again.

## 3. Unstake

```sh
bun run validator:unstake
```

The seat must be active with no unstake already requested. The status
becomes `unstaking` and a lock of `UNSTAKE_LOCK_BLOCKS` blocks starts (1000
on mainnet). During the lock the node keeps its seat and keeps signing. The
NFT is still bound to the seat, so a transfer out of the wallet during the
lock can still be challenged.

## 4. Exit

```sh
bun run validator:exit
```

Accepted only when the status is `unstaking` and the lock has elapsed. The
seat closes, the recorded stake goes to zero, and the status becomes
`exited`. Re-entering later needs a fresh proof and a full stake.

## If the NFT leaves your wallet

Any node can challenge a seat whose NFT was transferred out of the recorded
wallet after the proof:

```sh
bun run validator:challenge --validator <0x...> --transfer <solana signature>
```

The node verifies the transfer on Solana and the seat closes at once, with
no lock. Moving the NFT between two token accounts of the same wallet does
not count as leaving. Keep the NFT in the proving wallet for as long as you
hold the seat; to hand the seat to a new address, move the NFT and let the
new holder prove and stake, which evicts the old seat.

## Checking the seat

Ask any node for `getValidatorInfo` with the validator address (the SDK
exposes it as `demos.getValidatorInfo(address)`), or `getValidators` for the
whole set. The reply carries the status, the staked amount, the unstake
block numbers and the NFT mint, wallet and proof signature on record.

## Common refusals


| Message                                                           | Cause                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `proof ... names 0x..., not this node's address`                  | The proof was signed for another node address; sign a new one from this node's page or identity |
| `NFT ... is not eligible`                                         | The mint is not on the allowlist                                                                |
| `NFT ownership rejected: nft.owner no longer holds the NFT`       | The NFT left the proving wallet                                                                 |
| `NFT proof could not be verified: ...`                            | No Solana endpoint answered; retry, check `HELIUS_API_KEY` or `SOLANA_RPC`                      |
| `A top-up cannot carry an NFT proof`                              | Drop `--nft-proof`; the seat already exists                                                     |
| `An allowlisted node NFT proof is required to become a validator` | The node has no seat and the stake carried no proof                                             |
| `Lock not elapsed`                                                | Exit sent before `unstake_available_at`; wait                                                   |
| `Validator must be unstaking before exit`                         | Unstake first                                                                                   |
| Staking page answers 404                                          | The node already holds a seat                                                                   |
| Page shows no wallets                                             | On http, Phantom hides itself; use the tunnel above or another wallet                           |


