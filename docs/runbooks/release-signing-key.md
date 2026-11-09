# Release signing keys

A validator installs only a release tag signed by a key listed in
`.github/allowed_signers` on `stabilisation`. This page is for the people who
hold those keys: how to make one, how it gets listed, how a tag is signed and
checked, and how a key is removed.

A final release (any tag not of the form `vX.Y.Z-rc.N`, `-alpha.N` or
`-beta.N`, so `v1.0.0` and also `v1.0.0-final`) needs
**three holders** in that file: Hov, Jeff and one more person
(kynesyslabs/mainnet-launch#4). Each holder has their own key; nobody holds
another person's key. Release candidates (`v1.0.0-rc.N`) still pass with the
single key listed today, so they keep moving while the other holders are
added.

## 1. Generate the key offline

Use a machine that is offline while the key is made: an air-gapped laptop, or
at least your own machine with networking switched off. Never generate it on a
server, a validator, a CI runner or a shared host.

```bash
ssh-keygen -t ed25519 -C "<name> demos release" -f ~/.ssh/demos_release_<name>
```

- Set a strong passphrase when asked. The private key file stays encrypted with
  it.
- Make one encrypted backup of `~/.ssh/demos_release_<name>` (for example on an
  encrypted USB drive kept apart from the laptop). The key is useless without
  the passphrase, and the passphrase is never stored next to the backup.
- The private key never goes into CI secrets, a password manager shared with
  others, a chat, or a repository. Only the `.pub` file leaves the machine.

Print the fingerprint:

```bash
ssh-keygen -lf ~/.ssh/demos_release_<name>.pub
# 256 SHA256:... <name> demos release (ED25519)
```

### Publish the fingerprint

Publish your email address (the principal of your `allowed_signers` line) and
that `SHA256:...` fingerprint outside GitHub: in the team's announcement
channel, the same place the genesis hash is published, and again in every
release announcement whose tag you signed, for example:

```
Signed by: <email>, ED25519 key SHA256:<fingerprint>
```

A validator compares both against what `git verify-tag` prints
(INSTALL.md, "Run a released image", step 1), and the key list against the
listing below, so someone who can push to the repository cannot quietly swap a
key. Give the full fingerprint as `ssh-keygen -lf` prints it, never a link to
the repository or a shortened form, and no URL other than the channel the
validators already know.

To list every key in the file with its fingerprint (the principal first):

```bash
git show origin/stabilisation:.github/allowed_signers |
  while read -r who _ type key; do printf '%s ' "$who"; echo "$type $key" | ssh-keygen -lf -; done
```

## 2. Add the public key to `.github/allowed_signers`

One line per holder, in the OpenSSH allowed-signers format. The principal is the
holder's email address:

```
<email> namespaces="git" ssh-ed25519 AAAA...
```

Build the line from your `.pub` file (it holds the key type, the key and the
comment; only the first two go in):

```bash
echo "<email> namespaces=\"git\" $(cut -d' ' -f1,2 ~/.ssh/demos_release_<name>.pub)"
```

Open a pull request to `stabilisation` that adds that one line, and have it
reviewed by an existing holder who checks the fingerprint against the one you
published. The release workflow reads the file from the head of
`stabilisation` only, so a line that exists only on a tag or another branch has
no effect.

## 3. Sign a release tag

Configure git once, on the machine that holds the key:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/demos_release_<name>.pub
```

Then tag the agreed commit on `stabilisation` by its full SHA, not the branch
tip, which may have moved since the commit was agreed (its `package.json`
version must already equal the tag without the `v`):

```bash
git fetch origin stabilisation
git merge-base --is-ancestor <agreed-sha> origin/stabilisation && echo "on stabilisation"
git tag -s v1.0.0 <agreed-sha> -m "v1.0.0"
git push origin v1.0.0
```

`git tag -s` asks for the key's passphrase. A holder whose key lives on an
offline machine copies the repository there, signs the tag, and copies the
repository back (for example with `git bundle`) to push it; the private key
itself never moves.

## 4. Verify a tag locally

Anyone can check a tag the way the release workflow does:

```bash
git fetch --tags origin stabilisation
SIGNERS="$(git rev-parse --absolute-git-dir)/demos-allowed-signers"
git show origin/stabilisation:.github/allowed_signers > "$SIGNERS"
git merge-base --is-ancestor v1.0.0 origin/stabilisation && echo "on stabilisation"
git -c gpg.ssh.allowedSignersFile="$SIGNERS" verify-tag v1.0.0
```

The list goes into the clone's own `.git`, so two checkouts on one host never
read each other's copy.

`git verify-tag` prints `Good "git" signature for <email> with ED25519 key
SHA256:...`. Check both parts: the email must be one of the agreed holders and
the fingerprint must match the one that holder published
([Publish the fingerprint](#publish-the-fingerprint)). "Good signature"
alone only says some listed key signed it.

## How the release workflow checks the tag

`.github/workflows/release.yml`, job `verify-tag`, on every pushed `v*` tag:

1. The tag must be an annotated tag (`git tag -s`), not a lightweight one.
2. The tagged commit must be an ancestor of `stabilisation`, so only reviewed
   code is released.
3. The signer list is read from `.github/allowed_signers` at the head of
   `stabilisation`, never from the tag itself, so pushing a tag cannot grant
   signing rights.
4. For a final release (the tag matches `vMAJOR.MINOR.PATCH` with no suffix, or
   the repository variable `FINAL_RELEASE` is `true`), that list must hold at
   least `REQUIRED_RELEASE_SIGNERS` (3) holders. A key listed twice, or several
   keys under one email, counts once. With fewer the workflow stops before
   building anything.
5. `git verify-tag` must accept the signature against that list.
6. The tag must equal `v` plus `package.json`'s `version` at the tagged commit.

Only then are the two independent builds made and compared (see
[release.md](release.md)).

Set `FINAL_RELEASE=true` under the repository's Actions variables to apply the
three-holder rule to release candidates as well, for example for the last
candidate before launch.

## Rotation and removal

- **Planned rotation:** generate the new key as in step 1, add its line and
  remove the old one in one reviewed pull request, publish the new fingerprint.
  Tags signed earlier with the old key no longer verify against the new list;
  that is expected, since validators verify the tag they are about to install.
- **Holder leaves:** remove their line through a reviewed pull request and add
  the replacement holder's line. A final release cannot be cut until the list
  is back to three holders.
- **Key lost or suspected stolen:** remove its line from `stabilisation`
  immediately, announce the fingerprint as revoked on the same channel where it
  was published, and have another holder sign the next release. If a tag was
  signed with that key after the suspected compromise, treat that release as
  untrusted and re-sign the next release with a remaining key.

Branch protection on `stabilisation` (required review, no force pushes) is what
makes this list trustworthy: whoever can merge there decides who may sign.
