# Demos Network RPC Software

## Description

This repository contains the official implementation of the Demos Network RPC software.
The included software follows the Demos Network specifications and can be used as a node for the Demos Network.

## Prerequisites

### Hardware

#### Minimum

- 4GB RAM
- 4 modern CPU cores (min 2ghz, physical cores or vcpu)
- A modern SSD
- 200mbit/s down/up internet connection

#### Recommended

- 8gb RAM
- 6 modern CPU cores (min 2ghz, physical cores)
- A modern SSD
- 1gbit/s down/up internet connection

### Software and System

- Linux, MacOS or WSL2 on Windows (Ubuntu LTS > 22.04 recommended)
- Node.js 20.x or later (might work on other versions, but this is the only one that is guaranteed to work)
- Yarn (npm might work, but yarn is recommended)
- Docker and docker compose
- Port 5332 free

#### Tips for a correct installation

- To ensure the Node.js version is correct, you can run the following command:

```bash
npm install -g n
n 20
```

## Prerequisites

The client uses two main files that are required for its functioning:

- `.env`
- `demos_peerlist.json`

You can copy `env.example` and `demos_peerlist.json.example` to `.env` and `demos_peerlist.json` respectively.

### The .env file

This file contains the environment variables for the node software. You can probably leave most of them as they are, but you will need to change the following:

- `EXPOSED_URL`: This is the URL that the node software will be exposed to the network. This should be a public URL that points to the machine running the node software. If you are running the node software on the same machine as the client, you can use `http://localhost:53550`. If you are running the node software on a different machine, you can use the public IP address of that machine (for example `http://1.2.3.4:53550`). If you are running the node behind a reverse proxy, you can use the public URL of the proxy server (as in `https://demos.example.com`). *IMPORTANT NOTE: The URL must start with `http://` or `https://` and the port must be included if needed. Setting this value incorrectly will make the node software unable to connect to the network.*

### The demos_peerlist.json file

This file contains the list of peers that the node software will try to connect to. If you want to test the node locally (connecting to yourself), you can start the node software and, upon the first run, replace the ***placeholder*** in the file with the public key of your node (found in `publickey_yourkey`). Else, you should add the peers you know to the file and, once the node software is started, it will automatically connect to the peers (format: `"publickey": "connectionstring"`).


## Usage

Clone the repository and run the following command:

```bash
yarn # To install the dependencies
./run # To both start the database and the node software
```
You must ensure that the port for the node software and the postgres database are free.
By default, the node software will run on port 53550 and the postgres database will run on port 5332.
By following the instructions below, you can run multiple nodes on the same machine for testing purposes too.
You can change the port for the node software and the postgres database by using the following arguments:

`./run [-p <port> -d <postgres port> -i <identity file> -c -n]`

- `-p <port>`: The port for the node software
- `-d <postgres port>`: The port for the postgres database
- `-i <identity file>`: The identity file to use
- `-c`: Cleans the database
- `-n`: Does not perform a git pull, useful if you want to use a custom branch or want to avoid pulling the latest changes from the repository

***NOTE:*** Without arguments, the default port (and folder) for the postgres database is 5332.
***NOTE:*** Without arguments, the default port for the node software is 53550.
***NOTE:*** Without arguments, the default identity file is `.demos_identity`. If the file does not exist, it will be created.
***NOTE:*** Without the `-n` flag, the repository will be updated to the latest changes every time the script is run (recommended behavior)

While the script should be able to manage both the database and the node software, in case of any issue you might want to stop the database manually once the node software is terminated:

```bash
cd postgres_(the port you chose)
./stop.sh
```

## Troubleshooting

### Node software not starting

If the node software is not starting, you can try to run the following command:

```bash
cd postgres_(the port you chose)
./start.sh
cd ..
yarn start
```

Remember to stop the database once the node software is terminated:

```bash
cd postgres_(the port you chose)
./stop.sh
```

### Cleaning the database

If you want to clean the database, you can run the following command:

```bash
cd postgres_(the port you chose)
./clean.sh
```

### Clearing and reinstalling dependencies

You can clear all the dependencies and start from scratch by running the following command:

```bash
rm -rf node_modules
rm -rf yarn.lock
yarn
```

## License

This project is licensed under the CC BY-NC-SA 4.0 license - see the LICENSE file for details