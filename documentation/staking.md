# Validator Staking

For a node to participate in the consensus, they need to stake DEM.

Get your node public key by running the following command in the node source folder:

```sh
bun install

# then
bun run show:pubkey

# or

cat publickey*
```

Head over to faucet.demos.sh and paste your public key to get 1000 DEM.

## Staking

Run the following command in the node source folder to stake the DEM you acquired:

```sh
bun run validator:stake
```

You can customize the amount (in DEM) using the `--amount` flag:

```sh
bun run validator:stake --amount 2000
```

## Unstaking

Run the following command to unstake:

```sh
bun run validator:unstake
```

Note: Upon unstaking, your node will no longer participate in the consensus.