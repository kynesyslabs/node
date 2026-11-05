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

### Clock

The node refuses to start without a trusted clock: at boot it needs two NTP readings in a row that agree within 2 seconds. Both come from `pool.ntp.org`; `time.google.com`, `time.windows.com` and `time.apple.com` are asked only when it does not answer. The second reading catches a bad answer, it is not a second independent source, so the host's NTP path must be one nobody can tamper with. The host must allow **outbound UDP 123**. Keep the host clock synchronised as well. On Ubuntu `systemd-timesyncd` does this by default; check it:

```bash
timedatectl            # "System clock synchronized: yes" and "NTP service: active"
# or, with chrony installed:
chronyc tracking       # "Leap status : Normal"
```

If NTP is off: `sudo timedatectl set-ntp true`.

---

## Track 1: Docker Compose (recommended)

### Prerequisites

That's the whole list:

- **Docker** 20.10 or newer
- **Docker Compose** v2 (the `docker compose` plugin, not the legacy `docker-compose` Python script)
- **git** 2.34 or newer with `ssh-keygen` (Ubuntu 22.04 ships both), to verify the signed release tag

No Bun, no Postgres, no Rust toolchain on the host. Everything else runs inside containers.

Verify:

```bash
docker --version
docker compose version
git --version
```

If you don't have Docker installed, follow the official guide: [https://docs.docker.com/engine/install/](https://docs.docker.com/engine/install/) and add yourself to the `docker` group so you don't need `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Docker daemon baseline

Docker Engine 29+ stores images and build cache through containerd, under `/var/lib/containerd`, and keeps up to ~60% of that disk as build cache before it collects anything. On a node that rebuilds the image regularly this fills the root filesystem within months. Set the baseline below in `/etc/docker/daemon.json` before the first build, then `sudo systemctl restart docker`:

```json
{
  "live-restore": true,
  "builder": { "gc": { "enabled": true, "defaultKeepStorage": "10GB" } }
}
```

- `builder.gc` caps the BuildKit cache at 10 GB.
- `live-restore` keeps running containers up across daemon restarts.

Check which image store you are on:

```bash
docker info --format '{{.Driver}} {{json .DriverStatus}}'
```

`overlayfs` with `driver-type: io.containerd.snapshotter.v1` means the containerd store. In that mode `data-root` in `daemon.json` only relocates volumes, container metadata and networks. To put images and build cache on a separate disk as well, set `root = "/path/on/that/disk/containerd"` at the top level of `/etc/containerd/config.toml` (generate the file with `containerd config default` if it only lists `disabled_plugins`), then stop `docker`, `docker.socket` and `containerd` in that order, rsync `/var/lib/containerd/` to the new path, and start `containerd` then `docker`.

### Quickstart (3 steps)

The Quickstart builds the image from the `testnet` branch on your host. It is for development and testnet nodes. A mainnet or launch validator never builds its own image: follow [Run a released image](#run-a-released-image-validators) instead.

```bash
git clone https://github.com/kynesyslabs/node.git && cd node
cp .env.example .env  # defaults are fine; edit only if you want to override
export GIT_COMMIT=$(git rev-parse HEAD)  # the image refuses to build without it
docker compose build node                # the image the migration runs on
docker compose up -d --wait postgres     # the migration needs Postgres up
docker compose run --rm --no-deps --name demos-migrate node bun run migration:run
./run --docker        # docker compose up, with the commit the image is built from
```

The node no longer migrates the database at boot, so on a new host the schema is created once, by the three commands before `./run --docker`; later starts skip them. See [docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md).

The image refuses to build without the git commit it is built from. `./run --docker` exports it itself; to call compose directly, export it first (the `export` line above), then `docker compose up`.

The first run pulls images and builds the node container, so expect a few minutes. Subsequent starts are near-instant.

When the stack is healthy:

- Node RPC: http://localhost:53550 (try `curl http://localhost:53550/info`)
- Grafana: http://localhost:3000 (default `admin` / `demos`)
- Prometheus: http://localhost:9091

### Run a released image (validators)

A validator runs the image the release workflow published, pinned by tag and digest, and starts it without building. Every value below comes from the release announcement and its `checksums.txt`; nothing is copied from an older release.

**1. Check out the signed release tag.** The compose file and scripts must come from the same commit as the image.

```bash
git clone https://github.com/kynesyslabs/node.git && cd node
TAG=vX.Y.Z   # replace with the tag announced on the release thread

git fetch --tags origin stabilisation
# Signers come from the protected branch, not from the tag itself
git show origin/stabilisation:.github/allowed_signers > ~/demos-allowed-signers
git config gpg.ssh.allowedSignersFile ~/demos-allowed-signers
# The tag must be on stabilisation and signed by a listed key;
# the checkout runs only when both checks pass
git merge-base --is-ancestor "$TAG" origin/stabilisation && echo "on stabilisation" &&
git verify-tag "$TAG" &&
git checkout "$TAG"
```

`git verify-tag` must print `Good "git" signature for <signer> with ED25519 key SHA256:<fingerprint>`. Check that the signer and fingerprint are one of the release signers published outside GitHub (see [docs/runbooks/release-signing-key.md](docs/runbooks/release-signing-key.md)); a good signature from a key you do not recognise is a failure. If the block stops before the checkout, or `on stabilisation` is not printed, stop and ask on the release thread. The checkout leaves a detached `HEAD`, which is expected.

**2. Configure.** `cp .env.example .env`, then set at least:

```env
IMAGE_NAME=ghcr.io/kynesyslabs/node
IMAGE_TAG=vX.Y.Z@sha256:<digest from checksums.txt>
EXPOSED_URL=http://YOUR_PUBLIC_IP:53550
```

plus the genesis pin and the validator settings from [Joining the network](#joining-the-network--required-steps-before-real-world-use) below (steps 2 and 3). With a digest in `IMAGE_TAG`, Docker refuses any image whose content differs from the release, whatever the tag points to.

**3. Put the key in place.** A validator key is generated on a trusted machine, not on the validator host, and backed up encrypted with a second person ([docs/runbooks/validator-key.md](docs/runbooks/validator-key.md)). On that machine, from a checkout of the same tag with dependencies installed (`bun install --frozen-lockfile`):

```bash
bun scripts/gen-test-identity.ts --name validator
# prints the public key; the mnemonic is in .test-identity/validator.mnemonic (mode 600)
```

Copy only the mnemonic file to the validator host over a secure channel, then seed it into the state volume and delete the copy:

```bash
docker run --rm \
  -v demos_node_state:/state \
  -v "$PWD/validator.mnemonic":/seed/key:ro \
  alpine sh -c 'cp /seed/key /state/.demos_identity && chown 1000:1000 /state /state/.demos_identity && chmod 700 /state && chmod 600 /state/.demos_identity'
shred -u validator.mnemonic
```

The `chown` of `/state` itself matters: a volume first created by this one-off container belongs to root, and the node (uid 1000) must write its signing state files next to the key.

With `PROD=true` the node never creates a key by itself: a missing key stops it, which is what you want when the volume did not mount.

**4. Check the host.**

```bash
./scripts/node-doctor --production
```

It prints one PASS or FAIL line per item (`PROD`, `DEMOS_REQUIRE_VALIDATORS`, clock sync, outbound NTP, fork-schedule policy, genesis pins, the fees, stake floor and block time every validator must share, one-start switches left set) and exits 1 on any FAIL. It reads the values the node container will get from `docker compose config`, so run it from the checkout with `.env` in place. Fix every FAIL before the next step.

**5. Pull and start without building.**

```bash
docker compose pull node
docker compose up -d --no-build
```

If the pull is refused with `denied` or `unauthorized`, the image is not public yet: log in once with a GitHub token that has only the `read:packages` scope (`docker login ghcr.io -u <github user>`, paste the token at the prompt) and pull again. `--no-build` matters: without it, compose falls back to building the image locally when the pull failed, and you would run your own build instead of the release.

**6. Confirm the digest you run** and post it on the release thread:

```bash
docker image inspect --format '{{index .RepoDigests 0}}' \
  "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q node)")"
```

It must print `ghcr.io/kynesyslabs/node@sha256:<the digest in checksums.txt>`.

### Environment file

`.env.example` is the canonical template. Copy it to `.env` and edit. The variables you actually care about:

| Variable | Default | Notes |
|----------|---------|-------|
| `TLSNOTARY_ENABLED` | `true` | Set to `false` to skip TLSNotary entirely. |
| `TLSNOTARY_SIGNING_KEY` | _(empty)_ | **Leave empty in docker mode (the default).** The TLSNotary sidecar manages its own key. Only set this if you've switched `TLSNOTARY_MODE` to `ffi` (in-process Rust binding). |
| `RPC_PORT` | `53550` | Host-mapped port for the node RPC. Change if 53550 is taken. |
| `EXPOSED_URL` | `http://localhost:53550` | Public URL advertised to peers. Set to your public IP/domain when running on a VPS. |
| `EXPECTED_GENESIS_HASH` | _(empty)_ | The network's published genesis hash. Required in the image (`NODE_ENV=production`) unless `DEMOS_ALLOW_UNPINNED_GENESIS=true`; see "Pin the network's genesis" below. |
| `EXPECTED_GENESIS_BLOCK_HASH` | _(empty)_ | The network's published block 0 hash. Optional; when set, the node refuses any other block 0. |
| `DEMOS_REQUIRE_VALIDATORS` | _(empty)_ | `true` on mainnet validators: with no active validators in the database the node refuses to run consensus instead of using every online peer as the committee. |
| `PROD` | `false` | `true` on validators. The node then refuses to start with a loopback or missing `EXPOSED_URL`, without the commit it was built from, or without its identity file (it never creates a new key on its own; see [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md), "Production refusals"). |
| `FORK_SCHEDULE_MISMATCH_POLICY` | `abstain` | What a validator does when its fork schedule differs from most validators' before a fork. Mainnet runs `abstain` only; `warn` is for devnets and testnets, and the node refuses it together with `DEMOS_REQUIRE_VALIDATORS=true`. See [docs/runbooks/fork-schedule-policy.md](docs/runbooks/fork-schedule-policy.md). |
| `IMAGE_NAME` / `IMAGE_TAG` | `demos-node` / `local` | The node image. Validators set the released image and `tag@sha256:digest`; the defaults name a local build. |
| `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` | `demosuser` / `demospassword` / `demos` | Postgres credentials. Change `PG_PASSWORD` if you're paranoid; it never leaves the compose network. |
| `METRICS_ENABLED` / `METRICS_PORT` | `true` / `9090` | Prometheus scrape endpoint on the node. |
| `GRAFANA_ADMIN_PASSWORD` | `demos` | Grafana admin password. Change this. |
| `L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET` | `50000` | Most executed L2PS transactions one subnet may have waiting for a batch. At the cap new ones are refused with `L2PS_BACKLOG_FULL` (HTTP 429, or a retry-later error on the messaging socket) until the aggregator catches up. `0` turns the limit off; the hash cycle then sorts the whole queue every few seconds, with no bound and without the primary-key index, so only do that on a node with a small subnet. A positive value must be at least `L2PS_MIN_BATCH_SIZE`, and a negative one is refused, or the node does not start. |
| `L2PS_AGGREGATOR_MAX_BATCHES_PER_CYCLE` | `5` | Batches (each up to `L2PS_MAX_BATCH_SIZE` transactions, capped by the ZK circuit size) the L2PS aggregator builds per subnet per cycle. Raise it if a busy subnet's queue keeps growing; each batch costs one ZK proof when proofs are on. At most 100. |
| `L2PS_MESSAGING_SEND_RATE` | `5` | Messages per second one sender key may send through the messaging relay once its burst is spent. Over it the sender gets `RATE_LIMITED` with a retry time and keeps its socket. `0` turns the limit off. |
| `L2PS_MESSAGING_SEND_BURST` | `30` | Messages a sender key may send at once before the rate applies. |
| `L2PS_MESSAGING_BACKLOG_SHARE` | `0.5` | Largest fraction of `L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET` that messaging may hold, so RPC transactions keep the rest. `1` gives messaging all of it. |
| `COMPOSE_PROFILES` | `monitoring,tlsnotary` | Which compose profiles are active. See below. |

Under docker compose a variable reaches the node only when `docker-compose.yml` lists it in the node's `environment:`; a value in `.env` that is not listed there does nothing. Every node variable in this table is listed.

Leave `PG_HOST=postgres` and `TLSNOTARY_HOST=tlsnotary` exactly as shipped — those are the in-network service names. They are only `localhost` for the bare-metal path (Track 2).

### Joining the network — required steps before real-world use

A fresh node will run as an isolated single-validator chain by default. To participate in the actual Demos testnet/mainnet, you must do **three things** before the node's first start:

**1. Set `EXPOSED_URL` to your reachable address.**

The default `http://localhost:53550` is fine for local dev but useless for any peer trying to connect to you. Before going live:

```env
# In .env
EXPOSED_URL=http://YOUR_PUBLIC_IP:53550
# or for a DNS name:
EXPOSED_URL=http://node.example.com:53550
```

If running behind NAT, port-forward `53550` (RPC), `53551` (OmniProtocol TCP) and `9095` (gossip) to this host. The firewall section below has the exact rules.

**2. Provide a bootstrap peerlist.**

The node persists its peerlist in the `demos_node_state` volume at `demos_peerlist.json`. On a brand-new node this file is empty (only the node itself), so it cannot discover other peers. To bootstrap, write one or more known peers into that volume before first start. Each entry maps the peer's public key (its identity, which the peer must prove by signing) to its URL; an entry with `null` as the URL is skipped with `Invalid peer data format`:

```bash
# Create a bootstrap peerlist on your host
cat > /tmp/demos_peerlist.json <<EOF
{"0x<bootstrap1 public key>": "http://bootstrap1.demos.network:53550",
 "0x<bootstrap2 public key>": "http://bootstrap2.demos.network:53550"}
EOF

# Seed it into the volume (one-shot). The volume is named demos_node_state
# explicitly in docker-compose.yml so this exact name works regardless of
# the directory you run compose from.
docker run --rm \
  -v demos_node_state:/state \
  -v /tmp/demos_peerlist.json:/seed/demos_peerlist.json:ro \
  alpine sh -c 'cp /seed/demos_peerlist.json /state/ && chown 1000:1000 /state /state/demos_peerlist.json'
```

Do not start the node yet: it needs the genesis pins of step 3 first.

Replace the public keys and `bootstrap1.demos.network` etc. with the current bootstrap nodes from the team. The node will merge any peers it learns from these into the file as it runs.

**3. Pin the network's genesis.**

The image runs with `NODE_ENV=production`, and a production node refuses to start (exit code 1) unless it knows which genesis it joins. Set the hash the network publishes:

```env
# In .env
EXPECTED_GENESIS_HASH=<published genesis hash>
EXPECTED_GENESIS_BLOCK_HASH=<published block 0 hash>
# Validators
PROD=true
DEMOS_REQUIRE_VALIDATORS=true
FORK_SCHEDULE_MISMATCH_POLICY=abstain
```

`scripts/genesis-hash.ts --genesis <file>` prints both values for a genesis file; the block 0 hash is the one labelled "genesis block hash". What each hash covers, and where mainnet's are published, is in [docs/mainnet/genesis-hash.md](docs/mainnet/genesis-hash.md).

A validator never leaves these set in `.env`: `DEMOS_ALLOW_UNPINNED_GENESIS`, and the one-start switches `DEMOS_GENERATE_IDENTITY`, `DEMOS_IDENTITY_TAKEOVER`, `DEMOS_SIGNING_RECORD_REBIND` and `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST`. Each of the last four is for the single start that needs it (see [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md) and below); remove it once the node runs. `./scripts/node-doctor --production` fails while any of them is set.

At every start the node checks it before it signs anything: on an empty database against the genesis file (`data/genesis.json`, or `DEMOS_GENESIS_FILE`) and the snapshot that genesis declares, before block 0 is written; on an existing database against the stored block 0. A mismatch stops the node with exit code 1 and leaves the database as it was. A network that publishes no hash can opt out with `DEMOS_ALLOW_UNPINNED_GENESIS=true`; mainnet validators never set it. A node started without a pin and without that opt-out (a bare-metal `./run` install runs as development, so nothing refuses it) logs a `[GENESIS] EXPECTED_GENESIS_HASH is not set` warning at every boot.

The genesis hash leaves out the validators' `connection_url` and the order of the keys in the file, and block 0 does not, so two files with the same genesis hash can still build different blocks 0. `EXPECTED_GENESIS_BLOCK_HASH` closes that: an empty database refuses to write any other block 0, and an existing one refuses to boot on it.

On mainnet, mount the published genesis file and snapshot read-only instead of using the files bundled in the image, which belong to the testnet. Use the files exactly as published and check the genesis file's checksum against the announcement; never edit them: even a changed validator URL or a different order of keys builds a different block 0, and that node cannot join ([docs/mainnet/genesis.md](docs/mainnet/genesis.md)):

```yaml
# docker-compose.override.yml
services:
  node:
    volumes:
      - ./mainnet/genesis.json:/app/data/genesis.json:ro
      - ./mainnet/snapshot:/app/mainnet-snapshot:ro
    environment:
      DEMOS_SNAPSHOT_DIR: /app/mainnet-snapshot
```

The node also remembers the fork schedule it last ran with. A restart whose `data/genesis.json` adds, moves or removes a fork at or below the current height plus 50 blocks is refused, and the refusal names the change. If every operator agreed to that exact schedule, restart once with `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST` set to the digest the refusal prints. See `docs/design/genesis-enforcement.md`.

With all three in place, start the node. A validator runs `./scripts/node-doctor --production` first and starts only when it passes (steps 4 and 5 of the release-image install above); a source build starts with `./run --docker -d`.

### Network Exposure

When running on a VPS or any machine you want peers to connect to, you must allow inbound connections on these ports:

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 53550 | TCP | inbound | Node RPC (HTTP) |
| 53551 | TCP | inbound | OmniProtocol (peer-to-peer binary RPC) |
| 9095 | TCP | inbound | Gossip (`GOSSIP_PORT`); peers dial `EXPOSED_URL`'s host on this port |
| 7047 | TCP | inbound | TLSNotary attestation server (only if you want others to attest against your notary) |
| 55688 | TCP | inbound | TLSNotary WebSocket proxy port the node advertises (`TLSNOTARY_PROXY_PORT`; only with TLSNotary on) |
| 123 | UDP | outbound | NTP; the node does not start without it (see [Clock](#clock)) |

These ports should NOT be exposed publicly:

| Port | Why |
|------|-----|
| 5432 | Postgres — internal compose network only |
| 9090 | Node metrics — published on loopback only (`METRICS_BIND`); a monitoring host off this machine needs a private interface or a tunnel |
| 9091 | Prometheus — keep behind your firewall or VPN |
| 3000 | Grafana — only public if you want a public dashboard |
| 55000-55063 | TLSNotary per-session proxies — published on loopback only, for a reverse proxy on this host (`/tlsn/<port>/`) |

`ufw` example for an Ubuntu VPS. Allow SSH first, or `ufw enable` locks you out of a remote host:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 53550/tcp comment "Demos RPC"
sudo ufw allow 53551/tcp comment "Demos OmniProtocol"
sudo ufw allow 9095/tcp  comment "Demos gossip"
sudo ufw allow 7047/tcp  comment "Demos TLSNotary"
sudo ufw allow 55688/tcp comment "Demos TLSNotary proxy"
sudo ufw enable
```

`ufw` allows outbound traffic by default, so NTP needs no rule unless your provider's firewall blocks it. Docker publishes container ports through its own iptables rules, ahead of `ufw`; the rules above matter for what the host itself exposes, and the loopback bindings in `docker-compose.yml` are what keep the internal ports private.

If you're behind NAT (home server, dev box, etc.), forward 53550, 53551 and 9095 from your router to this host. TLSNotary forwarding is optional — only needed if you want peers to use *your* notary container.

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

Your `.demos_identity` is the private key — losing it means losing your node's network identity. The same volume holds the signing state files (`.demos_identity.signed.json`, `.commitlock.json`, `.prevote.json` and others listed in [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md), "Signing state files"), which must be backed up and restored together with the key, as one copy taken while the node is stopped. Back up the whole `demos_node_state` volume, encrypted, and keep the backup off this host:

```bash
out="node-state-$(date +%F-%H%M%S).tar.gz.gpg"
if docker compose stop node; then
  ( set -o pipefail
    docker run --rm -v demos_node_state:/src:ro alpine tar czf - -C /src . \
      | gpg --symmetric --cipher-algo AES256 -o "$out"
  ) || { echo "backup FAILED; removing $out" >&2; rm -f "$out"; }
  docker compose up -d --no-build    # a source build: ./run --docker -d
else
  echo "the node did not stop; no backup taken" >&2
fi
```

A copy taken while the node runs can hold a signing state older than the key's last vote, so the backup runs only after the stop succeeded, and a failed `tar` or `gpg` leaves no file behind that could pass for a backup.

`gpg` asks for a passphrase; store it apart from the backup. Move the `.gpg` file off the host and delete the local copy. Never keep an unencrypted copy of this volume.

Restoring is not the reverse of this: an old copy can make the key vote against a vote it already cast. Follow the restore rules in [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md) (newest complete copy, network head above the key's last possible vote, never two hosts running the key).

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

A validator moves to a released image by tag and digest, never by building its own; see [docs/runbooks/release.md](docs/runbooks/release.md). Verify and check out the new tag (step 1 of [Run a released image](#run-a-released-image-validators)), set `IMAGE_TAG` in `.env` from the release's `checksums.txt`, then:

```bash
docker compose pull node
docker compose up -d postgres   # the one-off migration command needs it; no-op if already up
docker compose run --rm --no-deps --name demos-migrate node bun run migration:show   # read-only; [ ] = pending
# Pending migrations (or a first install): back up the database, then stop the
# node and its reaper (Postgres stays up) and apply them:
docker compose stop reaper node
docker compose run --rm --no-deps --name demos-migrate node bun run migration:run
docker compose up -d --no-build
```

Then confirm the running digest as in step 6 there.

The node does not migrate the database at boot, so the migration step sits between `pull` and `up -d`: the new image is already local and the old node is not yet replaced. Skip the backup, `stop` and `migration:run` lines when `migration:show` lists nothing pending (and this is not a first install). Procedure, including the backup: [docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md).

Volumes (and therefore your identity, chain data, peerlist cache) are preserved.

A development host that builds from source instead: `git pull && ./run --docker -d --build`. Each such update leaves the previous image's layers in the build cache; the [daemon baseline](#docker-daemon-baseline) caps that at 10 GB, otherwise run `docker builder prune -f --filter until=24h` after updating.

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
> Start with `docker system df`. Build cache is the usual culprit after repeated rebuilds: `docker builder prune -af` reclaims it and touches no containers, images or volumes (the next build runs cold). Then prune unused images: `docker image prune -af`. If the cache keeps coming back, apply the [daemon baseline](#docker-daemon-baseline). To reclaim everything: `docker compose down -v` (destructive, wipes identity and chain data).

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
# Remove old Docker versions (on a clean host there is nothing to remove)
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
  sudo apt-get remove -y "$pkg" 2>/dev/null || true
done

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
```

Log out and back in (or run `newgrp docker`, which opens a new shell) so the group applies, then:

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
mise use -g bun@1.4.4    # the version in .bun-version

# Verify Bun
bun -v
```

### 3b. Install Bun without Mise

```bash
# If method 3a does not work, install the same pinned version directly
# (./run refuses any other Bun version)
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"   # the version in .bun-version

# Verify Bun
bun -v
```

### 4. Clone Repository

#### Mainnet validators: a signed release tag

A validator runs a signed release tag, never a branch head (see [docs/runbooks/release.md](docs/runbooks/release.md)). Set `TAG` to the release announced for your network, then verify it before checking it out:

```bash
cd ~
git clone https://github.com/kynesyslabs/node.git
cd node
TAG=vX.Y.Z   # replace with the tag announced on the release thread

git fetch --tags origin stabilisation
# Signers come from the protected branch, not from the tag itself
git show origin/stabilisation:.github/allowed_signers > ~/demos-allowed-signers
git config gpg.ssh.allowedSignersFile ~/demos-allowed-signers
# The tag must be on stabilisation and signed by a listed key;
# the checkout runs only when both checks pass
git merge-base --is-ancestor "$TAG" origin/stabilisation && echo "on stabilisation" &&
git verify-tag "$TAG" &&
git checkout "$TAG"
```

`git verify-tag` must print `Good "git" signature for <signer> with ED25519 key SHA256:<fingerprint>`, and the signer and fingerprint must be one of the release signers published outside GitHub (see [docs/runbooks/release-signing-key.md](docs/runbooks/release-signing-key.md)). If the block stops before the checkout, or `on stabilisation` is not printed, stop and ask on the release thread. The checkout leaves a detached `HEAD`, which is expected. To upgrade, repeat these steps with the next tag; do not use `./run -U`, which pulls a branch head.

#### Testnet and development: the `testnet` branch

Testnet nodes and contributors follow the `testnet` branch instead. It is unsigned and moves with every merge, so do not run it on mainnet.

```bash
cd ~
git clone -b testnet https://github.com/kynesyslabs/node.git
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
./run -c true
```

The node no longer migrates the database at boot, and a plain `./run` does not create the schema on an empty database. `-c true` deletes the launcher's Postgres data (`postgres_<PG_PORT>/data_<PG_PORT>`) and then creates the schema on the empty database; nothing else is touched, and on a brand-new host there is no data to lose. The launcher's `postgres_<PG_PORT>` folder does not exist until the first `./run`, so there is no Postgres to start by hand yet. Run later starts as plain `./run`: never repeat `-c true` on a host with data. On later runs, when the folder exists, you can instead start the launcher's Postgres with `cd postgres_<PG_PORT>` and run `bun run migration:run` against it (see [docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md)). For an upgrade: back up, then `bun run migration:show` / `bun run migration:run` before `./run`, per the same runbook.

Running the node the first time will generate a private key for your node and store it in the `.demos_identity` file by default. The public key is printed on the terminal and saved in a `publickey_*` file in the same directory.

A mainnet validator does not do this: its key is generated on a trusted machine and copied in as `.demos_identity` (mode 600) before the first start, as in step 3 of [Run a released image](#run-a-released-image-validators). With `PROD=true` in `.env` the node stops instead of creating a key, so a missing file is never silently replaced.

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

Mainnet validators run Track 1 with the released image. A bare-metal node keeps the published genesis file and snapshot outside the checkout and points `DEMOS_GENESIS_FILE` and `DEMOS_SNAPSHOT_DIR` in `.env` at them (absolute paths). Never copy them over `data/genesis.json` or `data/snapshot/`: those are tracked files, the node would then report its build as dirty, and the launch go/no-go check does not count a dirty build as the release. A named genesis file that is missing stops the node at boot. Run with the release tag checked out and nothing else changed (`git status` shows no modified tracked files). Also set the genesis pins and validator settings from [Pin the network's genesis](#joining-the-network--required-steps-before-real-world-use) (`EXPECTED_GENESIS_HASH`, `EXPECTED_GENESIS_BLOCK_HASH`, `PROD=true`, `DEMOS_REQUIRE_VALIDATORS=true`, `FORK_SCHEDULE_MISMATCH_POLICY=abstain`) and run `./scripts/node-doctor --production --env-from env` before starting: without `--env-from env` the doctor reads the Docker settings whenever `docker-compose.yml` and Docker are present, not the `.env` and environment a bare-metal node uses. `./run` does not set `NODE_ENV=production`, so a missing pin only shows as a warning at boot.

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

`clean.sh` empties the database and the node does not create the schema at boot: run `bun run migration:run` from the node checkout before starting the node (`./run -c true` does it for you; see [docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md)).

**Missing dependencies**

```bash
# Reinstall exactly what bun.lock pins; never delete or regenerate bun.lock
rm -rf node_modules
bun install --frozen-lockfile
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

   Track 1 users: see the volume backup snippet above. Track 2 users: stop the node and copy the identity file together with its signing state files (`.demos_identity.*`, see [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md)). Encrypt every backup (for example `gpg --symmetric` or `age`) and keep it off the host.

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
| 53551       | OmniProtocol | P2P communication (TCP)                 |
| 9095        | Gossip       | Gossip sidecar (TCP)                    |
| 7047        | TLSNotary    | TLSNotary server                        |
| 55688       | WS Proxy     | TLSNotary WebSocket proxy the node advertises (TCP) |
| 55000-57000 | WS Proxy     | Per-session TLSNotary proxies on bare metal (TCP); under Docker 55000-55063 on loopback, for a host reverse proxy |
| 123 (out)   | NTP          | Outbound UDP; the node does not start without a trusted clock |

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
