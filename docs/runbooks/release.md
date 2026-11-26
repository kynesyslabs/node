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

A signer configures git in the checkout used to tag. The first two lines are
needed once; run the last four again before each tag, because the signer
file is a copy of the list at that moment and goes stale when a signer is
added or removed. The copy goes into the clone's own `.git`, as in
`INSTALL.md` step 1:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/<key>.pub
git fetch --tags origin stabilisation &&
SIGNERS="$(git rev-parse --absolute-git-dir)/demos-allowed-signers" &&
git show origin/stabilisation:.github/allowed_signers > "$SIGNERS" &&
git config gpg.ssh.allowedSignersFile "$SIGNERS"
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

## Announcing a release

The draft release is visible only to repository members, so a validator
installs from the announcement alone. Before posting it, run the checks a
validator will run, on the files you are about to send, and post nothing
that fails them:

- `docker compose run --rm --no-deps node bun scripts/genesis-hash.ts --genesis
  /app/data/genesis.json --snapshot /app/mainnet-snapshot` with the release
  image and the files mounted as in INSTALL.md ("Run a released image", steps
  3 and 4) exits 0 and prints no `problem:` line. It reports a `shardSize`
  outside 3-100, fewer validators active at block 0 (status `"2"`, `valid_at`
  0) than the quorum of `shardSize` (2/3 + 1),
  and a validator `connection_url` that is not an http(s) URL with a host
  (and, if it names a port, one in 1-65535).
- every validator `connection_url` in the genesis is exactly the
  `EXPOSED_URL` that operator sent, port included.

The announcement then carries:

1. the tag, and the full `checksums.txt` (tag, commit, image digest, source
   sha256) pasted or attached, since the draft cannot be downloaded;
2. each signer's email and `SHA256:` fingerprint
   ([release-signing-key.md](release-signing-key.md), "Publish the
   fingerprint");
3. for a new network or a reissued genesis: `genesis.json`, `snapshot.tar`
   and a `SHA256SUMS` covering both, and the four values a validator compares
   (genesis hash, genesis block hash, fork schedule digest with chain id,
   snapshot manifest sha256), attached to that release when it is published
   ([../mainnet/genesis-hash.md](../mainnet/genesis-hash.md), "Publication").
   Any other release links that published release and repeats the four
   values, so a validator installing for the first time from a later release
   finds the network's files and checks them the same way;
4. the peer list: one `public key -> EXPOSED_URL` line per validator, the
   same URLs as the genesis;
5. whether `docs/mainnet/parameters.env` changed and whether the release adds
   a migration.

A reissued genesis is a new chain: say so, and point the validators at
INSTALL.md, "After the genesis is reissued".

## What a validator runs

Before changing `IMAGE_TAG`, verify and check out the release tag, so the
compose file, scripts and parameter sheet match the image. The signer list
goes into the clone's own `.git`, as in `INSTALL.md` step 1:

```bash
TAG=v1.0.0-rc.1

OLD_HEAD="$(git rev-parse HEAD)" &&
git fetch --tags origin stabilisation &&
SIGNERS="$(git rev-parse --absolute-git-dir)/demos-allowed-signers" &&
git show origin/stabilisation:.github/allowed_signers > "$SIGNERS" &&
git config gpg.ssh.allowedSignersFile "$SIGNERS" &&
git merge-base --is-ancestor "$TAG" origin/stabilisation &&
git verify-tag "$TAG" &&
git checkout "$TAG"
```

The first line records the commit the checkout is at now. If this chain
stops, do not continue the upgrade. A good signature from a key you cannot
match is a failure: the email `git verify-tag` prints must be a signer the
announcement names, and the `SHA256:` fingerprint the one that signer
published outside GitHub (see `INSTALL.md` step 1). The chain has already
checked out the new tag by then, so before anything else go back to the
commit the first line recorded, in the same shell: `git checkout "$OLD_HEAD"`.
Then do not continue the upgrade.

Run the chain once; to read the signature again, run `git verify-tag "$TAG"`,
which moves nothing. If the shell is gone or the chain ran twice, `OLD_HEAD`
is empty or holds the new tag's commit. Go back instead to the release named
by `IMAGE_TAG` in `.env`, the part before `@` (`git checkout vX.Y.Z` for
`IMAGE_TAG=vX.Y.Z@sha256:<digest>`): it still names the release the node
runs, because this chain runs before `IMAGE_TAG` changes. If `IMAGE_TAG` is
still `local` (an image built from this checkout), find the way back in
`git reflog`: the oldest `checkout: moving from <place> to <tag>` line of
this upgrade names the commit or branch to check out.

In the node's `.env` (see `INSTALL.md`, Docker track), pin the image by tag
and digest, copied from `checksums.txt`. If the release changes
`docs/mainnet/parameters.env`, the announcement says so and every validator
updates the same lines in `.env` before restarting; `node-doctor --production`
fails until they match. `SUFFIX` is the install's `INSTANCE_SUFFIX`, empty
on a host with one install (INSTALL.md, "Run a released image", step 3).

```
IMAGE_NAME=ghcr.io/kynesyslabs/node
IMAGE_TAG=v1.0.0-rc.1@sha256:<digest from checksums.txt>
```

```bash
./scripts/node-doctor --production &&
docker compose pull node &&
docker compose up -d --wait postgres &&
docker compose run --rm --no-deps --name "demos-migrate$SUFFIX" node bun run migration:show
```

`migration:show` is read-only; each `[ ]` line is a pending migration. If it
lists one, back up the database first ([database-migrations.md](database-migrations.md),
step 1). On a first install there is nothing to back up. Then, only if the
block above ended without an error:

```bash
./scripts/node-doctor --production &&
docker compose stop reaper node &&
docker compose run --rm --no-deps --name "demos-migrate$SUFFIX" node bun run migration:run &&
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

A bare-metal validator (`./run`) runs the same verify-and-checkout chain, then
starts `./run`:

```bash
git fetch --tags origin stabilisation &&
SIGNERS="$(git rev-parse --absolute-git-dir)/demos-allowed-signers" &&
git show origin/stabilisation:.github/allowed_signers > "$SIGNERS" &&
git config gpg.ssh.allowedSignersFile "$SIGNERS" &&
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

## Rolling upgrades

On a running network, validators upgrade one at a time, whatever the number
of validators:

1. Upgrade one validator with the blocks above.
2. Wait until it is back in the committee: healthy, at the network head, and
   signing blocks. The check is in
   [chain-halt-recovery.md](chain-halt-recovery.md), "Restart and upgrade
   rule". Post its running digest on the release thread.
3. Only then start the next one.

Each stop costs the committees it sits in one vote, and a restarted node sits
out rounds until its restart signing floor passes, so two validators down at
once can stop a committee that holds both. If a just-restarted validator
logs `Timeout waiting for green light` for the same block twice, restart it
once more (`docker compose restart node`). From `v1.0.0-rc.13` the validator
leaves a round the secretary abandoned and joins the newer one on its own, so
this restart is a fallback there.

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
    node refuses to boot when its clock is more than 5 s ahead or behind the
    median of the largest group of NTP servers that agree within 2 s of each
    other (at least two, and only if no other group is as large).
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
- From `v1.0.0-rc.7`:
  - Identity proofs verify with the final key of the identity ceremony
    (kynesyslabs/zk_ceremony, drand round 6629366 beacon). Proofs made with an
    earlier development key are refused; clients need `@kynesyslabs/demosdk`
    4.0.20 or later. Block apply and sync verify each attestation again with
    the key in the image, so a chain that already holds attestations made
    under an earlier key cannot be replayed or synced by rc.7. No supported
    procedure covers such a chain; the release supports chains without them
    (mainnet from genesis, the rc.6 test network). rc.6 validators still
    confirm proofs made with the development key, so no client may submit an
    identity attestation from the start of the upgrade until the final checks
    pass. Before upgrading each validator, wait until it is at the network's
    current tip (a node that is behind has not seen later blocks), then run
    the check for its install; after the last validator, run it once more on
    every validator, and resume attestations only when all of these return 0.
    The result must be 0:
    - Docker stack (`./run --docker`): query the instance's own database
      container, which uses the database's own user and name, so custom
      `PG_USER` and `PG_DATABASE` work. The container is `demos-postgres`
      followed by the instance's `INSTANCE_SUFFIX` (empty by default,
      `_<port>` for `--port <port>`), or `demos-postgres-devnet` for
      `--devnet`; `docker ps` lists it:
      `docker exec <container> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT count(*) FROM used_nullifiers"'`
    - `./run` install: `docker exec postgres_<PG_PORT> psql -U demosuser -d demos -At -c "SELECT count(*) FROM used_nullifiers"`
    - External database: the same query with the node's `PG_*` connection
      settings.
  - L2PS batch proofs are off unless `L2PS_ZK_ENABLED=true`. Before, the
    aggregator proved whenever the keys were present. The image now ships the
    batch_5 and batch_10 proving keys. Validators do not check batch proofs
    yet, so turning them on changes no consensus result.
  - The ZK merkle-proof and nullifier routes accept canonical decimal as well
    as hex.
- From `v1.0.0-rc.8`:
  - Two new forks, both at height 0 in the mainnet set (27 forks at 0):
    `l2psGate` refuses every L2PS transaction and node call and starts no
    L2PS service, and `tlsnDisabled` refuses `tlsn_request` and `tlsn_store`
    before any fee or token. A network that does not schedule them keeps L2PS
    and TLSNotary as before.
  - `xmProofBinding` moves into the mainnet set at height 0: a cross-chain
    identity proof must sign the `demos-xm:v1` message, so wallets and
    clients that link xm identities need `@kynesyslabs/demosdk` 4.0.21. An
    older SDK's proof (the sender's address) is refused from block 0.
  - `launch-go-no-go` needs `--expected-treasury` (or
    `DEMOS_EXPECTED_TREASURY`) on a mainnet chain id and is NO-GO when the
    genesis names another treasury. A peer whose `gasFeeSeparation` treasury
    differs is handled as a fork-schedule mismatch at any height.
  - The mainnet template carries chain id `8587492`. `launch-go-no-go` and
    `--plan` refuse chain ids `0`, `1`, `1337` and `31337`.
  - A node on a mainnet chain id refuses to boot with
    `DEMOS_ALLOW_UNPINNED_GENESIS` set, pinned or not.
  - `node-doctor --production` fails when `GITHUB_TOKEN`,
    `DISCORD_BOT_TOKEN`, `RAPID_API_KEY` or `RAPID_API_HOST` is empty: web2
    identity links stay on and the node checks them against the providers.
  - The Omni per-identity cap counts inbound connections only. Run one
    process per validator key.
- From `v1.0.0-rc.9`:
  - Two new forks, both at height 0 in the mainnet set (29 forks at 0). A
    network that does not schedule them keeps the rc.8 behaviour:
    - `storageFeeSettlement`: the storage fee of a Storage Program create,
      write or granular write is credited to the burn address and the
      treasury per the network fee split, as gas already is. Before, the
      fee left the total supply. The signed edits and admission do not
      change; only the applied copy carries the credits.
    - `referenceBlockRoom10`: a transaction may reference a block up to 10
      blocks behind the head (1 before the fork), so a transaction
      confirmed at head N stays valid for inclusion until block N+11. The
      room is read at the tip each block is forged on, so sync of older
      blocks applies the rule they were made under. The deep window that
      keeps an expired transaction for inclusion as failed is 50 blocks.
  - A validator abstaining on its own fork schedule is left out of the
    shard after the first round it misses or refuses, so it no longer
    slows every round or halts the chain once drawn as secretary.
  - A web2 proxy request ends at its 30 s deadline even while the origin
    keeps sending bytes. The GitHub and RapidAPI (Twitter) lookups behind
    web2 identity verification have the same 30 s deadline and the
    `web2MaxResponseBytes` size cap.
  - `docker-compose.yml` passes `SUDO_PUBKEY` to the container; set it in
    `.env` to answer the admin RPC. INSTALL gives the minimum per validator:
    2 dedicated vCPU and 3 GB RAM. Keep host NTP synced: the rehearsal
    clock skew of 4.5 s left 0.5 s before the 5 s refusal.
  - A client whose transaction a launch gate (`l2psGate`, `tlsnDisabled`)
    refuses at RPC validation gets the gate reason instead of
    `GCREdit mismatch`.
  - `node-doctor` (and `--production`) fails when the identity file is
    readable by group or other users (`600` or stricter passes).
- From `v1.0.0-rc.10`:
  - A validator abstains when at least half of the staked set answers with a
    different fork schedule (before: more than half). On an even split both
    halves stop voting and the chain halts until an operator fixes a
    schedule. Before, a quorum mixing both halves kept running while the
    halves applied blocks differently (`storageFeeSettlement` changes only
    the applied copy). A node that applied blocks under a wrong schedule must
    be resynced from a correct peer.
  - The web2 relay closes its outbound origin connection at the request
    deadline and when its caller leaves early, not only the caller's side.
  - `launch-go-no-go --plan` refuses a mainnet genesis that schedules
    `atomicWork`.
- From `v1.0.0-rc.11`:
  - The web2 (DAHR) proxy caps its outbound fetches. Per caller: 2 running
    at once, 10 started per minute, 100 MiB of origin response per hour
    (charged with the bytes read, a refused or cut response included). Per
    node: 32 running at once. A caller is the client address of a
    `web2ProxyRequest` (one IPv6 /64 is one address) and the sender of a
    `web2Request` or DemosWork tx. Over a cap the caller gets result `429`
    `WEB2_FETCH_LIMITED` with a reason and `retryAfterSeconds`. Loopback and
    `WHITELISTED_IPS` skip the per-caller caps. Set with
    `WEB2_MAX_INFLIGHT_PER_CALLER`, `WEB2_MAX_FETCHES_PER_MINUTE_PER_CALLER`,
    `WEB2_MAX_BYTES_PER_HOUR_PER_CALLER` and `WEB2_MAX_INFLIGHT_TOTAL`
    (positive integers, or the node does not start); local to the node,
    no effect on blocks or state. Behind a reverse proxy, `TRUSTED_PROXIES`
    must name it: otherwise every client counts as the proxy, which shares
    one cap, or, for a proxy on the same host, is loopback and skips the
    per-caller caps (only the node-wide cap applies).
  - Rolling restart finding (U-1): a validator restarted while its
    committee was in a round could stay out of every later round at that
    height. On the 3-validator rehearsal this halted the chain for about
    10 minutes until a second restart of that validator. Apply the restart
    rule in [Rolling upgrades](#rolling-upgrades).
- From `v1.0.0-rc.13`:
  - A chain started from an rc.12-or-earlier genesis on a mainnet chain id
    refuses to boot on rc.13: `[GENESIS] Refusing to boot: the genesis does
    not declare l2psSettlement, tlsnVerified`. rc.13 knows these two forks,
    and on a mainnet chain id every fork the build knows must be declared in
    the genesis file. The node stops before it writes anything. This does
    not need a new chain: before the upgrade, the genesis owner publishes
    the network's genesis file with
    `"l2psSettlement": { "activationHeight": null }` and
    `"tlsnVerified": { "activationHeight": null }` added to `forks` and
    nothing else changed, and every validator mounts that file as it
    upgrades. The restart check allows a file that differs from block 0
    only in the fork schedule (`docs/design/genesis-enforcement.md`,
    "Restart"), so `EXPECTED_GENESIS_HASH` and `EXPECTED_GENESIS_BLOCK_HASH`
    stay the same, and `null` entries leave the fork schedule digest as it
    was. Scheduling either fork at a height later is a schedule change (a
    height above the tip + 50, and `tlsnVerified` with its full payload).
    A reissued genesis (new hashes, see INSTALL.md "After the genesis is
    reissued") starts a new chain and is needed only to start over. The
    rc.13 `genesis-hash.ts` and `node-doctor --production` do not report
    this refusal; from rc.14 both do (below).
  - A validator restarted in the middle of a round rejoins the committee
    within a round on its own. The secretary releases a late phase report
    it already released the group from, and a validator that sees the
    secretary open a newer round at the same height leaves its attempt
    without signing and joins that round. Before, it could wait out its
    green light while the round timed out, and only a second restart
    brought it back. No setting; no effect on blocks or state.
  - Genesis balances and validator stakes are read as decimal digits only.
    A genesis with an amount written as `""`, with spaces, a sign, a
    `0x`/`0b` prefix, or a JSON number above 2^53 is refused at boot
    instead of read. Every published genesis already uses decimal strings.
  - Launch tooling: `genesis-hash --snapshot` runs the carry-over import
    check a node runs at boot; `launch-go-no-go` refuses a test-genesis
    treasury on the mainnet chain id; the carry-over builder takes
    `--zero-points`, `--drop-storage` and `--empty-storage` lists.
  - A node on the mainnet chain id refuses to boot with
    `XFF_MODE=legacy`. Remove the setting or set `XFF_MODE=strict` with
    `TRUSTED_PROXIES` before upgrading.
  - Docker validators write logs to the `node_logs` volume instead of the
    container layer. Bare-metal `./run -e` keeps the operator's `PG_PORT`
    instead of forcing 5332.
  - While `editBinding` is active, a transaction the admission rules refuse
    at RPC validation gets `GCREdit mismatch: <reason>`. Before, it got the
    bare `GCREdit mismatch`. A reason the node does not list as public still
    gets the bare text, and the node log has it. Launch-gate refusals keep
    their own text, with no prefix.
  - An empty `RAPID_API_HOST` passes `node-doctor --production` and uses the
    Twitter API45 default.
  - Each RapidAPI (Twitter) provider read is capped at 4.5 s (was 30 s) and
    at most 4 MiB, or `WEB2_MAX_RESPONSE_BYTES` if that is smaller (was
    `WEB2_MAX_RESPONSE_BYTES` alone).
  - A missing `RAPID_API_KEY` is now refused before any request is sent.
    Before, the request went out without a key and RapidAPI refused it.
    Either way the Twitter check fails.
  - L2PS and TLSNotary are on at launch. The mainnet set schedules
    `l2psSettlement` and `tlsnVerified` at height 0 and leaves `l2psGate`
    and `tlsnDisabled` unscheduled (`null`): they are kill switches a running
    chain can schedule later. The set still has 29 forks at 0. `atomicWork`,
    `networkGovernance`, `tokenStaking`, `l2psGate` and `tlsnDisabled` stay
    `null`, and `launch-go-no-go` is NO-GO when any of them is scheduled.
  - `tlsnVerified` carries values every validator must agree on: the
    trusted notary keys (1 to 8 compressed secp256k1 keys), the sha256 of
    the verifier wasm, and the presentation size, freshness and clock-skew
    limits. They are part of the fork schedule digest, so a peer that pins
    other keys is a schedule mismatch. In the mainnet template the notary
    keys and the wasm sha256 are still `FILL` placeholders, and
    `launch-go-no-go` stays NO-GO until the notary key ceremony fills the
    keys and the release owner fills the wasm sha256. It also refuses the
    known devnet and test notary keys.
  - L2PS settlement (`l2psSettlement`): an L2PS transfer changes L1
    balances only through an `l2psBatch` of up to 9 transfers with a PLONK
    proof that every validator checks before it applies the same balance
    changes. Before, only the node that took the transfer applied its
    balance edits, so state could differ between nodes without any error. A
    batch that fails its checks is included as failed with no changes.
    Transfers in the old format are refused; L2PS clients need
    `@kynesyslabs/demosdk` 4.0.21.
  - Validators that are not subnet members set nothing: they verify with
    the settlement key in the release. With `l2psSettlement` scheduled, a
    node refuses to boot without that key, and a member also refuses to
    boot when its proving key, circuit or first prover fails. These checks
    run before the node serves, syncs or joins consensus. The image ships
    the keys. A bare-metal member builds them with
    `bun scripts/build-l2ps-zk-keys.ts`, which checks the result against the
    committed verification key.
  - `L2PS_SETTLEMENT_PROVERS` (default 1) sets how many settlement proofs a
    member runs at once. Each takes one core and about 1 GB for about 40 s.
    A value above 16 stops the node at start; a value below 1 counts as 1.
    `L2PS_ZK_ENABLED` and the old batch proof keys are obsolete under the
    fork; the node ignores the flag and says so at start.
  - Under `tlsnVerified` every validator verifies TLSNotary presentations
    itself, with a verifier compiled to wasm, shipped in the image and
    pinned by the fork's wasm sha256. It runs in a fresh instance per call,
    with a 64 MiB memory cap and a 1 MiB input cap. Validators still run no
    notary: keep `TLSNOTARY_ENABLED=false` and leave out the `tlsnotary`
    profile, as in INSTALL.
  - When the verifier cannot run while a block applies (a wasm that does
    not match the pin, or an instance that fails), the node throws
    `TlsnVerifierUnavailableAtApplyError` and does not apply the block. It
    gives no verdict, so it never fails a transaction that other nodes
    accept. Check that the node runs the release image by digest, then
    restart it. At RPC validation the same fault refuses the transaction
    with a reason to retry.
  - A `tlsn_request` now writes a token on chain: its id is the request
    transaction hash, its owner the sender, its domain the host of the
    URL, and it expires after 500 blocks. A `tlsn_store` and a TLSN
    identity link each need an unused, unexpired token of their sender for
    the attested server, and use it up. A store must be `onchain` (`ipfs`
    is refused), within the fork's size limit, attested by a listed notary
    key within the freshness window, with no Authorization, Cookie,
    Proxy-Authorization or Set-Cookie value revealed, and must carry the
    `X-Demos-Bind` header for its token. Nodes derive these edits at
    apply; a client cannot send them.
  - New migration `TlsnOnChainTokens1794268800000` on `gcr_tlsnotary`. Run
    it as in [database-migrations.md](database-migrations.md) before
    starting the new image.
  - TLSNotary clients need the next `@kynesyslabs/demosdk` release. The node
    opens a proxy only for a `requestTLSNproxy` sent over the HTTP RPC,
    signed over its body with this node's public key as the audience, by
    the sender of a confirmed, unexpired `tlsn_request` for the same host,
    with the request hash as the token id. Other calls get 401, and
    OmniProtocol refuses the call. The SDK the node pins, 4.0.21, still
    sends the unsigned call.
  - A load balancer that spreads one RPC name over several nodes without
    sticky sessions breaks the proxy. The signed call names one node, so
    another node answers it with 401, and the relay session lives only on
    the node that opened it. Send TLSNotary clients to one node, with
    sticky sessions or a per-node URL.
  - The `wstcp` proxy is gone, and bare metal no longer needs `cargo`. Each
    proxy session is a relay inside the node on one port of
    `TLSNOTARY_PROXY_PORT_MIN`-`MAX`, reached through the reverse proxy's
    `/tlsn/<port>/` route. A session admits one websocket that carries its
    secret session id. It ends 5 minutes after it was granted, after 60 s
    without traffic, at its byte caps, or when either side closes. Per
    node: 3 sessions per token with one live, 2 live per owner, 4 live per
    address, and 6 calls a minute per owner and 20 per address. These
    limits are local to the node and do not affect blocks. The proxy
    answers only with `TLSNOTARY_ENABLED=true`, and with
    `503 PROXY_DISABLED` otherwise.
  - `WSTCP_BIND_HOST` defaults to `127.0.0.1` (was `0.0.0.0`).
    `docker-compose.yml` sets `0.0.0.0` inside the container and publishes
    the window on loopback only. A bare-metal node that served the window
    on a public address needs a reverse proxy on the same host.
    `tlsnotary.getInfo` still advertises `TLSNOTARY_PROXY_PORT` (55688) for
    older clients, but nothing listens on it, and compose now publishes it
    on loopback only. Drop it from firewall rules.
  - Whoever runs the stock notary (`notary-server` v0.1.0-alpha.12) should
    give it 3 GiB. It peaks near 1 GiB per session and keeps a few hundred
    MiB after each one; with 1.5 GiB the third session of a test run was
    killed for memory.
  - A `tlsn_identity_remove` or `web2_identity_remove` with an unknown
    context, or a name such as `constructor` or `__proto__`, is refused at
    RPC validation with `Unsupported <web2|TLSN> context: <name>`. Before,
    the client was told the identity was removed, and the transaction then
    failed in the block and paid its fee. The undo of a TLSN link or unlink
    puts back exactly the link it took, and TLSN identity links accept the
    absolute request target (`GET https://api.github.com/user`) that tlsn-js
    sends.
  - A node on the mainnet chain id refuses to boot without
    `DEMOS_REQUIRE_VALIDATORS=true`, on a fresh start and on a restart. The
    parameter sheet already lists it. A snapshot restore checks each file's
    sha256 as it reads it, and a mismatch rolls back the genesis import.
  - `docs/mainnet/parameters.env` adds `SIGNALING_ENABLED=false`. Copy it
    into `.env`: `node-doctor --production` fails while it is unset or
    different.
  - With gossip on, the RPC refuses a transaction whose envelope is over
    262,144 bytes (`result: 400`, the reason in `extra.error`). Before, the
    node answered `published: true`, but peers never received it. One
    storage program create or whole-data write now carries at most about
    127 KiB of `json` data or about 95 KiB of `binary` data. Granular writes
    can still grow a program to 1 MiB.
  - Every loopback source address (all of `127.0.0.0/8` and `::1`) now skips
    the HTTP RPC's per-address limits, not only `127.0.0.1`. A reverse proxy
    or sidecar on the same host must be in `TRUSTED_PROXIES` and set
    `X-Forwarded-For` or `X-Real-IP`; one that sets neither makes every
    client it relays local. In strict mode a loopback value in a proxy
    header is skipped, and only the last 16 `X-Forwarded-For` entries are
    read.
  - When GitHub rejects the node's `GITHUB_TOKEN`, a GitHub link is refused
    with `this node's GitHub token was rejected by GitHub (expired or
    revoked); the node operator must renew GITHUB_TOKEN`, and
    `node-doctor --production` checks the token with one request to
    api.github.com. After renewing it, run `docker compose up -d node`:
    `docker compose restart` keeps the old value.
  - `demos_peerlist.json.example` now holds a placeholder that gives no
    peers. At bootstrap the node skips a peer-list entry with its own key,
    and its own URL when that URL names its RPC listener. A seed that
    answers as this node is refused, and the log names the entry to
    remove. The validator CLI reads `{ "url": ... }` entries and skips
    unusable ones. `show:pubkey` treats any whitespace as a word separator
    when it looks for the old hex format.
  - Test tooling: the quorum drills add 30-validator scenarios (shard size
    10) and a multi-host mode; 30 validators on one host need about 51 GB
    of memory. The backup and restore drill fails when node state is not
    writable by uid 1000 or when node X restarted.
  - New runbooks: [chain-halt-recovery.md](chain-halt-recovery.md),
    [genesis-key-custody.md](genesis-key-custody.md) and
    [exchange-integration.md](../mainnet/exchange-integration.md).
- From `v1.0.0-rc.14`:
  - `genesis-hash.ts` and `node-doctor --production` run the fork schedule
    check the node runs at boot (`genesisScheduleProblems`) and fail with
    the node's own reason, such as `the genesis does not declare
    l2psSettlement, tlsnVerified`. Run them before the node is stopped for
    an upgrade. `node-doctor` runs the check in the node image under
    compose (`docker compose run --rm --no-deps node bun
    scripts/genesis-schedule-check.ts`) and with Bun on a bare-metal host.
  - `launch-go-no-go` needs `--expected-notary-keys id:hex[,id:hex...]`
    (or `DEMOS_EXPECTED_NOTARY_KEYS`) on a mainnet chain id, for GO and for
    `--plan`, and is NO-GO when the genesis `tlsnVerified.notaryKeys` are
    not exactly those keys. Before, any well-formed key that was not one of
    this repository's test keys passed.
  - `launch-go-no-go` GO and `--plan` now require `--bots FILE` (`[]` for no bots).
  - `launch-height1-check` defaults to `--timeout 20000` and
    `--max-scan 1000` (were 5000 and 20), and stops reading blocks at the
    first one that carries a transaction. Run from outside the validators'
    network, the old defaults timed a probe out and reported INCONCLUSIVE
    once the head was past block 20.
  - A node with `TLSNOTARY_ENABLED=true` and no notary answering at
    `TLSNOTARY_HOST:TLSNOTARY_PORT` runs as a relay only: it logs a warning
    and keeps serving `requestTLSNproxy`, and `/health` no longer reports
    the `tlsnotary` subsystem as failed. With `TLSNOTARY_FATAL=true` it
    still exits.
  - Private L2PS transfers settle against a per-subnet L2PS nonce, kept on
    the account row (`gcr_main.l2psNonces`), and never against the L1
    nonce: an L1 transaction sent right after a private transfer no longer
    waits for its batch. Clients read the nonce with the nodeCall
    `getL2PSNonce { l2psUid, address }`; `@kynesyslabs/demosdk` 4.0.23,
    which this release pins, uses it by default, and an SDK without it signs
    private transfers with the L1 nonce, which the node now refuses once
    the two differ.
  - The settlement proof no longer binds balances (Interface v1.2): the
    circuit, the proving key and the verification key are new. The
    committed key's digest is
    `ac5dd4d2a719fd3d44f91e8940f4006bdee30e1e8a268ddbc36550bee23e581e`;
    rebuild the keys with `bun run setup --only zk --zk --zk-generate` (the
    setup refuses a build whose key differs from the committed one). Block
    apply checks in public that each account covers its net change.
  - New migrations `AddValidatorNftColumns1794182400000` (on `validators`)
    and `AddL2PSNonces1794355200000` (on `gcr_main`): run
    `bun run migration:run` before starting the node; it refuses to boot
    with a migration pending.
  - A chain on which private transfers have settled must not be upgraded in
    place: its accounts start with no L2PS nonce, so a transfer settled
    under the L1 nonce could settle again. Start it from a fresh genesis.
    The launch rehearsal restarts from a fresh genesis on this release;
    mainnet starts with it at block 0.
  - New fork `keylessWeb2Identity`, at height 0 in the mainnet set. Under
    it `web2_identity_assign` with context `github`, `discord` or `twitter`
    is refused at admission and at apply; those accounts link only through
    `tlsn_identity_assign`, whose endpoint table gains `twitter`
    (`GET https://api.x.com/2/users/me`, account from `data.username` and
    the decimal-string `data.id`). Telegram links, every identity remove and
    the links already stored are unchanged, and a TLSN Twitter link earns
    the Twitter points a web2 one does. Validators of such a network need no
    `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN` or `RAPID_API_KEY`, and
    `node-doctor --production` reports them as not needed when the genesis
    it reads schedules the fork at 0. Clients need an SDK whose TLSN link
    accepts the `twitter` context, such as `@kynesyslabs/demosdk` 4.0.23. A
    network that does not schedule the fork keeps the previous behaviour.
  - New fork `nftValidatorGating`. The mainnet set schedules it and
    `tokenStaking` at height 0 (32 forks at 0); `atomicWork`,
    `networkGovernance`, `l2psGate` and `tlsnDisabled` stay `null`. Every
    seat is then backed by an allowlisted Solana Node NFT and bonds no DEM.
    Each genesis validator carries `nft_mint`, `nft_owner` and
    `nft_proof_tx` and a `staked_amount` of `"0"`
    ([genesis.md](../mainnet/genesis.md)). `launch-go-no-go` reads the
    proofs on Solana once, before the genesis is sealed; a node building
    block 0 checks the NFT fields offline (allowlisted mint, well-formed
    owner and proof, no mint backing two seats, no `nft_exempt` on a mainnet
    chain id) and never reads Solana, so block 0 builds with Solana down.
    `launch-go-no-go` is NO-GO when either fork is not at 0, when a block 0
    seat lacks a valid NFT field set or its proof does not check out, and
    when the build does not pin its allowlist digest.
  - Under `nftValidatorGating` a new seat needs an NFT proof: one Solana
    transaction signed by the wallet that holds the NFT, made on the node's
    `/staking` page or with `bun run validator:nft-proof`, then
    `bun run validator:stake --nft-proof <signature>`. Stake, unstake, exit
    and the new `validator:challenge`, which evicts a seat whose NFT left
    the recorded wallet, pay no gas. An NFT-backed seat leaves 20 blocks after
    its unstake (a DEM bond still waits 1000). The steps are in
    [validator-staking.md](validator-staking.md).
  - On a network that schedules `nftValidatorGating`, every validator reads
    Solana when it admits a stake or a challenge: `SOLANA_RPC`, Helius when
    `HELIUS_API_KEY` is set, and the new comma-separated
    `VALIDATOR_SOLANA_RPCS` (by default the free public mainnet endpoints).
    No key is required. The node refuses to boot on an NFT allowlist that
    does not match its pinned digest, and only warns when no endpoint
    answers; it then leaves seat transactions out of its blocks until one
    does. Configure two or more endpoints: a seat is refused for a missing
    NFT only when at least two endpoints answered and agree.
  - A restarted validator waits until the network clock passes its restart
    signing floor (at most 7 s) before it joins the network, so the first
    round it joins is one it signs.
  - `launch-go-no-go` checks validator concentration (rules 6 to 8 in
    [launch-validators.md](../mainnet/launch-validators.md)). On a mainnet
    chain id every entry of the operator table needs an `owner`, the
    beneficial owner, and no owner runs more than 3 launch validators (with
    10 or more) or more than a third of the first committee. No region hosts
    a third or more of the launch validators, and no owner, operator,
    provider or region holds a third or more of block 0's stake. `--plan`
    adds a `beneficial owner cap` line and the owner and region counts.
  - `genesis-seeds.ts` asks for each seat's `EXPOSED_URL` after the mints
    are picked and before any Solana proof is sent, and writes it as the
    seat's `connection_url`. Before, every seat had `connection_url: null`,
    and go/no-go and `launch-height1-check` failed on it. An empty,
    non-http(s), bad-port or repeated URL is refused.
  - A `tlsnVerified.notaryKeys` entry may carry `validFrom` and
    `validUntil` (block heights, `validUntil` exclusive); the key is then
    trusted only for presentations in blocks in that range. A compromised
    key is closed with `validUntil` and stays listed, so applied blocks
    verify the same on resync. `tlsnDisabled` may carry `reenableAt` (at
    least its `activationHeight` + 2), the first block that accepts
    TLSNotary again. Files without these fields load as before, with the
    same fork schedule digest. A release that sets them is a schedule
    change that every validator must run before the heights it names, and
    no such height may move across a height the chain has passed. The steps
    are in [tlsn-notary.md](tlsn-notary.md), sections 6 and 7.
  - `launch-go-no-go` is NO-GO on any chain id when a genesis notary key
    carries a range. A presentation signed by a key that is not valid at
    the block's height is refused with `presentation is not signed by a
    notary key the chain trusts at this height` (was `... the chain
    lists`). `getNetworkInfo` still reports `tlsnDisabled` as activated
    after its `reenableAt`.
  - The notary healthcheck in `tlsnotary/docker-compose.yml` no longer
    calls `curl`, which the stock notary image does not ship, so the notary
    container now reports `healthy`.
  - With `PROD=true` the node refuses to start while
    `DEBUG_ASSERTIONS_ENABLED=true`, and the error names the variable. Set
    it to `false` or leave it unset. `node-doctor --production` fails on it
    too.
  - `validator:stake`, `validator:unstake` and `validator:exit` read
    `IDENTITY_FILE`. Without `--identity`, a `.env` that sets it to a file
    other than `.demos_identity`, or a `.env` the user cannot read, stops
    the command before it connects or signs; before, it used
    `.demos_identity`. Pass `--identity <file>` with the file the node runs
    as: bare-metal `./run` without `-i` runs as `.demos_identity`, while
    `./run --docker` and docker compose use the value in `.env`.
  - The confirmation of a native send returns the fee it charges in
    `attrs.total_fee` (ledger units) and the tip it read in
    `attrs.reference_block`. A send whose amount and fee exceed the balance
    is refused at confirmation with this quote and costs nothing; before,
    it could be confirmed, fail in a block and pay its fee. The ingress
    balance check compares the fee in OS units once `osDenomination` is
    active. Clients read `attrs.total_fee`, not `transaction_fee`, for
    display, send max and fee limits
    ([native-send-fee-quote.md](../native-send-fee-quote.md)).
  - When a block has committed but its follow-up fails, or its commit
    cannot be confirmed, the node stops signing (`[SIGNING] stopped until
    this process exits:`, marker 0), shuts down and exits with code 1, and
    resyncs from disk when started again; signing resumes then. Before, it
    exited at once. The node service in `docker-compose.yml` does not
    restart on its own, so start it again. A shutdown that hangs is forced
    after 3 s (was 10 s).
  - When the database fails during the check for GCR state above the chain
    tip, the node logs `could not check for orphaned GCR state; not
    applying until it can` and neither applies a synced block nor starts a
    round until the check runs. Before, it read the failure as no drift and
    applied on top. Sync resumes on its own once the database answers.
  - Monitoring: the Network & Peers dashboard uid is now
    `demos-network-peers`; the old one was also the folder uid, and Grafana
    loaded only four of the five dashboards. 17 panel queries in two
    dashboards now use the node's `demos_` metric names; they showed No data
    before. `prometheus.yml` and `alertmanager.yml` gain commented examples
    of an off-host scrape through a TLS reverse proxy and of a Telegram
    receiver ([mainnet-monitoring.md](mainnet-monitoring.md)).
  - A validator whose identity file holds the recovery phrase in a
    non-canonical form (full-width letters, the ideographic space U+3000 or a
    no-break space U+00A0) no longer boots. Its key was derived from those
    exact bytes, so it differed from the key a wallet derives from the same
    words. Retyping the phrase in plain lowercase ASCII gives a different
    node key: a validator staked under the old key unstakes and exits with
    the old file first (`validator.ts unstake` and `exit` still accept it;
    `stake` and `nft-proof` refuse it), then stakes again under the retyped
    phrase.
  - The RPC methods `login_request` and `login_response` and their
    OmniProtocol opcodes `0x50` and `0x51` are no longer served; an RPC call
    to either gets the unknown-method answer (501). The SDK does not call
    them. The OmniProtocol framer waits for the rest of a partial auth block
    instead of refusing the frame, and the secretary ignores a validator
    phase it does not know.
  - The bare-metal launcher (`./run` without `--docker`) exits with the
    node's status, after its usual clean-up. Before, it exited 0 whatever
    the node did. A crash, or one of the node's deliberate refusals to boot
    (exit 1), now ends `./run` non-zero, so a supervisor that restarts or
    alerts on a non-zero exit (systemd `Restart=on-failure`, a shell loop, a
    health check) acts on it; a refusal repeats on each restart until its
    cause is fixed. Ctrl-C still exits 0. `./run --docker` is unchanged.
    The block watchdog's exit code 42 now reaches the supervisor too; exempt
    it (systemd `RestartPreventExitStatus=42`), as `.env.example` says.
  - `launch-go-no-go` no longer limits beneficial owners or operators.
    Anyone may run as many validators as they hold seat NFTs for, so an
    owner or operator above `min(launch, shardSize) - quorum` validators, a
    third of the first committee's votes or a third of block 0's stake is a
    warning at T-0 and the advisory `--plan` line "owner and operator
    concentration" (`NOTE`, never `FAIL`). A mainnet entry without an
    `owner` is a warning too. Providers and regions keep their NO-GO
    limits. See `docs/mainnet/validator-concentration.md`.
  - New fork `peerlistFloor`, at height 0 in the mainnet set. Under it an
    identity enters a block's merged peerlist when `n - q + 1` voters
    observed it at the parent (4 of 10) instead of `q` (7), and a member
    refuses a dictated list that differs from that rule in its view. The
    committee of every block at a multiple of 720 is drawn from the parent's
    peerlist united with those of the 3 previous such blocks, so a
    committee of colluders that committed coalition-only lists keeps the
    chain for at most 720 blocks. It changes which committee signs a
    block, so a running chain takes it only at a coordinated height; the
    rehearsal restarts from a fresh genesis. A node that lacks one of the
    sampled blocks refuses to draw that committee instead of guessing.
    Design and numbers: `docs/design/peerlist-floor.md`.

## Known limits

- Debian packages installed with `apt-get` (curl, ca-certificates, xz)
  are resolved at build time. The two CI builds run minutes
  apart and resolve the same versions; a rebuild weeks later may not.
  Pinning them to a snapshot is the next step if a later rebuild has to
  match byte for byte.
- The reproducibility check covers `linux/amd64`, the platform validators
  run.
