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

## Usage

Clone the repository and run the following command:

```bash
yarn # To install the dependencies
./run # To both start the database and the node software
```
You must ensure that the port for the node software and the postgres database are free.
By default, the node software will run on port 53550 and the postgres database will run on port 5332.
You can change the port for the node software and the postgres database by using the following arguments:

`./run -p <port> -d <postgres port> -c`

- `-p <port>`: The port for the node software
- `-d <postgres port>`: The port for the postgres database
- `-c`: Cleans the database

***NOTE:*** Without arguments, the default port (and folder) for the postgres database is 5332.
***NOTE:*** Without arguments, the default port for the node software is 53550.

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