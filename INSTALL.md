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

Validators keep time with the host's NTP service (chrony or `systemd-timesyncd`). The node uses the host clock as is and never corrects it itself: block timestamps, block checks and the peer authentication windows all read that one clock, so no single time server can move a validator's time. A Docker container shares the host's clock, so the host's NTP covers it.

The node only measures the host clock. At boot and every 10 minutes it asks `pool.ntp.org`, `time.google.com`, `time.windows.com` and `time.apple.com`, takes the median of the answers that agree within 2 seconds (at least two must), logs the offset and publishes it as `demos_clock_offset_seconds`. It warns above 1 second: members refuse to sign a block stamped more than 5 seconds ahead of their own clock. With `PROD=true` it refuses to start when two or more servers agree the host is more than 5 seconds ahead or behind, the gap members accept between a block timestamp and their clock: ahead, every block it stamps as secretary is refused and the round stalls; behind, it refuses honest blocks. When no server answers, or they disagree, the node starts on the host clock and logs a warning.

Check the host's sync:

```bash
timedatectl            # "System clock synchronized: yes" and "NTP service: active"
# or, with chrony installed:
chronyc tracking       # "Leap status : Normal", "System time" well under 1 second
```

If NTP is off: `sudo timedatectl set-ntp true`.

---

## Track 1: Docker Compose (recommended)

### Prerequisites

That's the whole list:

- **Docker** 20.10 or newer
- **Docker Compose** v2 (the `docker compose` plugin, not the legacy `docker-compose` Python script)
- **git** 2.34 or newer with `ssh-keygen` (Ubuntu 22.04 ships both), to verify the signed release tag
- **python3** (Ubuntu ships it), which the validator steps and `scripts/node-doctor` use to read `docker compose config`

No Bun, no Postgres, no Rust toolchain on the host. Everything else runs inside containers.

Verify:

```bash
docker --version
docker compose version
git --version
python3 --version
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
- Grafana: http://localhost:3000 (`admin` / the `GRAFANA_ADMIN_PASSWORD` you set in `.env`; the monitoring profile does not start without it)
- Prometheus: http://localhost:9091

### Run a released image (validators)

A validator runs the image the release workflow published, pinned by tag and digest, and starts it without building. Every value below comes from the release announcement: the tag, its `checksums.txt`, the network's `genesis.json`, `snapshot.tar` and `SHA256SUMS`, the published hashes, the signer fingerprints and the peer list. Nothing is copied from an older release or another install. Each step ends with what it must print; stop at the first one that prints anything else and ask on the release thread.

Track 1's prerequisites apply, plus `python3` on the host (Ubuntu ships it): node-doctor and the volume-name lookup below use it.

**1. Check out the signed release tag.** The compose file and scripts must come from the same commit as the image. Use a directory of its own for each install (a second node on this host gets a second clone; see [More than one install on a host](#more-than-one-install-on-a-host)).

```bash
git clone https://github.com/kynesyslabs/node.git demos-node && cd demos-node
TAG=vX.Y.Z   # replace with the tag announced on the release thread

git fetch --tags origin stabilisation
# Signers come from the protected branch, not from the tag itself. The list
# is kept inside this clone's .git, so another install cannot overwrite it.
SIGNERS="$(git rev-parse --absolute-git-dir)/demos-allowed-signers"
git show origin/stabilisation:.github/allowed_signers > "$SIGNERS"
git config gpg.ssh.allowedSignersFile "$SIGNERS"
# The tag must be on stabilisation and signed by a listed key;
# the checkout runs only when both checks pass
git merge-base --is-ancestor "$TAG" origin/stabilisation && echo "on stabilisation" &&
git verify-tag "$TAG" &&
git checkout "$TAG"
```

It must print `on stabilisation`, then `Good "git" signature for <email> with ED25519 key SHA256:<fingerprint>`. A good signature only says that some key in the list signed the tag, so check who:

- `<email>` must be one of the holders the release announcement names as signer of this tag.
- `SHA256:<fingerprint>` must equal the fingerprint that holder published outside GitHub (the announcement channel; see [docs/runbooks/release-signing-key.md](docs/runbooks/release-signing-key.md), "Publish the fingerprint"). Do not take it from the repository: whoever can push to it could have changed both the key and its fingerprint there.

To see every listed key with its fingerprint: `while read -r who _ type key; do printf '%s ' "$who"; echo "$type $key" | ssh-keygen -lf -; done < "$SIGNERS"`. A good signature from a key you cannot match to a published fingerprint is a failure. The checkout leaves a detached `HEAD`, which is expected.

**2. Check the release files.** Keep them in `mainnet/` inside the checkout (git ignores that directory). They come from two places:

- `checksums.txt` belongs to the release you install: take it from that release's announcement (the release stays a draft until the validators confirm the digest).
- `genesis.json`, `snapshot.tar`, `SHA256SUMS` and the genesis record (the four values of step 4) belong to the network and stay the same from release to release until a genesis is reissued. They are assets of the network's launch release on GitHub (the published release of the launch tag, or of the release that last reissued the genesis), and the same record is pinned in the validator channels outside GitHub ([docs/mainnet/genesis-hash.md](docs/mainnet/genesis-hash.md), "Publication"). A first install from a later release takes them from there, not from the later announcement, and compares the record in at least two of those channels.

```bash
mkdir -p mainnet
# copy checksums.txt (this release) and genesis.json, snapshot.tar, SHA256SUMS (the network's launch release) into mainnet/
[ "$(sed -n 's/^commit: //p' mainnet/checksums.txt)" = "$(git rev-parse HEAD)" ] && echo "commit matches"
(cd mainnet && sha256sum -c SHA256SUMS) &&
sha256sum mainnet/genesis.json &&
tar -xf mainnet/snapshot.tar -C mainnet &&
sha256sum mainnet/snapshot/manifest.json
```

It must print `commit matches` (the image was built from the commit you checked out), `OK` for every file in `SHA256SUMS`, a `genesis.json` sha256 equal to the "genesis file sha256" of the published record, and a manifest sha256 equal to its "snapshot manifest sha256". `SHA256SUMS` travels with the files, so it only shows they arrived intact; the record in the channels is what shows they are the published ones. The genesis file sha256 matters on its own: the hashes of step 4 ignore formatting, so a reformatted file passes them, and the go/no-go call counts only validators that acknowledged the published file sha256 ([docs/mainnet/genesis-hash.md](docs/mainnet/genesis-hash.md)). Post it on the release thread. The archive unpacks to `mainnet/snapshot/` (`manifest.json` and the `.jsonl` files it lists); if it unpacks anywhere else, use that directory in place of `mainnet/snapshot` below. Never edit these files: even a changed validator URL or a different key order builds another block 0, and that node cannot join ([docs/mainnet/genesis.md](docs/mainnet/genesis.md)).

**3. Configure.** `cp .env.example .env && chmod 600 .env`, then set:

```env
IMAGE_NAME=ghcr.io/kynesyslabs/node
IMAGE_TAG=vX.Y.Z@sha256:<digest>   # the image: line of mainnet/checksums.txt, after "ghcr.io/kynesyslabs/node:"
RPC_PORT=53550
EXPOSED_URL=http://YOUR_PUBLIC_IP:53550
COMPOSE_PROFILES=tlsnotary
TLSNOTARY_ENABLED=true
```

- **`EXPOSED_URL`** is the address peers and clients reach this node's RPC at. Its port is the `RPC_PORT` you publish (change both together; a port forwarded by NAT or served by a proxy is the outside one), and it must be exactly the `connection_url` the network's genesis lists for your key: the release owner builds the genesis from the URL you sent, and clients read it from there (`getValidatorSet`). If the two differ, send the release owner the right URL before launch rather than editing the genesis.
- **`COMPOSE_PROFILES`.** Block production needs neither TLSNotary nor monitoring. `tlsnotary` runs the notary sidecar for SDK clients that attest HTTPS responses; without it, set `COMPOSE_PROFILES=` and `TLSNOTARY_ENABLED=false`. `monitoring` adds Prometheus and Grafana and does not start without `GRAFANA_ADMIN_PASSWORD` (any strong password other than `demos`); a validator that runs it sets both. Leave out `reaper` (it mounts the Docker socket) and `neo4j`.
- **TLSNotary clients.** With the `tlsnotary` profile the notary port (`TLSNOTARY_PORT`) is published on every interface. The node service publishes the advertised proxy port (`TLSNOTARY_PROXY_PORT`) on every interface and the per-session proxies (`TLSNOTARY_PROXY_PORT_MIN`-`MAX`) on loopback whatever the profiles, so those ports must be free on the host even with TLSNotary off (nothing answers on them then). A browser reaches the per-session proxies only through a reverse proxy on this host that routes `/tlsn/<port>/`: the `proxy` profile (Caddy; `TLSNOTARY_PROXY_MODE` picks `subpath`, `subdomain` or `direct` and matters only there) or your own nginx, as in [docs/runbooks/tlsn-reverse-proxy.md](docs/runbooks/tlsn-reverse-proxy.md). A validator that does not offer attestation to browsers needs neither. Pick `TLSNOTARY_PORT` so that it is not any peer's `RPC_PORT` + 1: a node in `OMNI_ONLY` mode dials a peer that has not advertised its `OMNI_PORT` at its RPC port + 1 (the node logs a reminder of this at every start; see Troubleshooting). In the default `OMNI_PREFERRED` mode a node dials only the `OMNI_PORT` a peer advertised in its signed hello reply, and uses HTTP for peers that advertise none.
- **Ports.** Every published port and the variable that moves it are in [Network Exposure](#network-exposure). Check that each one is free (`ss -ltn`) before the first start.
- **Another install on this host** also sets `INSTANCE_SUFFIX` and `COMPOSE_PROJECT_NAME` and moves every port: see [More than one install on a host](#more-than-one-install-on-a-host).

Then add the mainnet parameter sheet, the block timing, fees, stake floor and validator mode every validator runs with the same values ([docs/mainnet/parameters.md](docs/mainnet/parameters.md) says what each one does):

```bash
cat docs/mainnet/parameters.env >> .env
```

Appended lines win over earlier lines of the same name (for example the `PROD=false` that `.env.example` ships with), both for Docker and for the node, so the repeated keys are expected. Do not edit them: step 7 fails on any value that differs from the sheet.

Mount the published genesis file and snapshot read-only instead of the files bundled in the image, which belong to the testnet. Create `docker-compose.override.yml` in the checkout (git ignores it; compose reads it automatically):

```yaml
services:
  node:
    volumes:
      - ./mainnet/genesis.json:/app/data/genesis.json:ro
      - ./mainnet/snapshot:/app/mainnet-snapshot:ro
    environment:
      DEMOS_SNAPSHOT_DIR: /app/mainnet-snapshot
```

The files must exist before any compose command runs: Docker creates an empty directory in place of a missing bind-mounted file.

Last, read back the names compose gives this install. The commands in the following steps use them; set them again in every new shell:

```bash
STATE_VOLUME=$(docker compose config --format json |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["volumes"]["node_state"]["name"])')
SUFFIX=${STATE_VOLUME#demos_node_state}                         # INSTANCE_SUFFIX, empty by default
HELPER_IMAGE=$(docker compose config --images | grep '^postgres:')  # pinned by digest in docker-compose.yml
echo "state volume $STATE_VOLUME, helper image $HELPER_IMAGE"
```

**4. Pull the image and check the genesis with it.** The released image carries Bun and the script that prints the values the network publishes:

```bash
docker compose pull node &&
docker compose run --rm --no-deps node bun scripts/genesis-hash.ts \
  --genesis /app/data/genesis.json --snapshot /app/mainnet-snapshot
```

If the pull is refused with `denied` or `unauthorized`, the image is not public yet: log in once with a GitHub token that has only the `read:packages` scope (`docker login ghcr.io -u <github user>`, paste the token at the prompt) and pull again.

The script must exit 0 and print no `problem:` line, and these four values must equal the announcement:

| Printed | Announced as |
|---|---|
| `EXPECTED_GENESIS_HASH=...` | genesis hash |
| `EXPECTED_GENESIS_BLOCK_HASH=...` | genesis block hash (block 0) |
| `fork schedule digest: ... (chain id N)` | fork schedule digest and chain id |
| `snapshot manifest sha256: ...` | snapshot manifest sha256 (also checked in step 2) |

A `problem:` line names what a node would refuse in these files, or why it could never forge on them: a `shardSize` outside the range the node accepts, fewer validators active at block 0 (status `"2"`, `valid_at` 0) than the quorum of `shardSize`, a validator URL no peer can dial. Report it on the release thread; the release owner reissues the genesis. Then copy the two `EXPECTED_...` lines into `.env`.

This `run` also creates the install's volumes, labelled as this compose project, so `docker compose down -v` removes them later.

**5. Put the key in place.** A validator key is generated on a trusted machine, not on the validator host, and backed up encrypted with a second person ([docs/runbooks/validator-key.md](docs/runbooks/validator-key.md)). On that machine, from a checkout of the same tag, with the Bun version named in the checkout's `.bun-version` (`curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`) and the dependencies installed (`bun install --frozen-lockfile`):

```bash
(umask 077 && bun scripts/gen-test-identity.ts --name validator)
# prints pubkey=0x...; writes .test-identity/validator.mnemonic (mode 600, the key)
# and .test-identity/validator.pubkey (the public key) in a directory of mode 700
```

The script also makes the throwaway keys of the test networks, hence its name; `--name` only names the two files. Send the public key (and your `EXPOSED_URL`) to the release owner, keep the mnemonic with your encrypted backup, and delete `.test-identity/` from the checkout once both are stored.

Copy only the mnemonic file to the validator host over a secure channel, into a directory of its own outside the checkout, for example `install -d -m 700 ~/demos-seed`, then `scp` it there. Seed it into this install's state volume and delete the copy:

```bash
docker compose create --no-build node &&   # makes sure compose owns the volumes
docker run --rm --entrypoint sh \
  -v "$STATE_VOLUME":/state \
  -v "$HOME/demos-seed/validator.mnemonic":/seed/key:ro \
  "$HELPER_IMAGE" -c 'cp /seed/key /state/.demos_identity && chown 1000:1000 /state /state/.demos_identity && chmod 700 /state && chmod 600 /state/.demos_identity' &&
shred -u "$HOME/demos-seed/validator.mnemonic" && rmdir "$HOME/demos-seed"
```

The helper is the Postgres image the stack already uses, pinned by digest, so no unpinned image handles the key. The `chown` of `/state` itself matters: the node (uid 1000) must write its signing state files next to the key. With `PROD=true` the node never creates a key by itself: a missing key stops it, which is what you want when the volume did not mount.

**6. Seed the peer list.** A validator on a network with other validators needs their addresses before its first start; see [Joining the network](#joining-the-network--required-steps-before-real-world-use), step 2, which writes this install's own file into `$STATE_VOLUME`.

**7. Check the host.**

```bash
./scripts/node-doctor --production --env-from compose
```

It prints one PASS, WARN or FAIL line per item (every value in `docs/mainnet/parameters.env`, clock sync, outbound NTP, genesis pins, the mounted genesis file, one-start switches left set) and exits 1 on any FAIL. It reads the values and mounts the node container will get from `docker compose config`, so run it from the checkout with `.env` and the override in place. `--env-from compose` makes it fail rather than fall back to `.env` when it cannot read the compose settings. The genesis lines fail when `/app/data/genesis.json` is not mounted from the host, when `properties.shardSize` is outside the range the node accepts, when the validator set block 0 seeds (the snapshot's `validators.jsonl` when it has one, otherwise the genesis `validators`) holds fewer validators active at block 0 (status `"2"`, `valid_at` 0) than the quorum of `shardSize` (2/3 + 1: 7 of 10), and on a validator `connection_url` of that set that is not an http(s) URL with a host (and, if it names a port, one in 1-65535). A validator without a URL passes that check: `null` anywhere, and a missing or empty URL in a snapshot row, since the node accepts those rows. A PASS therefore does not mean every validator can be dialed; check those validators' addresses against the peer list of the announcement. Fix every FAIL, and check every WARN by hand, before the next step.

**8. Create the database schema and start without building.**

```bash
docker compose up -d --wait postgres &&
docker compose run --rm --no-deps --name "demos-migrate$SUFFIX" node bun run migration:run &&
docker compose up -d --no-build
```

The node does not create or migrate its database at boot: on a new host the schema (block 0 needs tables such as `accepted_fork_schedule` and `genesis_imported_identities`) comes from the one-off `migration:run`, run by the released image itself against the Postgres that `up -d --wait postgres` started and waited for. Without it the node stops at boot and tells you to run it. The `&&` stops the chain at the first failure, so the node never starts on a missing or half-applied schema. Later starts skip the migration step unless a release adds a migration (see [Update the node](#update-the-node)). `--no-build` matters: without it, compose falls back to building the image locally when the image is missing, and you would run your own build instead of the release.

Then wait until the node is healthy. The first start imports the snapshot and writes block 0 before the RPC answers, which takes a few minutes:

```bash
NODE_CONTAINER=$(docker compose ps -aq node)
while :; do
  state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NODE_CONTAINER")
  case "$state" in
    "running healthy") echo "node healthy"; break ;;
    "running unhealthy") echo "node runs but its health check fails: see docker compose logs node" >&2; break ;;
    running*) sleep 10 ;;
    *) echo "node is $state: see docker compose logs node" >&2; break ;;
  esac
done
```

It must print `node healthy`. Anything else means the node stopped or fails its health check: `docker compose logs --tail 50 node` names the reason (a genesis it refuses, a missing key or schema), and steps 9 and 10 have nothing to inspect until it runs.

**9. Confirm the digest you run** and post it on the release thread:

```bash
docker image inspect --format '{{index .RepoDigests 0}}' \
  "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q node)")"
```

It must print `ghcr.io/kynesyslabs/node@sha256:<the digest in checksums.txt>`.

**10. Confirm the parameters the container got.** Compose passes a variable to the node only when `docker-compose.yml` lists it, so check inside the running container, not `.env`:

```bash
diff <(grep -E '^[A-Z_0-9]+=' docs/mainnet/parameters.env | sort) \
  <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(docker compose ps -q node)" |
    grep -E "^($(grep -oE '^[A-Z_0-9]+' docs/mainnet/parameters.env | paste -sd'|'))=" | sort) &&
  echo "parameters match"
```

It must print `parameters match`. Any other output is a key the container lacks (`<`) or holds with another value (`>`). Post the output with the digest.

**11. Confirm the node forges.** Once enough validators are online (the quorum of `shardSize`), the height grows by about one block per `CONSENSUS_TIME` (10 s) and your key signs blocks; [Connect to the RPC](#connect-to-the-rpc) has the two calls. Until the quorum is online the node logs that the committee is below its floor, which is expected (see [Troubleshooting](#troubleshooting)).

### Environment file

`.env.example` is the canonical template. Copy it to `.env` and edit. The variables you actually care about:

| Variable | Default | Notes |
|----------|---------|-------|
| `TLSNOTARY_ENABLED` | `true` | Set to `false` to skip TLSNotary entirely. |
| `TLSNOTARY_SIGNING_KEY` | _(empty)_ | **Leave empty in docker mode (the default).** The TLSNotary sidecar manages its own key. Only set this if you've switched `TLSNOTARY_MODE` to `ffi` (in-process Rust binding). |
| `RPC_PORT` | `53550` | Host-mapped port for the node RPC. Change if 53550 is taken. |
| `EXPOSED_URL` | `http://localhost:53550` | Public URL advertised to peers. Set to your public IP/domain when running on a VPS. |
| `EXPECTED_GENESIS_HASH` | _(empty)_ | The network's published genesis hash. Required on mainnet in every mode, and in the image (`NODE_ENV=production`) unless `DEMOS_ALLOW_UNPINNED_GENESIS=true`; see "Pin the network's genesis" below. |
| `EXPECTED_GENESIS_BLOCK_HASH` | _(empty)_ | The network's published block 0 hash. Optional; when set, the node refuses any other block 0. |
| `DEMOS_REQUIRE_VALIDATORS` | _(empty)_ | `true` on mainnet validators: with no active validators in the database the node refuses to run consensus instead of using every online peer as the committee. |
| `PROD` | `false` | `true` on validators. The node then refuses to start with a loopback or missing `EXPOSED_URL`, without the commit it was built from, or without its identity file (it never creates a new key on its own; see [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md), "Production refusals"). |
| `CONSENSUS_TIME`, `BLOCK_TIMESTAMP_MIN_DELTA`, `BLOCK_TIMESTAMP_TOLERANCE`, `NETWORK_FEE`, `RPC_FEE`, `BURN_FEE`, `RPC_FEE_PERCENT`, `MIN_VALIDATOR_STAKE`, `ZK_ATTESTATION_POINTS` | _(empty: built-in values)_ | Chain-wide: every validator runs the same values. Mainnet validators copy them from [docs/mainnet/parameters.env](docs/mainnet/parameters.env); `./scripts/node-doctor --production` fails on any other value. |
| `FORK_SCHEDULE_MISMATCH_POLICY` | `abstain` | What a validator does when its fork schedule differs from most validators' before a fork. Mainnet runs `abstain` only; `warn` is for devnets and testnets, and the node refuses it together with `DEMOS_REQUIRE_VALIDATORS=true`. See [docs/runbooks/fork-schedule-policy.md](docs/runbooks/fork-schedule-policy.md). |
| `IMAGE_NAME` / `IMAGE_TAG` | `demos-node` / `local` | The node image. Validators set the released image and `tag@sha256:digest`; the defaults name a local build. |
| `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` | `demosuser` / `demospassword` / `demos` | Postgres credentials. Change `PG_PASSWORD` if you're paranoid; it never leaves the compose network. |
| `METRICS_ENABLED` / `METRICS_PORT` | `true` / `9090` | Prometheus scrape endpoint on the node. |
| `GRAFANA_ADMIN_PASSWORD` | _(none, required)_ | Grafana admin password. The monitoring profile refuses to start while it is empty or `demos`. |
| `L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET` | `50000` | Most executed L2PS transactions one subnet may have waiting for a batch. At the cap new ones are refused with `L2PS_BACKLOG_FULL` (HTTP 429, or a retry-later error on the messaging socket) until the aggregator catches up. `0` turns the limit off; the hash cycle then sorts the whole queue every few seconds, with no bound and without the primary-key index, so only do that on a node with a small subnet. A positive value must be at least `L2PS_MIN_BATCH_SIZE`, and a negative one is refused, or the node does not start. |
| `L2PS_AGGREGATOR_MAX_BATCHES_PER_CYCLE` | `5` | Batches (each up to `L2PS_MAX_BATCH_SIZE` transactions, capped by the ZK circuit size) the L2PS aggregator builds per subnet per cycle. Raise it if a busy subnet's queue keeps growing; each batch costs one ZK proof when proofs are on. At most 100. |
| `L2PS_MESSAGING_SEND_RATE` | `5` | Messages per second one sender key may send through the messaging relay once its burst is spent. Over it the sender gets `RATE_LIMITED` with a retry time and keeps its socket. `0` turns the limit off. |
| `L2PS_MESSAGING_SEND_BURST` | `30` | Messages a sender key may send at once before the rate applies. |
| `L2PS_MESSAGING_BACKLOG_SHARE` | `0.5` | Largest fraction of `L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET` that messaging may hold, so RPC transactions keep the rest. `1` gives messaging all of it. |
| `COMPOSE_PROFILES` | `monitoring,tlsnotary` | Which compose profiles are active. A validator sets `tlsnotary` (or nothing); `monitoring` needs `GRAFANA_ADMIN_PASSWORD`. See [Profiles](#profiles). |
| `INSTANCE_SUFFIX` / `COMPOSE_PROJECT_NAME` | _(empty)_ / _(directory name)_ | Set both on every install but one when a host runs more than one; see [More than one install on a host](#more-than-one-install-on-a-host). |

Under docker compose a variable reaches the node only when `docker-compose.yml` lists it in the node's `environment:`; a value in `.env` that is not listed there does nothing. Every node variable in this table is listed.

Leave `PG_HOST=postgres` and `TLSNOTARY_HOST=tlsnotary` exactly as shipped — those are the in-network service names. They are only `localhost` for the bare-metal path (Track 2).

### Joining the network — required steps before real-world use

A fresh node joins no network by itself: it starts from the genesis bundled in the image (the testnet's) and knows no peer. To participate in the actual Demos testnet/mainnet, you must do **three things** before the node's first start. A validator does them as part of [Run a released image](#run-a-released-image-validators) (steps 3, 4 and 6); a source build does them here.

A node forges only while at least the quorum of the genesis `shardSize` (2/3 + 1: 7 of 10, 3 of 3) of its validators are online. A genesis whose validator set has fewer validators active at block 0 than that never gets past block 0. The smallest `shardSize` a node accepts is 3, with a quorum of 3, so a network of fewer than 3 validators never forges: a rehearsal needs at least 3 validators at `shardSize` 3. `genesis-hash.ts` and `node-doctor --production` report such a genesis before the start.

**1. Set `EXPOSED_URL` to your reachable address.**

The default `http://localhost:53550` is fine for local dev but useless for any peer trying to connect to you. Before going live:

```env
# In .env
EXPOSED_URL=http://YOUR_PUBLIC_IP:53550
# or for a DNS name:
EXPOSED_URL=http://node.example.com:53550
```

The port is the `RPC_PORT` you publish: change both together. A validator's `EXPOSED_URL` is exactly the `connection_url` the genesis lists for its key.

If running behind NAT, port-forward `RPC_PORT` (53550), `OMNI_PORT` (53551) and `GOSSIP_PORT` (9095) to this host. The firewall section below has the exact rules.

**2. Provide a bootstrap peer list.**

The node persists its peer list in its state volume (`demos_node_state`, plus `INSTANCE_SUFFIX` when set) at `demos_peerlist.json`. On a brand-new node this file is empty (only the node itself), so it cannot discover other peers. To bootstrap, write the known peers into that volume before the first start. Each entry maps a peer's public key (its identity, which the peer must prove by signing) to that peer's full `EXPOSED_URL`, exactly as announced, port included (a peer may publish another `RPC_PORT` than 53550); an entry with `null` as the URL is skipped with `Invalid peer data format`. Leave your own key out: the node adds itself. On a validator network list every other validator.

Run this from the checkout, with `STATE_VOLUME` and `HELPER_IMAGE` set as in [step 3](#run-a-released-image-validators) of the released-image install (a source build sets them the same way):

```bash
# This install's own file, outside the checkout
install -d -m 700 "$HOME/demos-peers$SUFFIX"
cat > "$HOME/demos-peers$SUFFIX/demos_peerlist.json" <<EOF
{"0x<peer 1 public key>": "<peer 1 EXPOSED_URL, e.g. http://203.0.113.10:53550>",
 "0x<peer 2 public key>": "<peer 2 EXPOSED_URL, e.g. http://node2.example.com:54550>"}
EOF

docker compose create --no-build node &&   # makes sure compose owns the volumes
docker run --rm --entrypoint sh \
  -v "$STATE_VOLUME":/state \
  -v "$HOME/demos-peers$SUFFIX/demos_peerlist.json":/seed/demos_peerlist.json:ro \
  "$HELPER_IMAGE" -c 'cp /seed/demos_peerlist.json /state/ && chown 1000:1000 /state /state/demos_peerlist.json'
```

Do not start the node yet: it needs the genesis pins of step 3 first.

Use the keys and URLs the release announcement lists (or, on testnet, the current bootstrap nodes from the team). The node will merge any peers it learns from these into the file as it runs.

**3. Pin the network's genesis.**

The image runs with `NODE_ENV=production`, and a production node refuses to start (exit code 1) unless it knows which genesis it joins. Set the hash the network publishes:

```env
# In .env
EXPECTED_GENESIS_HASH=<published genesis hash>
EXPECTED_GENESIS_BLOCK_HASH=<published block 0 hash>
# Validators: PROD, DEMOS_REQUIRE_VALIDATORS, FORK_SCHEDULE_MISMATCH_POLICY
# and the chain-wide values come from the parameter sheet
# (cat docs/mainnet/parameters.env >> .env)
```

`scripts/genesis-hash.ts --genesis <file> --snapshot <dir>` prints both values for a genesis file and the snapshot it declares; the block 0 hash is the one labelled "genesis block hash". Without `--snapshot` it reads `DEMOS_SNAPSHOT_DIR`; a genesis that declares a snapshot and gets none is reported as a problem. A Docker host has no Bun: run it inside the image, as in step 4 of [Run a released image](#run-a-released-image-validators). What each hash covers, and where mainnet's are published, is in [docs/mainnet/genesis-hash.md](docs/mainnet/genesis-hash.md).

A validator never leaves these set in `.env`: `DEMOS_ALLOW_UNPINNED_GENESIS`, and the one-start switches `DEMOS_GENERATE_IDENTITY`, `DEMOS_IDENTITY_TAKEOVER`, `DEMOS_SIGNING_RECORD_REBIND` and `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST`. Each of the last four is for the single start that needs it (see [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md) and below); remove it once the node runs. `./scripts/node-doctor --production` fails while any of them is set.

At every start the node checks it before it signs anything: on an empty database against the genesis file (`data/genesis.json`, or `DEMOS_GENESIS_FILE`) and the snapshot that genesis declares, before block 0 is written; on an existing database against the stored block 0. A mismatch stops the node with exit code 1 and leaves the database as it was. A network that publishes no hash can opt out with `DEMOS_ALLOW_UNPINNED_GENESIS=true`; mainnet validators never set it. A node started without a pin and without that opt-out (a bare-metal `./run` install runs as development, so nothing refuses it) logs a `[GENESIS] EXPECTED_GENESIS_HASH is not set` warning at every boot.

The genesis hash leaves out the validators' `connection_url` and the order of the keys in the file, and block 0 does not, so two files with the same genesis hash can still build different blocks 0. `EXPECTED_GENESIS_BLOCK_HASH` closes that: an empty database refuses to write any other block 0, and an existing one refuses to boot on it.

On mainnet, mount the published genesis file and snapshot read-only instead of using the files bundled in the image, which belong to the testnet, with the `docker-compose.override.yml` of step 3 of [Run a released image](#run-a-released-image-validators). Use the files exactly as published and check them against the announcement; never edit them ([docs/mainnet/genesis.md](docs/mainnet/genesis.md)).

The node also remembers the fork schedule it last ran with. A restart whose `data/genesis.json` adds, moves or removes a fork at or below the current height plus 50 blocks is refused, and the refusal names the change. If every operator agreed to that exact schedule, restart once with `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST` set to the digest the refusal prints. See `docs/design/genesis-enforcement.md`.

With all three in place, start the node. A validator runs `./scripts/node-doctor --production` first and starts only when it passes (steps 7 and 8 of the release-image install above); a source build starts with `./run --docker -d`.

#### After the genesis is reissued

A reissued genesis (new published hashes) is a new chain: the stored block 0 no longer matches the new pins, so the node refuses to boot on its old database. Start the install over from step 2 of [Run a released image](#run-a-released-image-validators), keeping the checkout and `.env`:

1. Replace the files in `mainnet/` with the new ones and repeat step 2.
2. Remove this install's containers and volumes, the copy of the key among them (the reseed takes the mnemonic from your backup):

   ```bash
   docker compose down -v
   ```

3. Repeat steps 4 to 8: check the new genesis and put its two pins in `.env`, reseed the key and the peer list, run node-doctor, migrate and start.

The key stays the same; only its copy in the volume is replaced. Its signing records (`.demos_identity.signed.json` and the others in [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md), "Signing state files") belong to the old chain and go with the volume, which is safe because that chain is abandoned. To keep the state volume instead, remove only the database and data volumes (`docker compose down`, then `docker volume rm` the `demos_pgdata` and `demos_node_data` volumes of this install, suffix included) and, if the key had signed blocks on the old chain, start once with `DEMOS_SIGNING_RECORD_REBIND=true` and remove it again ([docs/runbooks/validator-key.md](docs/runbooks/validator-key.md), "After a chain reset").

### Network Exposure

When running on a VPS or any machine you want peers to connect to, you must allow inbound connections on these ports. Each row names the `.env` variable that moves it; Docker publishes host and container port 1:1, so the node listens on the same number.

| Port | Variable | Protocol | Purpose |
|------|----------|----------|---------|
| 53550 | `RPC_PORT` | TCP | Node RPC (HTTP); the port in `EXPOSED_URL` |
| 53551 | `OMNI_PORT` | TCP | OmniProtocol (peer-to-peer binary RPC; peers dial the port the node advertises, so publish it on the same number) |
| 9095 | `GOSSIP_PORT` | TCP | Gossip; peers dial `EXPOSED_URL`'s host on this port |
| 3005 | `RPC_SIGNALING_PORT` | TCP | WebRTC signaling for instant-messaging clients; consensus does not use it. Published on every interface |
| 7047 | `TLSNOTARY_PORT` | TCP | TLSNotary notary, published on every interface whenever the `tlsnotary` profile is on |
| 55688 | `TLSNOTARY_PROXY_PORT` | TCP | TLSNotary WebSocket proxy port the node advertises. The node service always publishes it, so it must be free even with TLSNotary off; it answers only with TLSNotary on |
| 123 | | UDP, outbound | NTP: the host's time service, and the node's clock offset check (see [Clock](#clock)) |

These are published on loopback (or the interface the `*_BIND` variable names), or not at all, and should NOT be exposed publicly:

| Port | Variable | Why |
|------|----------|-----|
| 5432 | | Postgres: internal compose network only, not published |
| 3001 | `RPC_MCP_PORT` | MCP: not published ([docs/runbooks/mcp-security.md](docs/runbooks/mcp-security.md)) |
| 3006 | `L2PS_MESSAGING_PORT` | L2PS messaging WebSocket, on `L2PS_MESSAGING_BIND` (loopback by default); nothing listens while `L2PS_MESSAGING_ENABLED=false` |
| 9090 | `METRICS_HOST_PORT` | Node metrics, on `METRICS_BIND` (loopback); a monitoring host off this machine needs a private interface or a tunnel |
| 9091 | `PROMETHEUS_PORT` | Prometheus (`monitoring` profile), on `MONITORING_BIND` (loopback) |
| 3000 | `GRAFANA_PORT` | Grafana (`monitoring` profile), on `MONITORING_BIND` (loopback); only public if you want a public dashboard |
| 9100 | `NODE_EXPORTER_PORT` | node-exporter (`full` profile), on `MONITORING_BIND` (loopback) |
| 55000-55063 | `TLSNOTARY_PROXY_PORT_MIN`, `TLSNOTARY_PROXY_PORT_MAX` | TLSNotary per-session proxies, on loopback only, for a reverse proxy on this host (`/tlsn/<port>/`). The node service always publishes this window, so it must be free even with TLSNotary off; bare metal (no Docker) uses 55000-57000 unless the same variables say otherwise |
| 7474, 7687 | `NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT` | Neo4j (`neo4j` profile), published on every interface: keep the profile off on a validator |
| 80, 443 | | Caddy (`proxy` profile): fixed ports, so only one install per host can run that profile |

`ufw` example for an Ubuntu VPS with the default ports. Allow SSH first, or `ufw enable` locks you out of a remote host:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 53550/tcp comment "Demos RPC"
sudo ufw allow 53551/tcp comment "Demos OmniProtocol"
sudo ufw allow 9095/tcp  comment "Demos gossip"
sudo ufw allow 7047/tcp  comment "Demos TLSNotary"
sudo ufw allow 55688/tcp comment "Demos TLSNotary proxy"
sudo ufw enable
```

`ufw` allows outbound traffic by default, so NTP needs no rule unless your provider's firewall blocks it. Docker publishes container ports through its own iptables rules, ahead of `ufw`: a port published on every interface is reachable whatever `ufw` says, so the loopback bindings in `docker-compose.yml` and the profiles you leave off are what keep a port private. To not expose TLSNotary at all, leave the `tlsnotary` profile off and set `TLSNOTARY_ENABLED=false`: `TLSNOTARY_PROXY_PORT` stays published by the node service, but nothing answers on it.

If you're behind NAT (home server, dev box, etc.), forward the RPC, OmniProtocol and gossip ports from your router to this host. TLSNotary forwarding is optional — only needed if you want peers to use *your* notary container.

Don't forget to set `EXPOSED_URL` in `.env` to the address peers will reach you at (public IP, DNS name, or NAT-mapped hostname), with the RPC port they reach.

### More than one install on a host

Each install is its own clone in its own directory with its own `.env`. Two installs on one host must differ in every fixed name and every published port:

- **`INSTANCE_SUFFIX`** (for example `_b`) is appended to every container, network and volume name: `demos-node_b`, `demos-network_b`, `demos_node_state_b`, `demos_pgdata_b` and so on. Without it the second install would use the first one's volumes, key included.
- **`COMPOSE_PROJECT_NAME`** (for example `demos-b`) keeps the two projects apart for `docker compose ps`, `down`, `down -v` and the volume labels; without it both checkouts named `node` are one project.
- **Ports.** Give the second install its own value for every published port of the tables above, the TLSNotary proxy ports included even when TLSNotary is off (the node service publishes them unconditionally): `RPC_PORT`, `OMNI_PORT`, `GOSSIP_PORT`, `RPC_SIGNALING_PORT`, `L2PS_MESSAGING_PORT`, `METRICS_HOST_PORT`, `TLSNOTARY_PORT`, `TLSNOTARY_PROXY_PORT`, `TLSNOTARY_PROXY_PORT_MIN` and `TLSNOTARY_PROXY_PORT_MAX` (a window of its own), and with the `monitoring` profile `PROMETHEUS_PORT` and `GRAFANA_PORT` (or leave `monitoring` to one install). Only one install can run the `proxy` profile. `EXPOSED_URL` takes the new `RPC_PORT`. Check each port is free with `ss -ltn` before the first start.

```env
INSTANCE_SUFFIX=_b
COMPOSE_PROJECT_NAME=demos-b
RPC_PORT=54550
OMNI_PORT=54551
EXPOSED_URL=http://YOUR_PUBLIC_IP:54550
GOSSIP_PORT=9195
RPC_SIGNALING_PORT=3105
L2PS_MESSAGING_PORT=3106
METRICS_HOST_PORT=9190
TLSNOTARY_PORT=7247
TLSNOTARY_PROXY_PORT=55788
TLSNOTARY_PROXY_PORT_MIN=55100
TLSNOTARY_PROXY_PORT_MAX=55163
COMPOSE_PROFILES=tlsnotary
```

Every command in this guide that names a volume or a container uses the names compose reports for the install it runs in (`$STATE_VOLUME`, `$SUFFIX`, step 3 of [Run a released image](#run-a-released-image-validators)), and each install keeps its signer list, release files, key copy and peer list in its own place. `docker compose down -v` removes only the volumes of the install it runs in. Each node also needs its own CPU and memory headroom ([System Requirements](#system-requirements)); a compose override can cap one (`mem_limit`, `cpus` under `services: node:`).

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

State is stored in named Docker volumes, not bind mounts. They survive `docker compose down` but **not** `docker compose down -v`. The names below are those of a single install; with `INSTANCE_SUFFIX` set ([More than one install on a host](#more-than-one-install-on-a-host)) each one ends in that suffix, for example `demos_node_state_b`.

| Volume | Holds |
|--------|-------|
| `demos_pgdata` | PostgreSQL data directory (chain state, indexes) |
| `demos_node_state` | Your `.demos_identity` (private key), `demos_peerlist.json`, `.tlsnotary-key`, `output/` |
| `demos_node_data` | Bundled bootstrap data (genesis.json, evmChains, l2ps) plus chain runtime artifacts |
| `demos_node_logs` | Node logs |
| `demos_prometheus_data` | Prometheus TSDB |
| `demos_grafana_data` | Grafana dashboards, users, settings |
| `demos_neo4j_data` / `demos_neo4j_logs` | Neo4j (only if `neo4j` profile is on) |

The names are set explicitly in `docker-compose.yml` (`demos_<volume>` plus `INSTANCE_SUFFIX`), so they do not depend on the directory or the compose project name: two installs on one host share their volumes unless their suffixes differ. Inspect this install's state volume, with `STATE_VOLUME` set as in step 3 of [Run a released image](#run-a-released-image-validators):

```bash
docker volume inspect "$STATE_VOLUME"
```

### Backup the node identity

Your `.demos_identity` is the private key — losing it means losing your node's network identity. The same volume holds the signing state files (`.demos_identity.signed.json`, `.commitlock.json`, `.prevote.json` and others listed in [docs/runbooks/validator-key.md](docs/runbooks/validator-key.md), "Signing state files"), which must be backed up and restored together with the key, as one copy taken while the node is stopped. Back up this install's whole state volume (`$STATE_VOLUME`, with `HELPER_IMAGE` from the same step 3), encrypted, and keep the backup off this host:

```bash
out="node-state$SUFFIX-$(date +%F-%H%M%S).tar.gz.gpg"
if docker compose stop node; then
  ( set -o pipefail
    docker run --rm --entrypoint tar -v "$STATE_VOLUME":/src:ro "$HELPER_IMAGE" czf - -C /src . \
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

The port is your `RPC_PORT`. Chain data comes from `nodeCall` requests, a JSON `POST` to `/`. The current height (`response` is the block number):

```bash
RPC=http://localhost:53550
curl -s "$RPC/" -H 'Content-Type: application/json' \
  -d '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{}}]}'
# {"result":200,"response":1234,...}
```

The keys that signed a block are the keys of its `validation_data.signatures`. This lists them for the last block and says whether yours, the `pubkey=0x...` of step 5, is among them:

```bash
RPC=http://localhost:53550
MY_KEY=0x<your validator public key>
n=$(curl -s "$RPC/" -H 'Content-Type: application/json' \
  -d '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{}}]}' |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["response"])')
curl -s "$RPC/" -H 'Content-Type: application/json' \
  -d "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getBlockByNumber\",\"data\":{\"blockNumber\":$n}}]}" |
  MY_KEY="$MY_KEY" python3 -c '
import json, os, sys
block = json.load(sys.stdin)["response"]
signers = sorted((block.get("validation_data") or {}).get("signatures") or {})
mine = os.environ["MY_KEY"].lower().removeprefix("0x")
print("block", block["number"], "signed by", len(signers))
print("\n".join(signers))
print("your key signed it" if any(k.lower().removeprefix("0x") == mine for k in signers) else "your key did not sign it")'
```

Block 0 carries no signatures; run it on a later block. A key that is in the committee signs most blocks once the quorum is online. The committee of a block is drawn from the validators, so a single block without your key proves little; one that is missing from many blocks in a row is not signing (see [Troubleshooting](#troubleshooting)).

### Update the node

A validator moves to a released image by tag and digest, never by building its own; see [docs/runbooks/release.md](docs/runbooks/release.md). Verify and check out the new tag (step 1 of [Run a released image](#run-a-released-image-validators)), set `IMAGE_TAG` in `.env` from the release's `checksums.txt` and `SUFFIX` as in step 3 there, then:

```bash
./scripts/node-doctor --production &&
docker compose pull node &&
docker compose up -d --wait postgres &&
docker compose run --rm --no-deps --name "demos-migrate$SUFFIX" node bun run migration:show
```

`migration:show` is read-only; each `[ ]` line is a pending migration. If it lists one, back up the database first ([docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md), step 1). Then, only if the block above ended without an error:

```bash
./scripts/node-doctor --production &&
docker compose stop reaper node &&
docker compose run --rm --no-deps --name "demos-migrate$SUFFIX" node bun run migration:run &&
docker compose up -d --no-build
```

Then wait until the node is healthy and confirm the running digest and parameters, as in steps 8 to 10 there.

The node does not migrate the database at boot, so the migration step sits between `pull` and `up -d`: the new image is already local and the old node is not yet replaced. `stop reaper node` keeps Postgres up (stopping the node alone lets the reaper stop the whole stack). With nothing pending, `migration:run` only reports that and changes nothing. Each block is one `&&` chain: a failed doctor check, pull, Postgres start or migration stops it, so the node is never started on an old or half-migrated schema. Full procedure, including the backup: [docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md).

Volumes (and therefore your identity, chain data, peerlist cache) are preserved.

A development host that builds from source instead: `git pull && ./run --docker -d --build`. Each such update leaves the previous image's layers in the build cache; the [daemon baseline](#docker-daemon-baseline) caps that at 10 GB, otherwise run `docker builder prune -f --filter until=24h` after updating.

### Stop the node

```bash
docker compose down                  # stop containers, KEEP volumes
```

Run it from the install's checkout: compose acts only on the project of the directory it runs in (`COMPOSE_PROJECT_NAME`, the directory name by default).

### Wipe one install

`docker compose down -v` deletes this install's identity copy, chain data, Prometheus history and Grafana dashboards. Back up the state volume first ([Backup the node identity](#backup-the-node-identity)) unless you want a new identity. Run it from the install's checkout and look at what it will remove first:

```bash
project=$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
docker volume ls --filter "label=com.docker.compose.project=$project"
docker compose down -v
docker volume ls --filter "name=^demos_.*$SUFFIX\$"    # left over; without a suffix this lists every install's
```

`down -v` removes only the volumes labelled with this project, which every volume this guide seeds is, since the seeding steps run `docker compose create` first. A volume made outside compose (an older `docker run -v demos_node_state:...` seed) has no label: `down -v` prints `Volume ... was not created by Docker Compose` and keeps it. Remove such a volume by its exact name (`docker volume rm demos_node_state$SUFFIX`), and only once you have checked that no other install uses it. Never run `docker volume prune` or `down -v` from another install's checkout to clean up this one.

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
> Grafana persists the password in `demos_grafana_data` (plus `INSTANCE_SUFFIX`) after first boot. To change it, either edit it in the Grafana UI, or `docker compose down && docker volume rm "demos_grafana_data$SUFFIX" && docker compose up -d` (resets dashboards too).

**`invalid container name or ID: value is empty` from a `docker inspect`**
> The node container does not exist or exited before the command ran, so `docker compose ps -q node` printed nothing. `docker compose ps -a node` shows its state and `docker compose logs --tail 50 node` the reason it stopped.

**ERROR lines while the network starts**
> A validator forges only while the quorum of the genesis `shardSize` (2/3 + 1) of the validators is online. Until then, and while peers restart, these lines repeat every few seconds and are expected:
>
> - `Committee of N is below the floor of Q: refusing to forge`
> - `[getShard] N of the M bound committee members for block X are live, below the quorum ...`
> - `[manageProposeBlockHash] Candidate block not formed: refusing the block hash`
> - `Max retries reached for method: hello_peer` (a peer in the list is not up yet)
>
> They stop once enough validators are online and the height grows ([Connect to the RPC](#connect-to-the-rpc)). When the quorum equals the number of validators (3 of 3, for example), every validator must be up: start them together, and one stopped validator halts the chain until it is back. Lines that continue after every validator is up and reachable at its `EXPOSED_URL` are not expected: check the peer list and the firewall.
>
> Seen at every start and harmless: `[Rate Limiter] Failed to load blocked IPs ... ENOENT` (no block list saved yet), `No wild peers found, starting sync loop`, and `No wait entry found for setWaitStatus`.

**TLSNotary port warning with OmniProtocol on**
> With both OmniProtocol and TLSNotary enabled the node warns at every start that a peer on HTTP port `TLSNOTARY_PORT - 1` would have OmniProtocol connect to the TLSNotary port. It is printed whatever the ports are; it matters only in `OMNI_ONLY` mode when a peer's `RPC_PORT` is your `TLSNOTARY_PORT - 1`, which the defaults (53550 and 7047) avoid. See [Network Exposure](#network-exposure).

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
# Signers come from the protected branch, not from the tag itself. The list
# is kept inside this clone's .git, so another install cannot overwrite it.
SIGNERS="$(git rev-parse --absolute-git-dir)/demos-allowed-signers"
git show origin/stabilisation:.github/allowed_signers > "$SIGNERS"
git config gpg.ssh.allowedSignersFile "$SIGNERS"
# The tag must be on stabilisation and signed by a listed key;
# the checkout runs only when both checks pass
git merge-base --is-ancestor "$TAG" origin/stabilisation && echo "on stabilisation" &&
git verify-tag "$TAG" &&
git checkout "$TAG"
```

`git verify-tag` must print `Good "git" signature for <signer> with ED25519 key SHA256:<fingerprint>`, and the signer and fingerprint must be one of the release signers published outside GitHub (see [docs/runbooks/release-signing-key.md](docs/runbooks/release-signing-key.md), "Publish the fingerprint"), as in step 1 of [Run a released image](#run-a-released-image-validators). If the block stops before the checkout, or `on stabilisation` is not printed, stop and ask on the release thread. The checkout leaves a detached `HEAD`, which is expected. To upgrade, repeat these steps with the next tag; do not use `./run -U`, which pulls a branch head.

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

The node no longer migrates the database at boot, and a plain `./run` does not create the schema on an empty database. `-c true` deletes the launcher's Postgres data (`postgres_<PG_PORT>/data_<PG_PORT>`) and then creates the schema on the empty database; nothing else is touched, and on a brand-new host there is no data to lose. The launcher's `postgres_<PG_PORT>` folder does not exist until the first `./run`, so there is no Postgres to start by hand yet. Run later starts as plain `./run`: never repeat `-c true` on a host with data. On later runs, when the folder exists, you can instead migrate by hand: the launcher stops its Postgres together with the node, so start it alone from its folder, wait until it is ready, then go back to the node checkout and run the migration there (the command reads the checkout's `.env` and `src/migrations/`):

```bash
(cd postgres_<PG_PORT> && PG_PORT=<PG_PORT> docker compose up -d)
until docker exec postgres_<PG_PORT> pg_isready -q -h 127.0.0.1 -U demosuser -d demos; do sleep 1; done
# the launcher passes its port only to the node it starts; .env may name another
PG_HOST=localhost PG_PORT=<PG_PORT> bun run migration:run      # from the node checkout
```

See [docs/runbooks/database-migrations.md](docs/runbooks/database-migrations.md). For an upgrade: back up, then `bun run migration:show` / `bun run migration:run` before `./run`, per the same runbook.

Running the node the first time will generate a private key for your node and store it in the `.demos_identity` file by default. The public key is printed on the terminal and saved in a `publickey_*` file in the same directory.

A mainnet validator does not do this: its key is generated on a trusted machine and copied in as `.demos_identity` (mode 600) before the first start, as in step 5 of [Run a released image](#run-a-released-image-validators). With `PROD=true` in `.env` the node stops instead of creating a key, so a missing file is never silently replaced.

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

Mainnet validators run Track 1 with the released image. A bare-metal node keeps the published genesis file and snapshot outside the checkout and points `DEMOS_GENESIS_FILE` and `DEMOS_SNAPSHOT_DIR` in `.env` at them (absolute paths). Never copy them over `data/genesis.json` or `data/snapshot/`: those are tracked files, the node would then report its build as dirty, and the launch go/no-go check does not count a dirty build as the release. A named genesis file that is missing stops the node at boot. Run with the release tag checked out and nothing else changed (`git status` shows no modified tracked files). Also set the genesis pins from [Pin the network's genesis](#joining-the-network--required-steps-before-real-world-use) (`EXPECTED_GENESIS_HASH`, `EXPECTED_GENESIS_BLOCK_HASH`), append the parameter sheet (`cat docs/mainnet/parameters.env >> .env`, which sets `PROD=true`, `DEMOS_REQUIRE_VALIDATORS=true`, `FORK_SCHEDULE_MISMATCH_POLICY=abstain` and the chain-wide values) and run `./scripts/node-doctor --production --env-from env` before starting: without `--env-from env` the doctor reads the Docker settings whenever `docker-compose.yml` and Docker are present, not the `.env` and environment a bare-metal node uses. Keep every setting in `.env`: Bun also loads `.env.local` and `.env.<NODE_ENV>` files over it, so the doctor fails while any of them exists. `./run` does not set `NODE_ENV=production`, so a missing pin only shows as a warning at boot.

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
- **Settlement (mainnet, `l2psSettlement` fork active from block 0):** L2PS transfers move L1 balances only through `l2psBatch` settlement records. A member node plans the executed transfers into batches, proves each one in a separate prover process and submits it; every validator checks the proof and the signed transfers and applies the same balance changes, so no node applies L2PS edits on its own. A batch holds at most 9 transfers and 18 balance changes, and a block at most 20 batches; a batch that fails its checks is included as failed without changes, and its transfers are planned again. Members only accept transfers that carry their settlement data (current SDK clients send it), and a transfer whose fee is below the native transfer fee is dropped with a message to sign it again. A sender may queue at most 18 transfers past its L1 nonce on one member, within its balance, in envelopes of at most 174,506 bytes; a transfer no batch can place fails about 35 minutes (300 blocks) after admission (`docs/design/l2ps-zk-settlement.md`, "Admission and the queue"). `L2PS_ZK_ENABLED` and the old batch proof keys are obsolete under the fork: the node ignores the flag and says so at start. Validators that are not members set nothing: they verify against the settlement verification key committed in the release. A member node keeps the subnet files from this setup and also needs the settlement proving key and circuit, which the release image builds in (`docs/design/l2ps-zk-settlement.md`, Plan step 1); with the fork scheduled, a node without the verification key, or a member without the proving files or a prover that starts, refuses to boot. Each proof takes one core, about 1 GB and about 40 s for a batch of up to 9 transfers; `L2PS_SETTLEMENT_PROVERS` (1 to 16, default 1) sets how many a member proves at once, so give a member that many spare cores and GB of memory on top of the node.
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
| 3005        | Signaling    | WebRTC signaling for messaging clients (TCP); consensus does not use it |
| 55000-55063 | WS Proxy     | Per-session TLSNotary proxies (TCP), on loopback for a reverse proxy on this host; bare metal uses 55000-57000. Not opened in the firewall ([Network Exposure](#network-exposure)) |
| 123 (out)   | NTP          | Outbound UDP; host time sync and the node's clock offset check |

### Optional Ports

| Port | Service    | Description                          |
| ---- | ---------- | ------------------------------------ |
| 9090 | Metrics    | Node Prometheus metrics endpoint     |
| 9091 | Prometheus | Prometheus server (monitoring stack) |
| 3000 | Grafana    | Dashboard UI (monitoring stack)      |
| 5332 | PostgreSQL | Database of a bare-metal install (local only, do not expose); under Docker Postgres is not published |
| 3006 | L2PS messaging | WebSocket, loopback by default, only with `L2PS_MESSAGING_ENABLED=true` |

- Configuration: `.env` and `demos_peerlist.json`

## Next Steps

Once your node is running:

1. Note your public key from the console output (or from the `publickey_*` file).
2. Share your connection string with other node operators to form a network.
3. Monitor the logs (`docker compose logs -f node` for Track 1, terminal output or `logs/` for Track 2) for successful peer connections.
4. Check the Demos Network documentation for updates.
