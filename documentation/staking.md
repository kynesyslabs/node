### Prerequisites

Make sure you have the following tools installed in your Linux system:

1. [Docker](https://docs.docker.com/desktop/setup/install/linux)
2. [Bun](https://bun.com/docs/installation)

Confirm these are set up correctly by running these verification commands:

```sh
bun --version

systemctl status docker
```

> [!IMPORTANT]
> Follow the [Docker post-installation instructions](https://docs.docker.com/engine/install/linux-postinstall/), then restart your server to be able to delete folders created by Docker without using `sudo`.

## 1. Initial Setup

Clone the node:

```sh
git clone https://github.com/kynesyslabs/node.git
```

Then, change into the node folder and install dependencies:

```sh
cd ./node

# switch into the active branch
git checkout stabilisation

bun install
```

# Validator Staking

Pull the latest changes by running the following commands in the node source directory:

```sh
git checkout stabilisation

git pull

bun install
```

If the checkout has local changes, stop and review them before updating; do
not discard them as part of the staking procedure.

For a node to participate in the consensus, they need to stake DEM. Get your node public key by running the following command:

```sh
bun run show:pubkey
```

Head over to https://faucet.demos.sh and paste your public key to get 2400 DEM.

## Staking

Obtain the current network RPC from the network coordinator. The RPC submits
the stake transaction; it is not the public URL that other validators use to
reach your node.

Run the following command in the node source folder, passing both URLs
explicitly:

```bash
bun run validator:stake \
  --rpc <network-rpc> \
  --connection-url http://<your-ipaddress>:53550
```

The command does not need `demos_peerlist.json` when `--rpc` is supplied. It
never advertises the network RPC as your validator endpoint. If
`--connection-url` is omitted, the command uses `EXPOSED_URL` and otherwise
fails before creating a transaction.

## Starting your node

Update your `.env` file to include your exposed URL

```
EXPOSED_URL=http://<your-ipaddress>:53550

# other keys here
```

Then start your node by running the following command:

```sh
./run --docker --clean --build
```

This will run the node with the new Docker workflow. The `--clean` flag deletes existing databases.

After your node is up and running (wait for debug prints), open `http://<your-ip>:53550/info` and confirm that `commitMessage` reads as `put back validators`.

## TIPS

You can customize the amount (in DEM) using the `--amount` flag:

```sh
bun run validator:stake --amount 1200 \
  --rpc <network-rpc> \
  --connection-url http://<your-ipaddress>:53550
```

To run the node later on without deleting the database:

```sh
./run --docker --build
```
