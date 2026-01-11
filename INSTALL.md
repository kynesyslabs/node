# 🚀 Demos Node Installation Guide

**Welcome to the Demos Network!** This guide will help you set up a Demos node on Linux Debian (Ubuntu)-based systems. It walks through the installation steps—including the installation of dependencies—in more detail and is intended to help less experienced users get through the process.

After installing the required Linux operating system on a bare metal or computer running the required hardware specs, you can simply copy and paste each line into your Linux system’s terminal. Note that lines with hashtags are comments; they do not need to be pasted into the terminal.

## 📋 System Requirements

### Operating System

Install a Debian-based Linux distro like Ubuntu: [https://ubuntu.com/download/desktop](https://ubuntu.com/download/desktop)

Each computer’s hardware can behave differently during Ubuntu installation. This may require a bit of troubleshooting on your end, but is not covered by this guide, as the main focus of this guide is specific to Demos node installation.

### Hardware Minimum Requirements

-   4GB RAM
-   4 CPU cores (2GHz+)
-   Modern SSD
-   200 Mbps internet connection
-   Ubuntu 22.04 LTS or newer (or compatible Linux distribution)

### Hardware Recommended Specs

-   8GB RAM
-   6 CPU cores (2GHz+)
-   Modern SSD
-   1 Gbps internet connection

## ⚡ Installation Steps - Short Version

This is the abridged installation guide. If this works for your system and allows the node to operate, then you are done here. If this results in errors, proceed to the full installation guide, which walks you through additional steps. All steps will require the use of the terminal.

### 1. Install Prerequisites

Open a terminal and enter:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git wget build-essential ca-certificates gnupg lsb-release
```

### 2. Install the Following Packages

-   **Install Docker and docker-compose for non-root users**
    -   Docker: [https://docs.docker.com/get-started/get-docker/](https://docs.docker.com/get-started/get-docker/)
    -   Docker Compose: [https://docs.docker.com/compose/install/](https://docs.docker.com/compose/install/)
-   **Install Bun**
    -   We suggest managing bun with mise ([https://mise.jdx.dev/getting-started.html](https://mise.jdx.dev/getting-started.html) and `mise use -g bun@latest`) for convenience

### 3. Clone the Repository

```bash
cd ~
git clone https://github.com/kynesyslabs/node.git
# Double check that you are on testnet branch
git branch
# switch to your node directory
cd node
```

### 4. Install Dependencies

```bash
# Install all dependencies (requires Rust/Cargo for wstcp)
./install-deps.sh
```

> **Note:** The install script requires [Rust](https://rustup.rs/) to be installed. It will install the `wstcp` tool needed for TLSNotary WebSocket proxying.

### 5. Run Node and Generate Keys

```bash
# Start both database and node for the first time, if successful, you will see your node’s private
# and public keys along with the database loaded and the node will join the consensus process
./run
# Stop the node for now so that you can edit the configuration files
Ctrl+C
```

### 6. Configure the Node

Copy the example configuration files into working copies:

```bash
cp env.example .env
cp demos_peerlist.json.example demos_peerlist.json
```

**Edit .env file:** The most important setting is `EXPOSED_URL`. Set it based on your setup:

-   Local testing: `http://localhost:53550`
-   Remote machine: `http://YOUR_PUBLIC_IP:53550`
-   Behind proxy: `https://demos.example.com`

**Edit demos_peerlist.json:** Add known peers in the format:

```json
{
  "publickey": "connectionstring" # Example: “publickey”:”http://localhost:53550”
}
```

For local testing, you can use your own public key (found in the “publickey” file in your node directory after the first run).

### 7. Run Node

```bash
# Start the node again if you would like to keep it running
./run
```

---

## 🔧 Full Installation Guide

Start by installing a Debian Linux distro like Ubuntu: [https://ubuntu.com/download/desktop](https://ubuntu.com/download/desktop)

### 1. Install Prerequisites

Open a terminal and enter:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git wget build-essential ca-certificates gnupg lsb-release
```

### 2. Install Docker

```bash
# Remove old Docker versions
sudo apt remove docker docker-engine docker.io containerd runc

# Install prerequisites
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Set up repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker and Docker Compose
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

```bash
# Start and enable Docker
sudo systemctl start docker
sudo systemctl enable docker

# Verify installation
docker --version
docker compose version
```

### 3a. Install Bun using Mise

```bash
# Install Mise
curl https://mise.run | sh

# Install Bun
mise use -g bun@latest

# Verify Bun
bun -v
```
### 3b. Install Bun without Mise

```bash
# If method 3a does not work, use this alternate method to install Bun
curl -fsSL https://bun.sh/install | bash

# Verify Bun
bun -v
```

### Demos Node Installation

#### 1. Clone Repository

```bash
cd ~
git clone -b testnet https://github.com/kynesyslabs/node.git
# switch to your node directory
cd node
# Double check that you are on testnet
git branch
```

#### 2. Install Dependencies

```bash
# Install all dependencies (requires Rust/Cargo for wstcp)
./install-deps.sh
```

> **Note:** The install script requires [Rust](https://rustup.rs/) to be installed. It will install the `wstcp` tool needed for TLSNotary WebSocket proxying. If you don't have Rust installed, run:
> ```bash
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> source ~/.cargo/env
> ```

## 🎯 Starting and Configuring the Node

### 1. Start the Node

You can start the node using the `run` script shown below. 

```bash
./run
```

Running the node the first time will generate a private key for your node and store it in the `.demos_identity` file by default. The public key for your node is printed on the terminal when the node runs and is also saved in a `publickey_*` file in the same directory.

### Run script usage
```
🚀 Demos Network Node Runner

USAGE:
    ./run [OPTIONS]

Welcome to Demos Network! This script helps you run your blockchain node easily.

OPTIONS:
    -p <port>                      Node port (default: 53550)
    -d <port>                      PostgreSQL port (default: 5332)
    -i <path>                      Identity file path (default: .demos_identity)
    -c <true/false>                Clean database on startup
    -n <true/false>                Skip git pull (useful for custom branches)
    -u <url>                       Override EXPOSED_URL
    -l <path>                      Peer list file (default: demos_peerlist.json)
    -r <runtime>                   Force runtime (bun only - node deprecated)
    -b <true/false>                Restore from backup
    -v                             Verbose logging
    -h                             Show this help message

EXAMPLES:
    ./run                          # Start with default settings
    ./run -p 53551 -d 5333         # Run on custom ports
    ./run -c                       # Clean start (fresh database)
    ./run -v                       # Verbose output for troubleshooting
    ./run -n                       # Skip git update (for development)
```

#### Custom Ports (Optional)

```bash
# Use different ports if defaults are busy
./run -p 53551 -d 5333
# -p: node port (default 53550)
# -d: database port (default 5332)
```

### 2. Check Node Status

In a new terminal window:

```bash
# Check if node is running
curl http://localhost:53550

# Check ports
sudo lsof -i :53550  # Node port
sudo lsof -i :5332   # Database port

# Check Docker containers
docker ps

# Stop the node for now so that you can edit the configuration files
Ctrl+C
```

### 3. Further configuration

The `.env` and `demos_peerlist.json` files are used to configure the demos node. Copy the templates using the command below:

```bash
cp env.example .env
cp demos_peerlist.json.example demos_peerlist.json
```

### 4. Edit Configuration Files

```bash
nano .env
```

Set the following variable:

-   **EXPOSED_URL:** Your node's public URL
    -   Local testing: `http://localhost:53550`
    -   Remote server: `http://YOUR_PUBLIC_IP:53550`
    -   Behind proxy: `https://your-domain.com`

### 5. Node Identity - Public and Private Keys

After running the node for the first time your keypair will be generated. You should find the `publickey_*` and `.demos_identity` files inside the node directory.

The public key file contains your public key, this can be shared and utilized in your node. The `.demos_identity` is your private key, **KEEP THIS PRIVATE**. Back up both public and private keys.

### 6. Joining a network

To join a network, you can edit the `demos_peerlist.json` file to add known peers in the format:

```jsonc
{
    "publickey": "connectionstring" //  Example: "0xd0b2be2cb6d...": "http://otherpeer.localhost"
}
```

> [!IMPORTANT]
> When joining a network, please make sure your node's exposed URL is accessible by the other nodes. If they can't access it, your node won't be able to participate in the consensus.

### 7. Start the Node Again

```bash
# Restart the node again with your new settings if you’d like to keep it running
./run
```

## ✅ Verification

### Check Node Status

In a new terminal:

```bash
# Check if node is running
curl http://localhost:53550

# Check ports
sudo lsof -i :53550  # Node port
sudo lsof -i :5332   # Database port

# Use different ports if defaults are busy
./run -p 53551 -d 5333
# -p: node port (default 53550)
# -d: database port (default 5332)

# Check Docker containers
docker ps
```

### View Logs

The node will output logs showing:

-   Database connection status
-   RPC server initialization
-   Your node's public key
-   Peer connection attempts

### Stopping the Node

```bash
# Press Ctrl+C in the terminal running the node

# Stop database
cd postgres_5332
./stop.sh
```

## 🛠️ Troubleshooting

### Port Already in Use

```bash
# Check what's using the port
sudo lsof -i :5332

# Use different port
./run -d 5333
```

### Docker Permission Issues

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Database Connection Timeout

```bash
# Restart Docker
sudo systemctl restart docker

# Clean and restart
cd postgres_5332
./clean.sh
./start.sh
```

### Missing Dependencies

```bash
rm -rf node_modules bun.lockb
bun install
```

## 🔒 Security Notes

1. **Backup your identity files:**

    - `.demos_identity` (private key - KEEP SECRET)
    - `public.key` (public identifier)

2. **Set proper permissions:**

    ```bash
    chmod 600 .demos_identity
    ```

3. **Never share your private key**

## 🌐 Network Information

> **Note:** These are the default ports. If you have modified any port settings in your `.env` file or run script flags, make sure to open those custom ports instead.

### Required Ports

| Port | Service | Description |
|------|---------|-------------|
| 53550 | Node RPC | Main node API endpoint |
| 53551 | OmniProtocol | P2P communication (TCP+UDP) |
| 7047 | TLSNotary | TLSNotary server |
| 55000-60000 | WS Proxy | WebSocket proxy for TLSNotary (TCP+UDP) |

### Optional Ports

| Port | Service | Description |
|------|---------|-------------|
| 9090 | Metrics | Node Prometheus metrics endpoint |
| 9091 | Prometheus | Prometheus server (monitoring stack) |
| 3000 | Grafana | Dashboard UI (monitoring stack) |
| 5332 | PostgreSQL | Database (local only, do not expose) |

-   Logs directory: `logs_53550_demos_identity/`
-   Configuration: `.env` and `demos_peerlist.json`

## ➡️ Next Steps

Once your node is running:

1. Note your public key from the console output
2. Share your connection string with other node operators to form a network
3. Monitor the logs for successful peer connections
4. Check the Demos Network documentation for updates
