# Demos Network RPC Software

**_Extremely Important Note:_** Before opening any issues, please ensure you have read this README.md file and have followed all the instructions. Focus especially on the [Usage](#usage) section.

**_Disclaimer:_** This software is currently in an early development stage and is not yet ready for production use. The software is not stable and is missing many features that are essential for a production-ready node. Use at your own risk.

# Table of Contents

-   [Demos Network RPC Software](#demos-network-rpc-software)
-   [Table of Contents](#table-of-contents)
    -   [Description](#description)
    -   [Hardware and software requirements](#hardware-and-software-requirements)
        -   [Hardware](#hardware)
            -   [Minimum](#minimum)
            -   [Recommended](#recommended)
        -   [Software and System](#software-and-system)
        -   [Installation](#installation)
            -   [Required Software Versions](#required-software-versions)
            -   [Verification](#verification)
            -   [Ubuntu/Debian Installation](#ubuntudebian-installation)
            -   [Arch Linux Installation](#arch-linux-installation)
            -   [macOS Installation](#macos-installation)
        -   [First-Time Setup](#first-time-setup)
    -   [Usage](#usage)
        -   [Configuration](#configuration)
            -   [The .env file](#the-env-file)
            -   [The demos_peerlist.json file](#the-demos_peerlistjson-file)
        -   [Running](#running)
    -   [Troubleshooting](#troubleshooting)
        -   [Common Issues](#common-issues)
            -   [Node software not starting](#node-software-not-starting)
            -   [Network Connectivity Issues](#network-connectivity-issues)
            -   [Database Issues](#database-issues)
        -   [Cleaning the database](#cleaning-the-database)
        -   [Clearing and reinstalling dependencies](#clearing-and-reinstalling-dependencies)
    -   [License](#license)

## Description

This repository contains the official implementation of the Demos Network RPC software.
The included software follows the Demos Network specifications and can be used as a node for the Demos Network.

## Hardware and software requirements

### Hardware

#### Minimum

-   4GB RAM
-   4 modern CPU cores (min 2ghz, physical cores or vcpu)
-   A modern SSD
-   200mbit/s down/up internet connection

#### Recommended

-   8gb RAM
-   6 modern CPU cores (min 2ghz, physical cores)
-   A modern SSD
-   1gbit/s down/up internet connection

### Software and System

-   Linux, MacOS or WSL2 on Windows (Ubuntu LTS > 22.04 recommended)
-   Node.js 20.x or later (might work on other versions, but this is the only one that is guaranteed to work)
-   Bun (required for package management and running the node)
-   Docker and docker compose
-   Port 5332 (PostgreSQL) and 53550 (Node) must be available

### Installation

#### Required Software Versions
- Node.js: 20.x or later
- Docker: Latest stable version
- Docker Compose: Latest stable version
- Bun: Latest stable version

#### Verification
After installation, verify your setup with:
```bash
node --version  # Should show v20.x.x
docker --version  # Should show latest Docker version
docker compose version  # Should show latest Docker Compose version
bun --version  # Should show latest Bun version
```

#### Ubuntu/Debian Installation
```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Docker
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add user to Docker group
sudo groupadd docker || true
sudo usermod -aG docker $USER
# Note: You'll need to log out and back in for the Docker group changes to take effect

# Install Bun
curl -fsSL https://bun.sh/install | bash
# Add Bun to your shell (you may need to restart your terminal or run 'source ~/.bashrc')
```

#### Arch Linux Installation
```bash
# Install Node.js 20.x
sudo pacman -S nodejs

# Install Docker
sudo pacman -S docker docker-compose

# Start and enable Docker service
sudo systemctl start docker
sudo systemctl enable docker

# Add user to Docker group
sudo groupadd docker || true
sudo usermod -aG docker $USER
# Note: You'll need to log out and back in for the Docker group changes to take effect

# Install Bun
curl -fsSL https://bun.sh/install | bash
# Add Bun to your shell (you may need to restart your terminal or run 'source ~/.bashrc')
```

#### macOS Installation
```bash
# Using Homebrew
brew install node@20
brew install docker docker-compose
brew install oven-sh/bun/bun
# Add Bun to your shell (you may need to restart your terminal or run 'source ~/.zshrc')
```

### First-Time Setup

1. Clone this repository
2. Install dependencies:
```bash
bun install
```
3. Generate a new identity (if it doesn't exist):
```bash
bun run keygen
```
This will create:
- `public.key`: Contains your public key
- `.demos_identity`: Contains your private key (keep this secure!)

4. Configure your environment:
```bash
cp env.example .env
cp demos_peerlist.json.example demos_peerlist.json
```

5. Edit the configuration files as described in the [Configuration](#configuration) section below.

## Usage

### Configuration

#### The .env file

This file contains the environment variables for the node software. You can probably leave most of them as they are, but you will need to change the following:

-   `EXPOSED_URL`: This is the URL that the node software will be exposed to the network. This should be a public URL that points to the machine running the node software. If you are running the node software on the same machine as the client, you can use `http://localhost:53550`. If you are running the node software on a different machine, you can use the public IP address of that machine (for example `http://1.2.3.4:53550`). If you are running the node behind a reverse proxy, you can use the public URL of the proxy server (as in `https://demos.example.com`). _IMPORTANT NOTE: The URL must start with `http://` or `https://` and the port must be included if needed. Setting this value incorrectly will make the node software unable to connect to the network._

#### The demos_peerlist.json file

This file contains the list of peers that the node software will try to connect to. If you want to test the node locally (connecting to yourself), you can start the node software and, upon the first run, replace the **_identity_** key in the file with the public key of your node (found in `publickey_yourkey`). Else, you should add the peers you know to the file and, once the node software is started, it will automatically connect to the peers (format: `"publickey": "connectionstring"`).

Example:

```json
{
    "6f1df0905c986d41bcb01c8b542c0af8263c03ba52a3dd3af9123d99fc8e1067": "http://127.0.0.1:53550"
}
```

### Running

Before starting, ensure:
1. Docker service is running:
```bash
# Check Docker status
docker info
# If not running, start it:
# Ubuntu/Debian:
sudo systemctl start docker
# macOS:
open -a Docker
```

2. Required ports are available:
```bash
# Check if ports are in use
sudo lsof -i :5332
sudo lsof -i :53550
```

Run the node:
```bash
bun install # To install the dependencies
./run # To both start the database and the node software
```

You must ensure that the port for the node software and the postgres database are free.
By default, the node software will run on port 53550 and the postgres database will run on port 5332.
By following the instructions below, you can run multiple nodes on the same machine for testing purposes too.
You can change the port for the node software and the postgres database by using the following arguments:

`./run [-p <port> -d <postgres port> -i <identity file> -c -n]`

-   `-p <port>`: The port for the node software
-   `-d <postgres port>`: The port for the postgres database
-   `-i <identity file>`: The identity file to use
-   `-c`: Cleans the database
-   `-n`: Does not perform a git pull, useful if you want to use a custom branch or want to avoid pulling the latest changes from the repository

**_NOTE:_** Without arguments, the default port (and folder) for the postgres database is 5332.
**_NOTE:_** Without arguments, the default port for the node software is 53550.
**_NOTE:_** Without arguments, the default identity file is `.demos_identity`. If the file does not exist, it will be created.
**_NOTE:_** Without the `-n` flag, the repository will be updated to the latest changes every time the script is run (recommended behavior)

While the script should be able to manage both the database and the node software, in case of any issue you might want to stop the database manually once the node software is terminated:

```bash
cd postgres_(the port you chose)
./stop.sh
```

## Troubleshooting

### Common Issues

#### Node software not starting
If the node software is not starting, try these steps in order:

1. Check Docker status:
```bash
docker info
```

2. Check if ports are available:
```bash
sudo lsof -i :5332
sudo lsof -i :53550
```

3. Check the logs:
```bash
# Node logs
tail -f logs/node.log

# Database logs
cd postgres_(the port you chose)
tail -f postgres.log
```

4. Try restarting the database:
```bash
cd postgres_(the port you chose)
./start.sh
cd ..
bun start
```

#### Network Connectivity Issues
If you're having trouble connecting to peers:

1. Check your firewall settings:
```bash
# Ubuntu/Debian
sudo ufw status
# If needed, allow the ports:
sudo ufw allow 53550/tcp
```

2. Verify your EXPOSED_URL in .env is correct and accessible

3. Check peer connectivity:
```bash
# Test connection to a peer
curl -v http://<peer-address>:53550/health
```

#### Database Issues
If you're having trouble with the database:

1. Check the logs:
```bash
cd postgres_(the port you chose)
tail -f postgres.log
```

2. Try restarting the database:
```bash
cd postgres_(the port you chose)
./start.sh
```

### Cleaning the database

If you want to clean the database, you can run the following command:

```