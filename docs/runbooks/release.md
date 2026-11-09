# Cutting a release

Every validator runs the same artifact: an image built from a signed tag,
built twice from clean checkouts, published only when both builds produce
the same manifest digest. This page is the operator side of that rule.

## What is pinned

| What | Where | Why |
| --- | --- | --- |
| Bun version | `.bun-version` (also read by CI's `setup-bun`), mirrored in `package.json` `packageManager` | the runtime and the lockfile reader are one exact version everywhere |
| Base images | `Dockerfile`, `testing/devnet/Dockerfile`: tag plus `@sha256` digest | a tag such as `1.3-debian` moves; a digest does not |
| Postgres | `docker-compose.yml` (and the devnet and multinode compose files): `postgres:16-alpine` plus `@sha256` index digest | every Docker-track validator runs the same database server build |
| Node.js (gossip sidecar runtime) | `Dockerfile` `NODE_VERSION` + `NODE_SHA256` | one release, checked against its published checksum |
| Dependencies | `bun.lock`, installed with `--frozen-lockfile` on every path (`Dockerfile`, `scripts/run`, `scripts/install-deps.sh`, `scripts/reset-node`, CI) | the install fails instead of silently rewriting the lockfile |
| Lifecycle scripts | only the packages in `package.json` `trustedDependencies` (bufferutil, sqlite3, utf-8-validate); no `bun pm trust --all` anywhere | a new dependency's install script cannot run on a validator |
| Launcher | `./run` starts the checked-out commit; `./run -U` is the only way it pulls | a validator never picks up origin's head by accident |
| Launcher, Bun | `./run` refuses a Bun other than `.bun-version` | same reader of the lockfile on every host |
| Launcher, dependencies | `./run` installs from the lockfile on every start | a checkout moved to a new tag never runs on the previous tag's modules |

When you bump Bun, change `.bun-version`, `packageManager` in `package.json`
and both Dockerfiles together.
To find the digest of a new base image:

```bash
docker buildx imagetools inspect oven/bun:1.4.4-debian | grep Digest
```

The repo policy is enforced by `tests/release/reproducibleRelease.test.ts`
(`bun run test:release`, which uses the jest pinned in the lockfile and needs
`jq` installed, as the release workflow does).

## Signing keys

`.github/allowed_signers` lists who may sign a release tag, one line per
key in the OpenSSH allowed-signers format:

```
release@kynesyslabs.com namespaces="git" ssh-ed25519 AAAA...
```

A signer configures git once:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/<key>.pub
```

Keep the private key off the validators and out of CI. How a holder
generates the key offline and gets it listed, and why a final release needs
three holders: [release-signing-key.md](release-signing-key.md).

The release workflow does not trust the tag to name its own signers. It
reads `.github/allowed_signers` from the head of `stabilisation`, and it
refuses a tag whose commit is not on `stabilisation`. Both rules depend on
branch protection for `stabilisation` (required review, no force pushes):
whoever can merge there decides who may sign a release. Add or remove a
signer by merging a change to that file; a change made only on the tagged
commit has no effect.

## Cutting a release candidate

First merge a change that sets `version` in `package.json` to the tag
without its `v` (for example `1.0.0-rc.1`). The node reports that version in
`/version`, `/info`, `/health`, the Omni version call and `getNetworkInfo`, and
the workflow refuses a tag that does not match it, so every release names
itself.

```bash
git checkout stabilisation && git pull --ff-only
git tag -s v1.0.0-rc.1 -m "v1.0.0-rc.1"
git verify-tag v1.0.0-rc.1
git push origin v1.0.0-rc.1
```

The `Release` workflow then:

1. checks the tagged commit is on `stabilisation`, verifies the tag
   signature against the `.github/allowed_signers` of that branch's head,
   and checks that the tag is `v` plus `package.json`'s version;
2. builds the image twice, in two independent jobs, from clean checkouts,
   with no cache, `SOURCE_DATE_EPOCH` and `BUILT_AT` taken from the commit,
   and file timestamps rewritten to the commit date;
3. fails if the two manifest digests differ;
4. pushes the verified image to `ghcr.io/kynesyslabs/node:<tag>`, checks
   that the pushed digest is the verified one, and drafts a GitHub release
   with `checksums.txt` (tag, commit, image digest, source archive sha256)
   and the source archive attached.

Publish the draft after the validators have confirmed the digest they run.

## What a validator runs

In the node's `.env` (see `INSTALL.md`, Docker track), pin the image by tag
and digest, copied from `checksums.txt`. If the release changes
`docs/mainnet/parameters.env`, the announcement says so and every validator
updates the same lines in `.env` before restarting; `node-doctor --production`
fails until they match.

```
IMAGE_NAME=ghcr.io/kynesyslabs/node
IMAGE_TAG=v1.0.0-rc.1@sha256:<digest from checksums.txt>
```

```bash
./scripts/node-doctor --production &&
docker compose pull node &&
docker compose up -d --wait postgres &&
docker compose run --rm --no-deps --name demos-migrate node bun run migration:show
```

`migration:show` is read-only; each `[ ]` line is a pending migration. If it
lists one, back up the database first ([database-migrations.md](database-migrations.md),
step 1). On a first install there is nothing to back up. Then, only if the
block above ended without an error:

```bash
./scripts/node-doctor --production &&
docker compose stop reaper node &&
docker compose run --rm --no-deps --name demos-migrate node bun run migration:run &&
docker compose up -d --no-build &&
docker image inspect --format '{{index .RepoDigests 0}}' \
  "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q node)")"
```

Each block is one `&&` chain, so a host that fails a node-doctor check never
pulls or starts, and a failed pull, Postgres start or `migration:run` stops
the chain before `up`: the new release never starts on the old schema.
`--no-build` keeps compose from building a local image when the
pull fails, which would run code nobody signed. The last line prints the
digest the container runs; it must match
`checksums.txt`. Post it on the release thread.

The node does not migrate the database at boot, so the migration step sits
between `pull` and `up -d`: the new image is already local and the old node
is not yet replaced. `stop reaper node` keeps Postgres up (stopping the node
alone lets the reaper stop the whole stack). With nothing pending,
`migration:run` only reports that and changes nothing, so the second block is
the same for every release. A node started with migrations still pending
refuses to boot and names the command.
Procedure, including the backup: [database-migrations.md](database-migrations.md).

A bare-metal validator (`./run`) checks out the tag instead and verifies it
locally before starting:

```bash
git fetch --tags origin stabilisation &&
git show origin/stabilisation:.github/allowed_signers > ~/demos-allowed-signers &&
git config gpg.ssh.allowedSignersFile ~/demos-allowed-signers &&
git merge-base --is-ancestor v1.0.0-rc.1 origin/stabilisation &&
git verify-tag v1.0.0-rc.1 &&
git checkout v1.0.0-rc.1 &&
./run
```

The chain stops at the first failing check, so `./run` never starts an
unverified tree. The chain upgrades a host whose database already has its
schema: a new host starts with the first-install steps in `INSTALL.md`
(`./run -c true`), since a plain `./run` refuses to boot on an empty database.
The full walk-through is in `INSTALL.md`. Here `./run` stands for the host's
own launcher command with all its options (`-d <PG_PORT>`, `-p`, `-i`, ...):
a plain `./run` falls back to the defaults, Postgres on 5332 among them. If
the release adds a migration, leave `./run` off the chain and migrate first.
Install the release's dependencies first: `./run` would install them, but
only when it starts, after the migration. The launcher stops its Postgres
together with the node, so start it alone from its folder, wait until it is
ready, back up, then go back to the node checkout and migrate there
([database-migrations.md](database-migrations.md), bare-metal track):

```bash
bun install --frozen-lockfile   # from the node checkout, right after the checkout
(cd postgres_<PG_PORT> && PG_PORT=<PG_PORT> docker compose up -d)
until docker exec postgres_<PG_PORT> pg_isready -q -h 127.0.0.1 -U demosuser -d demos; do sleep 1; done
# the launcher passes its port only to the node it starts; .env may name another
PG_HOST=localhost PG_PORT=<PG_PORT> bun run migration:show   # from the node checkout; [ ] = pending
# back up (database-migrations.md step 1), then restart with the host's usual
# launcher options; -d must name the port just migrated:
PG_HOST=localhost PG_PORT=<PG_PORT> bun run migration:run && ./run -d <PG_PORT> <other launcher options>
```

## Upgrade notes

- From the first release after `v1.0.0-rc.5`: a node started with `--proxy`
  (`docker-compose.proxy.yml`) refuses to boot while `METRICS_BASIC_AUTH_HASH`
  is empty or still the shipped placeholder. Before upgrading, set the hash, or set
  `PROXY_ALLOW_PLACEHOLDER_AUTH=true` to boot without one (see `.env.example`).
- From the first release after `v1.0.0-rc.5`, peer-to-peer auth changes on the
  wire and every node of a network must be upgraded together (mainnet starts
  on this release). Omni requests are signed with mode `0x06`, which covers the
  network's genesis hash, the identity of the node the request is sent to, the
  opcode, the sequence, the timestamp and the payload hash, so a node cannot
  pass a request it received on to another node as its sender. Each signed
  message is accepted once per process: the
  record of accepted messages is kept in memory and is lost on a restart, so a
  frame captured before a node restarts can be accepted once more while its
  timestamp is still inside the 5-minute clock-skew window. A frame signed on
  another network fails verification. A new node refuses the old modes `0x03`/`0x04`; an
  old node refuses `0x06` (`does not bind the payload`) and closes the
  connection, and the sender falls back to HTTP.
- In the same release, HTTP peer requests sign the body too: the signature
  covers the genesis hash, identity, timestamp and the SHA-256 of the body,
  sent in a `body-hash` header, so a request from another network is
  refused. `hello_peer`, `mempool` and `consensus_routine` are
  refused without it (HTTP 401). An old node answers a new node's signed
  request with `401 Invalid signature`; a new node refuses an old node's
  peer methods and still accepts the old form for client methods, which is
  what the SDK sends. Together with the Omni change, old and new nodes do
  not peer with each other.
- From the first release after `v1.0.0-rc.5`, `/health` is a readiness probe:
  503 while the node is booting, dormant or not synced. Probes that must stay
  green while a node catches up (container healthchecks, liveness probes)
  move to `/health/live`, which keeps the old meaning (503 only when
  failing). The shipped Dockerfile and `docker-compose.yml` already use it.
- From `v1.0.0-rc.6`:
  - The node uses the host clock and no longer corrects it from NTP servers.
    Keep host NTP running (chrony or systemd-timesyncd). With `PROD=true` a
    node refuses to boot when at least two NTP servers agree that the host
    clock is further off than `BLOCK_TIMESTAMP_TOLERANCE`.
  - A balance edit larger than the balance fails on every node. Before, a node
    with `PROD=false` clamped the balance to 0 instead.
  - Mainnet validators append `docs/mainnet/parameters.env` to `.env`, and
    `node-doctor --production` fails on any value that differs from it.
    `DEMOS_DISABLE_FORK_MACHINERY` is refused on any chain id other than
    1 and 1337.
  - Governance transactions are refused until the chain reaches the
    `activationHeight` the genesis gives the `networkGovernance` fork (0 turns
    it on from the first block). The bundled testnet genesis
    (`data/genesis.json`) does not schedule it, so governance transactions
    fail on testnet from this release. A network that used governance before
    keeps it only by scheduling the fork. On a live chain that follows
    [Changing the schedule](fork-schedule-policy.md#changing-the-schedule): a
    height more than 50 blocks ahead, with every validator on the new genesis
    before the window opens.

## Known limits

- Debian packages installed with `apt-get` (curl, ca-certificates, xz)
  and the `wstcp` crate's dependencies are resolved at build time. The two CI builds run minutes
  apart and resolve the same versions; a rebuild weeks later may not.
  Pinning them to a snapshot is the next step if a later rebuild has to
  match byte for byte.
- The reproducibility check covers `linux/amd64`, the platform validators
  run.
