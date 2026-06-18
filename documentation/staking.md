# Validator Staking

Pull the latest changes by running the following commands in the node source directory:

```sh
git checkout stabilisation

git pull

bun install
```

For a node to participate in the consensus, they need to stake DEM. Get your node public key by running the following command:

```sh
bun run show:pubkey

# or

cat publickey*
```

Head over to https://faucet.demos.sh and paste your public key to get 2400 DEM.

## Staking

Update your node's `demos_peerlist.json` to look like this:

```json
{
    "0x24c664d9ef529f798e979357c6a7a01088226eefe05cfdb77fb42841f771e156":"http://node3.demos.sh:53550"
}
```

Run the following command in the node source folder to stake the DEM you acquired:

```sh
bun run validator:stake
```

## Restarting your node

Update your `.env` file to include your exposed URL

```
EXPOSED_URL=http://<your-ipaddress>:53550

# other keys here
```

Then restart your node by running the following command:

```sh
./run --docker --clean --build
```

This will run the node with the new Docker workflow. The `--clean` flag delete existing databases.

## TIPS

You can customize the amount (in DEM) using the `--amount` flag:

```sh
bun run validator:stake --amount 1200
```

To run the node without deleting the database:

```sh
./run --docker --build
```