# Installing the Demos Node

This guide covers two ways to run a Demos node:

- **Track 1: Docker Compose (recommended)** — single-command bring-up of the full stack (node + Postgres + TLSNotary + monitoring). This is the path most operators should take.
- **Track 2: Bare metal with `./run`** — host-native install using Bun and a sidecar Postgres container. Useful for development, debugging, and TUI-based operation.

Pick one. Both tracks produce a working node; they differ only in where the binary and its dependencies live.

## System Requirements

### Hardware Minimum

- 4GB RAM
- 4 CPU cores (2GHz+)
- Modern SSD
- 200 Mbps internet connection

### Hardware Recommended

- 8GB RAM
- 6 CPU cores (2GHz+)
- Modern SSD
- 1 Gbps internet connection

### Operating System

Linux is the supported and tested target. Ubuntu 22.04 LTS or newer is recommended. Any modern distro that runs Docker works for Track 1.

---

## Track 1: Docker Compose (recommended)

### Prerequisites

That's the whole list:

- **Docker** 20.10 or newer
- **Docker Compose** v2 (the `docker compose` plugin, not the legacy `docker-compose` Python script)

No Bun, no Postgres, no Rust toolchain on the host. Everything else runs inside containers.

Verify:

```bash
docker --version
docker compose version
```

If you don't have Docker installed, follow the official guide: [https://docs.docker.com/engine/install/](https://docs.docker.com/engine/install/) and add yourself to the `docker` group so you don't need `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Quickstart (3 steps)

```bash
git clone https://github.com/kynesyslabs/node.git && cd node
cp .env.example .env  # defaults are fine; edit only if you want to override
docker compose up
```

The first run pulls images and builds the node container, so expect a few minutes. Subsequent starts are near-instant.

When the stack is healthy:

- Node RPC: http://localhost:53550 (try `curl http://localhost:53550/info`)
- Grafana: http://localhost:3000 (default `admin` / `demos`)
- Prometheus: http://localhost:9091

### Environment file

`.env.example` is the canonical template. Copy it to `.env` and edit. The variables you actually care about:

| Variable | Default | Notes |
|----------|---------|-------|
| `TLSNOTARY_ENABLED` | `true` | Set to `false` to skip TLSNotary entirely. |
| `TLSNOTARY_SIGNING_KEY` | _(empty)_ | **Leave empty in docker mode (the default).** The TLSNotary sidecar manages its own key. Only set this if you've switched `TLSNOTARY_MODE` to `ffi` (in-process Rust binding). |
| `RPC_PORT` | `53550` | Host-mapped port for the node RPC. Change if 53550 is taken. |
| `EXPOSED_URL` | `http://localhost:53550` | Public URL advertised to peers. Set to your public IP/domain when running on a VPS. |
| `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` | `demosuser` / `demospassword` / `demos` | Postgres credentials. Change `PG_PASSWORD` if you're paranoid; it never leaves the compose network. |
| `METRICS_ENABLED` / `METRICS_PORT` | `true` / `9090` | Prometheus scrape endpoint on the node. |
| `GRAFANA_ADMIN_PASSWORD` | `demos` | Grafana admin password. Change this. |
| `L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET` | `50000` | Most executed L2PS transactions one subnet may have waiting for a batch. At the cap new ones are refused with `L2PS_BACKLOG_FULL` (HTTP 429, or a retry-later error on the messaging socket) until the aggregator catches up. `0` turns the limit off; the hash cycle then sorts the whole queue every few seconds, with no bound and without the primary-key index, so only do that on a node with a small subnet. A positive value must be at least `L2PS_MIN_BATCH_SIZE`, and a negative one is refused, or the node does not start. |
| `L2PS_AGGREGATOR_MAX_BATCHES_PER_CYCLE` | `5` | Batches (each up to `L2PS_MAX_BATCH_SIZE` transactions, capped by the ZK circuit size) the L2PS aggregator builds per subnet per cycle. Raise it if a busy subnet's queue keeps growing; each batch costs one ZK proof when proofs are on. At most 100. |
| `L2PS_MESSAGING_SEND_RATE` | `5` | Messages per second one sender key may send through the messaging relay once its burst is spent. Over it the sender gets `RATE_LIMITED` with a retry time and keeps its socket. `0` turns the limit off. |
| `L2PS_MESSAGING_SEND_BURST` | `30` | Messages a sender key may send at once before the rate applies. |
| `L2PS_MESSAGING_BACKLOG_SHARE` | `0.5` | Largest fraction of `L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET` that messaging may hold, so RPC transactions keep the rest. `1` gives messaging all of it. |
| `COMPOSE_PROFILES` | `monitoring,tlsnotary` | Which compose profiles are active. See below. |

Leave `PG_HOST=postgres` and `TLSNOTARY_HOST=tlsnotary` exactly as shipped — those are the in-network service names. They are only `localhost` for the bare-metal path (Track 2).

### Joining the network — required steps before real-world use

A fresh node will run as an isolated single-validator chain by default. To participate in the actual Demos testnet/mainnet, you must do **two things**:

**1. Set `EXPOSED_URL` to your reachable address.**

The default `http://localhost:53550` is fine for local dev but useless for any peer trying to connect to you. Before going live:

```env
# In .env
EXPOSED_URL=http://YOUR_PUBLIC_IP:53550
# or for a DNS name:
EXPOSED_URL=http://node.example.com:53550
```

If running behind NAT, port-forward `53550` (RPC) and `53551` (OmniProtocol TCP) to this host. The firewall section below has the exact rules.

**2. Provide a bootstrap peerlist.**

The node persists its peerlist in the `demos_node_state` volume at `demos_peerlist.json`. On a brand-new node this file is empty (only the node itself), so it cannot discover other peers. To bootstrap, write one or more known peer URLs into that volume before first start:

```bash
# Create a bootstrap peerlist on your host
cat > /tmp/demos_peerlist.json <<EOF
{"http://bootstrap1.demos.network:53550": null,
 "http://bootstrap2.demos.network:53550": null}
EOF

# Seed it into the volume (one-shot). The volume is named demos_node_state
# explicitly in docker-compose.yml so this exact name works regardless of
# the directory you run compose from.
docker run --rm \
  -v demos_node_state:/state \
  -v /tmp/demos_peerlist.json:/seed/demos_peerlist.json:ro \
  alpine sh -c 'cp /seed/demos_peerlist.json /state/ && chown 1000:1000 /state/demos_peerlist.json'

# Now start the stack
docker compose up
```

Replace `bootstrap1.demos.network` etc. with current bootstrap nodes from the team. The node will merge any peers it learns from these into the file as it runs.

### Network Exposure

When running on a VPS or any machine you want peers to connect to, you must allow inbound connections on these ports:

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 53550 | TCP | inbound | Node RPC (HTTP) |
| 53551 | TCP | inbound | OmniProtocol (peer-to-peer binary RPC) |
| 7047 | TCP | inbound | TLSNotary attestation server (only if you want others to attest against your notary) |

These ports should NOT be exposed publicly:

| Port | Why |
|------|-----|
| 5432 | Postgres — internal compose network only |
| 9090 | Node metrics — keep behind your firewall or VPN |
| 9091 | Prometheus — keep behind your firewall or VPN |
| 3000 | Grafana — only public if you want a public dashboard |

`ufw` example for an Ubuntu VPS:

```bash
sudo ufw allow 53550/tcp comment "Demos RPC"
sudo ufw allow 53551/tcp comment "Demos OmniProtocol"
sudo ufw allow 7047/tcp  comment "Demos TLSNotary"
sudo ufw enable
```

If you're behind NAT (home server, dev box, etc.), forward 53550 and 53551 from your router to this host. TLSNotary forwarding is optional — only needed if you want peers to use *your* notary container.

Don't forget to set `EXPOSED_URL` in `.env` to the address peers will reach you at (public IP, DNS name, or NAT-mapped hostname).

### Profiles

The compose file splits optional services into profiles so you only run what you need.

| Profile | What it adds |
|---------|--------------|
| _(none)_ | postgres + node — the bare minimum stack |
| `tlsnotary` | TLSNotary sidecar (HTTPS attestation). Pair with `TLSNOTARY_ENABLED=true` |
| `monitoring` | prometheus + grafana |
| `full` | node-exporter (host CPU/RAM/disk metrics) — pair with `monitoring` |
| `neo4j` | neo4j (only needed for CGC/KYC features) |

`.env.example` ships with `COMPOSE_PROFILES=monitoring,tlsnotary` so a plain `docker compose up` brings up the recommended full stack.

Concrete commands:

```bash
# Default — postgres + node + tlsnotary + monitoring
# (uses COMPOSE_PROFILES from .env.example)
docker compose up

# Minimal — only node + postgres, no sidecars
# Also set TLSNOTARY_ENABLED=false in .env to silence the node-side warnings
COMPOSE_PROFILES= docker compose up

# Add host-level metrics (node-exporter)
COMPOSE_PROFILES=monitoring,tlsnotary,full docker compose up

# Add Neo4j (only if you actually need CGC/KYC)
COMPOSE_PROFILES=monitoring,tlsnotary,neo4j docker compose up
```

### Where data lives

State is stored in named Docker volumes, not bind mounts. They survive `docker compose down` but **not** `docker compose down -v`.

| Volume | Holds |
|--------|-------|
| `demos_pgdata` | PostgreSQL data directory (chain state, indexes) |
| `demos_node_state` | Your `.demos_identity` (private key), `demos_peerlist.json`, `.tlsnotary-key`, `output/` |
| `demos_node_data` | Bundled bootstrap data (genesis.json, evmChains, l2ps) plus chain runtime artifacts |
| `demos_node_logs` | Node logs |
| `demos_prometheus_data` | Prometheus TSDB |
| `demos_grafana_data` | Grafana dashboards, users, settings |
| `demos_neo4j_data` / `demos_neo4j_logs` | Neo4j (only if `neo4j` profile is on) |

The `demos_` prefix is set explicitly in `docker-compose.yml` so the names are stable regardless of the project directory name. Inspect a volume:

```bash
docker volume inspect demos_node_state
```

### Backup the node identity

Your `.demos_identity` is the private key — losing it means losing your node's network identity. Back up the entire `demos_node_state` volume:

```bash
docker run --rm -v demos_node_state:/src -v "$PWD":/dst alpine \
  tar czf /dst/node-state-backup.tar.gz -C /src .
```

That writes `node-state-backup.tar.gz` into your current directory. To restore, do the reverse: stop the stack, recreate an empty `demos_node_state` volume, and `tar xzf` the backup back into it.

### View logs

```bash
docker compose logs -f node          # follow node logs
docker compose logs -f postgres      # follow postgres logs
docker compose logs -f tlsnotary     # follow tlsnotary logs
docker compose logs -f               # follow everything
```

### Connect to the RPC

```bash
curl http://localhost:53550/        # liveness check (root)
curl http://localhost:53550/info    # node info (version, identity, etc.)
```

### Update the node

A validator moves to a released image by tag and digest, never by building its own; see [docs/runbooks/release.md](docs/runbooks/release.md). Set `IMAGE_NAME` and `IMAGE_TAG` in `.env` from the release's `checksums.txt`, then:

```bash
docker compose pull node
docker compose up -d
```

Volumes (and therefore your identity, chain data, peerlist cache) are preserved.

A development host that builds from source instead: `git pull && docker compose up -d --build`.

### Stop the node

```bash
docker compose down                  # stop containers, KEEP volumes
docker compose down -v               # stop AND DELETE all volumes (nuclear)
```

### Wipe everything

```bash
docker compose down -v
```

This deletes your identity, chain data, Prometheus history, Grafana dashboards — everything. Only do this if you actually want to start from scratch.

### Troubleshooting

**TLSNotary feature not initializing**
> In docker mode (the default) no signing key is required — the sidecar manages its own. If you see initialization warnings, check that the `tlsnotary` container is reachable: `curl http://localhost:7047/info` should return JSON. If you switched to `TLSNOTARY_MODE=ffi`, you need a 64-char hex `TLSNOTARY_SIGNING_KEY` in `.env` (or leave it empty and the node auto-generates one in `.tlsnotary-key`).

**EXPOSED_URL warning at startup**
> `⚠️ EXPOSED_URL is set to a loopback/unroutable address` means peers can't reach you. Fine for local dev. For real deployment set `EXPOSED_URL=http://YOUR_PUBLIC_IP:53550` in `.env`.

**Port 53550 already in use**
> Set `RPC_PORT` (and optionally `EXPOSED_URL`) in `.env` to a free port, then `docker compose up -d` again.

**Postgres connection refused / node fails to connect to DB**
> Postgres takes a few seconds to become healthy on first boot. The node has a `depends_on: condition: service_healthy` so this should be automatic — but if it persists, check `docker compose logs postgres` for crash loops or auth failures.

**Out of disk**
> Volumes grow over time. Inspect with `docker system df -v`. To reclaim space without losing identity, only prune images: `docker image prune -af`. To reclaim everything: `docker compose down -v` (destructive).

**`docker compose: command not found`**
> You have the legacy Python `docker-compose` instead of the v2 plugin. Install the plugin per [https://docs.docker.com/compose/install/](https://docs.docker.com/compose/install/).

**Grafana password change doesn't take effect**
> Grafana persists the password in `demos_grafana_data` after first boot. To change it, either edit it in the Grafana UI, or `docker compose down && docker volume rm demos_grafana_data && docker compose up -d` (resets dashboards too).

---

## Track 2: Bare metal with `./run`

This is the original install path. The node binary runs natively on the host via Bun; only Postgres runs in a sidecar container managed by the `./run` script. Pick this track if you want host-native execution, are doing kernel-level debugging, or just prefer it.

> Note: `./run` at the repo root is a thin wrapper that forwards to `scripts/run` (the actual implementation). Always invoke `./run` from the repo root — never call `scripts/run` directly. The wrapper exists so the legacy command path keeps working.

### 1. Install Prerequisites

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git wget build-essential ca-certificates gnupg lsb-release
```

### 2. Install Docker

The `./run` script still uses Docker for the Postgres sidecar.

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
mise use -g bun@1.3.14   # the version in .bun-version

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

### 4. Clone Repository

```bash
cd ~
git clone -b testnet https://github.com/kynesyslabs/node.git
# switch to your node directory
cd node
# Double check that you are on testnet
git branch
```

### 5. Install Dependencies

```bash
# Install all dependencies (requires Rust/Cargo for wstcp)
./scripts/install-deps.sh
```

> **Note:** The install script requires [Rust](https://rustup.rs/) to be installed. It will install the `wstcp` tool needed for TLSNotary WebSocket proxying. If you don't have Rust installed, run:
>
> ```bash
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> source ~/.cargo/env
> ```

### 6. First Run — Generate Keys

```bash
./run
```

Running the node the first time will generate a private key for your node and store it in the `.demos_identity` file by default. The public key is printed on the terminal and saved in a `publickey_*` file in the same directory.

Press `Ctrl+C` (or `Q` in the TUI) to stop the node so you can edit the configuration files.

### Run script usage

```text
Demos Network Node Runner

USAGE:
    ./run [OPTIONS]

OPTIONS:
    -p <port>                      Node port (default: 53550)
    -d <port>                      PostgreSQL port (default: 5332)
    -i <path>                      Identity file path (default: .demos_identity)
    -c <true/false>                Clean database on startup
    -U                             Update the checkout (git pull) before starting
    -n <true/false>                Kept for compatibility: pull is already off by default
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
    ./run -U                       # Pull origin first (development only)
```

#### Custom Ports (Optional)

```bash
# Use different ports if defaults are busy
./run -p 53551 -d 5333
# -p: node port (default 53550)
# -d: database port (default 5332)
```

### 7. Configure the Node

Copy the templates and edit them:

```bash
cp .env.example .env
cp demos_peerlist.json.example demos_peerlist.json
```

For the bare-metal path, override these in `.env`:

- `PG_HOST=localhost`
- `PG_PORT=5332` (the host-mapped port the `./run` Postgres sidecar uses)
- `TLSNOTARY_HOST=localhost`

Set `EXPOSED_URL` based on your setup:

- Local testing: `http://localhost:53550`
- Remote machine: `http://YOUR_PUBLIC_IP:53550`
- Behind proxy: `https://demos.example.com`

If you're using FFI mode (`TLSNOTARY_MODE=ffi`), set `TLSNOTARY_SIGNING_KEY` in `.env` to a 64-char hex secp256k1 key — or leave it empty and the node auto-generates one into `.tlsnotary-key` on first boot. To skip TLSNotary entirely, set `TLSNOTARY_ENABLED=false`.

### 8. Joining a Network

Edit `demos_peerlist.json` to add known peers:

```jsonc
{
    "publickey": "connectionstring" //  Example: "0xd0b2be2cb6d...": "http://otherpeer.localhost"
}
```

> [!IMPORTANT]
> When joining a network, please make sure your node's exposed URL is accessible by the other nodes. If they can't access it, your node won't be able to participate in the consensus.

### 9. Start the Node

```bash
./run
```

### Verify

In a new terminal:

```bash
# Liveness
curl http://localhost:53550
curl http://localhost:53550/info

# Ports
sudo lsof -i :53550   # Node port
sudo lsof -i :5332    # Database port

# Containers (Postgres sidecar)
docker ps
```

### Stopping the Node

```bash
# Press Ctrl+C in the terminal running the node (or `Q` in the TUI)

# Stop the Postgres sidecar
cd postgres_5332
./stop.sh
```

### Bare-metal Troubleshooting

**Port already in use**

```bash
sudo lsof -i :5332
./run -d 5333
```

**Docker permission issues**

```bash
sudo usermod -aG docker $USER
newgrp docker
```

**Database connection timeout**

```bash
# Restart Docker
sudo systemctl restart docker

# Clean and restart the postgres sidecar
cd postgres_5332
./clean.sh
./start.sh
```

**Missing dependencies**

```bash
rm -rf node_modules bun.lockb
bun install
```

---

## L2PS and ZK setup (optional)

L2PS subnets and ZK proofs need a few files and `.env` entries. Three commands handle them:

```bash
bun run setup            # asks what to enable and writes the files and .env entries
bun run setup --check    # report only: what is configured, missing or invalid
bun run setup --yes ...  # no questions; answers come from flags and DEMOS_SETUP_* variables
```

What the setup does:

- **L2PS:** creates `data/l2ps/<id>/` (config, subnet key, IV) with a fresh key, or imports the key and IV you received from the subnet owner when you join an existing subnet. Key files get mode 600 and are never printed. It also sets the history retention, plaintext history, messaging and port options in `.env`.
- **ZK batch proofs:** builds the proving keys (about 200 MB download, several minutes; with `--yes` only when you pass `--zk-generate`) and turns `L2PS_ZK_ENABLED` on once they exist. The identity verification key is committed to the repository and is only checked, never regenerated.
- Messaging is only switched on together with a usable subnet, never on its own.
- Exit codes: 0 done (or `--check` found nothing wrong), 1 something is missing or could not be written, 2 invalid command line or `DEMOS_SETUP_*` value, 130 cancelled. With `--check --json` the output is a single JSON document on every path, errors included.
- Nothing that already exists is replaced unless you say yes or pass `--force`. A replaced file is kept next to the original as `<name>.bak-<time>`. Add `--dry-run` to see what would be written.

Examples:

```bash
# Create a subnet, enable messaging and ZK proofs, no questions asked
bun run setup --yes --l2ps-uid my_subnet --l2ps-rpc http://node2.example.com:53550 \
    --messaging --zk --zk-generate

# Join an existing subnet: put the key and IV you received in files (chmod 600,
# delete them afterwards) so they never appear on a command line
bun run setup --yes --l2ps-uid shared_subnet --l2ps-role join \
    --l2ps-key-file ./subnet.key --l2ps-iv-file ./subnet.iv

# Or read them silently into the shell's environment (not shown in `ps`)
read -rs -p "Subnet key: " DEMOS_SETUP_L2PS_KEY; echo
read -rs -p "Subnet IV: " DEMOS_SETUP_L2PS_IV; echo
export DEMOS_SETUP_L2PS_KEY DEMOS_SETUP_L2PS_IV
bun run setup --yes --l2ps-uid shared_subnet --l2ps-role join

bun run setup --help     # every flag and its DEMOS_SETUP_* variable
```

At start the node checks this setup. If L2PS, messaging or explicitly enabled ZK batch proofs are incomplete, it prints a loud banner (and logs it) listing what is missing and the fix command, then keeps booting: the affected features stay unavailable, the rest of the node is not affected. In a terminal it also offers to run the setup (default no after 30 seconds; Ctrl-C aborts the start). Set `DEMOS_SETUP_STRICT=true` to stop the node instead (CI, fail-fast operators), or `DEMOS_SKIP_SETUP_CHECK=true` to silence the banner. A missing, corrupt or altered ZK identity verification key always stops the node (the skip switch does not apply), because every validator must verify with the same key committed in the release; restore the committed file from the repository (in Docker, rebuild or re-pull the image).

**Identity key rotation:** the node pins the identity verification key by the digest committed in the release, and `bun run zk:setup` or `bun run zk:ceremony` rewrite that file, so a node that ran them refuses to boot. After every validator has agreed on the new key, compute its digest and set it on each node, in `.env` or the process environment:

```bash
bun -e 'import {canonicalDigest} from "./src/cli/setup/zk"; import {readFileSync} from "fs"; console.log(canonicalDigest(readFileSync("src/features/zk/keys/verification_key_merkle.json","utf8")))'
# then: DEMOS_ZK_IDENTITY_KEY_DIGEST=<the 64 hex characters>
```

The variable replaces the pinned digest (it does not turn the check off), so a node still refuses any other key; a malformed value stops the node with a clear message. Drop it again once the release you run carries the new key's digest.

**Working directory:** start the node (and run `bun run setup`) from the checkout directory. The node reads `.env`, `data/genesis.json` and `data/l2ps/` relative to the current directory, and the setup inspects the same places; only the committed and built ZK keys are found from the checkout itself, so they do not depend on where you start from.

**Docker:** run the same commands inside the container, for example `docker compose exec node bun run setup --check`. Subnet files go into the `demos_node_data` volume. Inside the image the setup does not write `/app/.env`; it prints the lines to put in your host `.env` (or the compose environment), and you recreate the container afterwards. The messaging WebSocket port (`L2PS_MESSAGING_PORT`, default 3006) is published by the compose file on loopback only (`L2PS_MESSAGING_BIND`, default `127.0.0.1`; set `0.0.0.0` so SDK clients can reach the port directly; operators behind a reverse proxy keep the default), and with the `proxy` profile Caddy serves it at `/messaging/` and forwards to the same `L2PS_MESSAGING_PORT` (a custom port works there too; `/signaling/` follows `RPC_SIGNALING_PORT` the same way). The image has no writable ZK key directory, so build the ZK keys on a checkout and not in the image.

---

## Security Notes

1. **Backup your identity files:**
    - `.demos_identity` (private key — KEEP SECRET)
    - `publickey_*` (public identifier)

   Track 1 users: see the volume backup snippet above. Track 2 users: copy the files out of the node directory.

2. **Set proper permissions on bare metal:**

    ```bash
    chmod 600 .demos_identity
    ```

3. **Never share your private key.**

## Network Information

> **Note:** These are the default ports. If you have modified any port settings in your `.env` file or run script flags, make sure to open those custom ports instead.

### Required Ports

| Port        | Service      | Description                             |
| ----------- | ------------ | --------------------------------------- |
| 53550       | Node RPC     | Main node API endpoint                  |
| 53551       | OmniProtocol | P2P communication (TCP+UDP)             |
| 7047        | TLSNotary    | TLSNotary server                        |
| 55000-60000 | WS Proxy     | WebSocket proxy for TLSNotary (TCP+UDP) |

### Optional Ports

| Port | Service    | Description                          |
| ---- | ---------- | ------------------------------------ |
| 9090 | Metrics    | Node Prometheus metrics endpoint     |
| 9091 | Prometheus | Prometheus server (monitoring stack) |
| 3000 | Grafana    | Dashboard UI (monitoring stack)      |
| 5332 | PostgreSQL | Database (local only, do not expose) |

- Configuration: `.env` and `demos_peerlist.json`

## Next Steps

Once your node is running:

1. Note your public key from the console output (or from the `publickey_*` file).
2. Share your connection string with other node operators to form a network.
3. Monitor the logs (`docker compose logs -f node` for Track 1, terminal output or `logs/` for Track 2) for successful peer connections.
4. Check the Demos Network documentation for updates.
