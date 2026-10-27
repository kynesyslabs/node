# Cutting a release

Every validator runs the same artifact: an image built from a signed tag,
built twice from clean checkouts, published only when both builds produce
the same manifest digest. This page is the operator side of that rule.

## What is pinned

| What | Where | Why |
| --- | --- | --- |
| Bun version | `.bun-version` (also read by CI's `setup-bun`) | the runtime and the lockfile reader are one exact version everywhere |
| Base images | `Dockerfile`, `testing/devnet/Dockerfile`: tag plus `@sha256` digest | a tag such as `1.3-debian` moves; a digest does not |
| Node.js (gossip sidecar runtime) | `Dockerfile` `NODE_VERSION` + `NODE_SHA256` | one release, checked against its published checksum |
| Dependencies | `bun.lock`, installed with `--frozen-lockfile` on every path (`Dockerfile`, `scripts/run`, `scripts/install-deps.sh`, `scripts/reset-node`, CI) | the install fails instead of silently rewriting the lockfile |
| Lifecycle scripts | only the packages in `package.json` `trustedDependencies` (bufferutil, sqlite3, utf-8-validate); no `bun pm trust --all` anywhere | a new dependency's install script cannot run on a validator |
| Launcher | `./run` starts the checked-out commit; `./run -U` is the only way it pulls | a validator never picks up origin's head by accident |
| Launcher, Bun | `./run` refuses a Bun other than `.bun-version` | same reader of the lockfile on every host |
| Launcher, dependencies | `./run` installs from the lockfile on every start | a checkout moved to a new tag never runs on the previous tag's modules |

When you bump Bun, change `.bun-version` and both Dockerfiles together.
To find the digest of a new base image:

```bash
docker buildx imagetools inspect oven/bun:1.3.14-debian | grep Digest
```

The repo policy is enforced by `tests/release/reproducibleRelease.test.ts`
(`bun run test:release`, which uses the jest pinned in the lockfile).

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

Keep the private key off the validators and out of CI.

The release workflow does not trust the tag to name its own signers. It
reads `.github/allowed_signers` from the head of `stabilisation`, and it
refuses a tag whose commit is not on `stabilisation`. Both rules depend on
branch protection for `stabilisation` (required review, no force pushes):
whoever can merge there decides who may sign a release. Add or remove a
signer by merging a change to that file; a change made only on the tagged
commit has no effect.

## Cutting a release candidate

```bash
git checkout stabilisation && git pull --ff-only
git tag -s v1.0.0-rc.1 -m "v1.0.0-rc.1"
git verify-tag v1.0.0-rc.1
git push origin v1.0.0-rc.1
```

The `Release` workflow then:

1. checks the tagged commit is on `stabilisation` and verifies the tag
   signature against the `.github/allowed_signers` of that branch's head;
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
and digest, copied from `checksums.txt`:

```
IMAGE_NAME=ghcr.io/kynesyslabs/node
IMAGE_TAG=v1.0.0-rc.1@sha256:<digest from checksums.txt>
```

```bash
docker compose pull node && docker compose up -d
docker image inspect --format '{{index .RepoDigests 0}}' \
  "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q node)")"
```

The last line prints the digest the container runs; it must match
`checksums.txt`. Post it on the release thread.

A bare-metal validator (`./run`) checks out the tag instead and verifies it
locally before starting:

```bash
git fetch --tags origin stabilisation && git checkout v1.0.0-rc.1
git show origin/stabilisation:.github/allowed_signers > /tmp/allowed_signers
git config gpg.ssh.allowedSignersFile /tmp/allowed_signers
git merge-base --is-ancestor v1.0.0-rc.1 origin/stabilisation
git verify-tag v1.0.0-rc.1
./run
```

## Known limits

- Debian packages installed with `apt-get` (curl, ca-certificates, xz)
  and the `wstcp` crate's dependencies are resolved at build time. The two CI builds run minutes
  apart and resolve the same versions; a rebuild weeks later may not.
  Pinning them to a snapshot is the next step if a later rebuild has to
  match byte for byte.
- The reproducibility check covers `linux/amd64`, the platform validators
  run.
