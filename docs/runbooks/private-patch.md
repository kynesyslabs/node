# Private patch to validators before disclosure

Used for a Critical or High report (`SECURITY.md`) whose fix would show
attackers the hole if it landed on a public branch first. The fix reaches
validators holding more than two thirds of the active set before anything is
public. Decided 2026-11-27 (mainnet-launch#17).

The public release workflow (`.github/workflows/release.yml`) cannot be used
for this step: it builds only commits reachable from public `stabilisation`.
The private path below reuses its build command, so the image a validator
builds privately has the same digest the public release publishes later.

## Who takes part

- **Two maintainers** write and review the fix. Both hold release-signing
  keys (`.github/allowed_signers`).
- **Patching operators:** enough operators that their validators are more
  than two thirds of the active set (`getValidators`). The launch coordinator
  keeps each operator's GitHub handle and security contact (mainnet-launch#7)
  so they can be added within the hour.

## Steps

1. **Private fork.** On the GitHub advisory for the report, create the
   temporary private fork. Branch from the commit mainnet runs, fix it there,
   and get the second maintainer's review on the fork's pull request.
2. **Signed tag.** Tag the fix commit with the next patch version, signed
   with a release key (`git tag -s`). Push the tag to the private fork only.
3. **Two builds.** Both maintainers build the image from the tag with the
   command below and post the digest in the advisory thread. The digests must
   be equal; if they are not, stop and find out why.
4. **Operators.** Add the patching operators as collaborators on the
   advisory. Each one fetches the tag, checks the signature
   (`git verify-tag`), builds with the same command, and confirms that the
   digest matches the maintainers' digest. They load the image from that
   same `image.tar` (`docker load -i image.tar`), tag the loaded image, set
   `IMAGE_NAME` and `IMAGE_TAG` in `.env` to that tag (`docker-compose.yml`
   reads them), and restart one validator at a time, never two at once. Each operator posts
   the running digest and its validator addresses in the thread.
5. **Coverage.** When the confirmed validators are more than two thirds of
   the active set, the maintainers push the same commit to `stabilisation`,
   push the same signed tag to the public repository, and let the release
   workflow publish it. The workflow rebuilds the same digest from the public
   commit.
6. **Disclosure.** Publish the advisory and announce the upgrade to the
   remaining operators through the normal release notes. The reporter is
   credited unless they asked not to be.

Build command (the same inputs as `release.yml`):

```bash
TAG=vX.Y.Z
git checkout "$TAG"
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
GIT_COMMIT=$(git rev-parse HEAD) \
GIT_COMMIT_MESSAGE=$(git log -1 --format=%s) \
BUILT_AT=$(TZ=UTC git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd) \
docker buildx build \
  --no-cache --provenance=false --sbom=false \
  --platform linux/amd64 \
  --build-arg SOURCE_DATE_EPOCH --build-arg GIT_COMMIT \
  --build-arg "GIT_BRANCH=$TAG" --build-arg GIT_COMMIT_MESSAGE \
  --build-arg GIT_DIRTY=false --build-arg BUILT_AT \
  --output type=oci,dest=image.tar,rewrite-timestamp=true \
  .
tar -xOf image.tar index.json | jq -r '.manifests[0].digest'
```

`GIT_BRANCH` is the tag name, as in the workflow; any other value changes
the digest.

## Rules

- Nothing about the fix goes to a public branch, issue, pull request or
  channel before step 5.
- A fix that changes consensus rules ships with a fork height far enough
  ahead that every validator can upgrade before it, so validators that
  have not upgraded do not split from the chain.
- If the hole is being exploited, the war room may halt the chain first
  (`docs/runbooks/chain-halt-recovery.md`); the steps stay the same.

## Rehearsal

Run once before launch on the rehearsal network: a harmless change on a
private fork, two maintainer builds, two operators building and swapping one
validator each, digests compared with the later public release.
