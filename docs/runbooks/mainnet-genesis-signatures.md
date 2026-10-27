# Mainnet genesis: transaction signatures bound to the chain

A transaction signed for devnet or testnet must be rejected by a mainnet node.
That only holds if the mainnet genesis file says two things. The repository has
no mainnet genesis yet, so this is the checklist for the file when it is written.

## The two requirements

1. **A unique `properties.id`.** An integer that no other Demos network uses.
   Taken: `1` (the `data/genesis.json` shipped in the repository and the
   rehearsal fixtures), `1337` (the devnet), `31337` (the fork rehearsal
   default). Two networks that share an id give each other's signatures no
   protection.
2. **`signatureDomain` scheduled at height 0.**

```json
{
  "properties": { "id": <unique integer> },
  "forks": { "signatureDomain": { "activationHeight": 0 } }
}
```

Both are needed. The fork defaults to inactive (`activationHeight: null`), and
while it is inactive the signed bytes are the bare transaction hash, which names
no network: the same signature verifies on every chain that shares the account.
With the fork active from block 0 the signed bytes are
`demos-tx:v1:<chainId>:<hash>`, so a signature made for another id fails to
verify, at admission and when a block is re-checked at its own height.

The node refuses to boot when `signatureDomain` is scheduled and `properties.id`
is missing or not an integer, so a half-written file cannot start.

## Verify the file before it ships

```bash
jq -e '
  (.properties.id | type == "number" and . == floor)
  and (.properties.id != 1 and .properties.id != 1337 and .properties.id != 31337)
  and (.forks.signatureDomain.activationHeight == 0)
' genesis.json
```

It prints `true` and exits 0 only when both requirements hold.

Then check what a booted node reports. `getNetworkInfo` must return
`chainId` equal to the file's id and `forks.signatureDomain.activationHeight`
equal to `0`, identically on every validator and RPC node (same
`forkScheduleDigest`).

## Rehearse it

`testing/forks/rehearsal.sh` boots a 4-validator devnet from a genesis built
with these two fields and checks what the nodes accept and refuse around the
height (see `testing/forks/REHEARSAL.md`). Run it with the mainnet candidate id
and a non-zero height, so the checks before and after the height both execute:

```bash
CHAIN_ID=<mainnet id> ACTIVATION_HEIGHT=30 ./testing/forks/rehearsal.sh
```

The rehearsal's wrong-chain case (a signature made for `CHAIN_ID + 1`) is the
replay this setup exists to stop. For height 0 specifically, the unit tests are
the rehearsal: `bun test testing/forks/crossNetworkReplay.test.ts` boots nodes
from genesis files and shows a signature for id 1 refused by a node with id 1337,
and `bun test testing/forks/loadForkConfig.test.ts` covers the boot refusal.

## What clients need

The SDK and the wallet must sign `demos-tx:v1:<chainId>:<hash>` with the chain id
from `getNetworkInfo`. `testing/vectors/tx-signing-vectors.v1.json` holds the
positive and negative vectors both must pass.
