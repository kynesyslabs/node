## Joining the DEMOS fixnet

This document will guide you to setup your DEMOS node and have it join the DEMOS fixnet (a debug network for testing proper node setup and investigating bugs).

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

Your node should be able to run at this point. Confirm this by running the following command:

```sh
./run
```

This should setup all the Docker containers needed and run the node on <http://127.0.0.1:53550>. You can check the node info by checking <http://127.0.0.1:53550/info>.

To access the node outside your server, open ports `53550` (for node queries and transactions) and `53551` (for internode communication). You should then be able to access your node on `http://<your-server-ip>:53550/info`.

Confirm you can access your node on the internet before proceeding.

## 2. Joining the Fixnet

Stop your running node using `CTRL + C`, then update your `.env` file to look like this:

```sh
PROD=true
```

You can check the `.env.example` file for other environment variables you would want to configure.

Then create a `demos_peerlist.json` file. This should contain a JSON map of an anchor node's ed25519 public key to its remote URL.

```json
{
  "0x680464e81ff8a088611d91eb97c40326dc3d8981bd29cf2721b47daa60f56274": "http://node3.demos.sh:20002"
}
```

Delete your database folder created from the first node run using:

```sh
rm -rf postgres_5332
```

If you get the error: `rm: cannot remove 'postgres_5332/data_5332/postgres': Permission denied`, repeat the command with `sudo`.

```sh
sudo rm -rf postgres_5332
```

To make starting the node easier, create a `fnode.sh` script with the following contents:

```sh
./run -c false -u http://<your-server-ip>:53550 -t true
```

The flags are configure as follows:

| Flag                               | Description                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `-c false`                         | Don't delete the database folder                                                                       |
| `-u http://<your-server-ip>:53550` | Configures your exposed URL, i.e. the node's internet URL (required to connect to an external network) |
| `-t true`                          | Disables the DEMOS Terminal UI for easier debugging                                                    |

Then make the script executable:

```sh
chmod +x ./fnode.sh
```

Finally, run the node script to start your node:

```sh
./fnode.sh
```

Your node should start and join the network. You can confirm that by checking the [`/info` endpoint of the anchor node](http://node3.demos.sh:20002/info) or any other node on the network. It should take some time to sync existing blocks depending on the block height. After the blocks have synced, your node will be eligible to contribute to the consensus.

---

### Demos Networks

There are 3 DEMOS networks:

1. Fixnet - For first-time joiners, used to test connectivity and catch bugs & crashes that might happen due to new environments.
2. Devnet - A fork of the public testnet with real transaction activity. For testing full node activity on node runners intending to join the public testnet.
3. Public testnet - The main DEMOS network.

> [!NOTE]
> Your node will run in the fixnet for sometime (to confirm stability), then we'll move it to the devnet and finally the testnet.

<!-- --- -->

<!-- ## 3. Switching Networks

Here are the `demos_peerlist.json` contents for the various networks:

1. Fixnet:

```json
{
  "0x680464e81ff8a088611d91eb97c40326dc3d8981bd29cf2721b47daa60f56274": "http://node3.demos.sh:20002"
}
```

2. Devnet:

```json
{
  "0xd17624072cb243567b9699cee0fef34c324298b1fb4e9361e284b3cf4091d98a": "http://node2.demos.sh:53560"
}
```

3. Public testnet:

```json
{
  "0xc8bc5866fecf583bc1232f04fa54fd2c5a6f7c15b91c517ac60f468cdc0b8c82": "http://node2.demos.sh:53550"
}
```

To switch from one network to another, update your `demos_peerlist.json` file to the new network's, remove your database folder, then restart your node with the node script.

> [!IMPORTANT]
> The networks are arranged in the following order: `FIXNET -> DEVNET -> PUBLIC TESTNET`.
>
> If you are looking to join a network for the first time, please do not join a network without joining the one before it for at least 4 days. ie. Join fixnet, wait 4 days, if your node is still up and running, stop it and join the Devnet. To join the public testnet, join the Devnet, wait 4 days, then join the public testnet.
>
> The run period allows you to confirm your node is set up properly and there are no unexpected bugs or crashes that might occur.
>
> If crashes occur, the issue will be investigated and the fix propagated to the other networks. -->
