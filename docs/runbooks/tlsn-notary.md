---
type: runbook
title: TLSNotary notary operations
date: 2026-11-17
status: draft
---

# TLSNotary notary operations

How the Demos notary is deployed, how its signing keys are made and pinned,
and what to do when a key, the clock or the memory goes wrong. Validators do
not run a notary on mainnet (`COMPOSE_PROFILES=` and `TLSNOTARY_ENABLED=false`,
INSTALL.md); every node verifies presentations itself against the keys the
`tlsnVerified` fork payload lists. The one exception is the relay role
(section 1): the public RPC nodes designated as relay set
`TLSNOTARY_ENABLED=true`, still without a notary.

Files: `tlsnotary/notary-service/` in the node repository.

| File | What it is |
|---|---|
| `docker-compose.yml` | one notary: the stock `notary-server:v0.1.0-alpha.12`, pinned by digest, 3 GiB memory cap, non-root, read-only, published on loopback |
| `notary-guard.sh` | start guard: `preflight` on the host before every start, `exec` as the container entrypoint |
| `tlsn-notary.service` | systemd unit: preflight, then `docker compose up` |
| `notary.env.example` | the settings, read by all of the above and the health check |
| `notary-check.sh` | health check for cron |
| `notary-key-ceremony.sh` | makes one key, offline, SOPS-encrypted to the holders |

## 1. What runs where

- **Two notary instances on separate hosts**, behind the one notary URL the
  SDK pins (`TLSN_MAINNET_NOTARY_URL`), with failover between them in the TLS
  reverse proxy or DNS. Both sign with `demos-notary-1`, the key the genesis
  lists as the running key ([docs/mainnet/genesis.md](../mainnet/genesis.md)).
- **`demos-notary-standby`** is listed in the genesis too but never runs
  until a rotation (section 6). It stays SOPS-encrypted with the holders.
- **Failover is active/passive, or sticky per session.** A prover's
  `POST /session` and its `/notarize?sessionId=...` websocket must reach the
  same notary process: the session lives in that process's memory. Send all
  traffic to one instance and switch to the other only when the first fails
  its health check (a proxy with a backup upstream, or DNS failover), or pin
  each client to one instance. Round-robin per request breaks every second
  session. A switch drops the sessions in flight on the failed instance;
  their provers retry.
- Running the two instances on distinct keys is possible (up to 8 keys) but
  needs a third `notaryKeys` entry in the genesis and the SDK pins; that is an
  owner decision (section 10).
- **Relay nodes serve `requestTLSNproxy`.** A prover's browser reaches the
  attested site through a per-session proxy that a Demos node opens for a
  confirmed `tlsn_request`. The nodes that serve this are the public RPC
  node or nodes designated as relay: `TLSNOTARY_ENABLED=true`,
  `COMPOSE_PROFILES=` (no notary sidecar) and the `/tlsn/<port>/` reverse
  proxy ([tlsn-reverse-proxy.md](tlsn-reverse-proxy.md)). The relay needs no
  local notary: such a node logs `[TLSNotary] Relay only: no notary answers
  at ...` as a warning at start and reports `tlsnotary` ready with
  `mode: relay-only` in `/health`; its `tlsnotary.getInfo` answers 503,
  because provers use the notary URL the SDK pins. Every other validator
  keeps `TLSNOTARY_ENABLED=false`. `TLSNOTARY_FATAL=true` turns a missing
  notary into a stop, so it is never set on a relay. Which nodes take the
  role is an owner decision (section 10).
- **Trust.** A notary that colludes with a prover can attest a false
  identity link. Linked identities gate points, so this is a stated trust
  assumption of TLSNotary on Demos, and the reason the keys are held by two
  people and the hosts run nothing else.
- **Availability.** A notary outage stops new identity links and stores
  only. Consensus never calls the notary.

Why each guard exists (TLSN design, section 2.5):

- **F0.** The stock notary signs with a random key that changes on every
  restart when its key file is not set. Nothing at the notary shows it;
  every presentation it signs is then refused on chain. The guard refuses to
  start without the pinned key, and the health check alerts when the served
  key differs.
- **F9.** A notary attests the time its own clock shows. Nodes refuse an
  attested time later than the block time + `futureSkewSec` (60 s on
  mainnet) or older than `freshnessWindowSec` (3600 s). The guard refuses to
  start on an unsynchronised clock, and the health check alerts at half the
  skew.

## 2. Deploy one instance

Per host. `<checkout>` is the node repository at the release tag in use,
checked with `git verify-tag` (INSTALL.md, "Run a released image").

1. **Host.** Docker with compose v2, systemd, NTP on (chrony or
   systemd-timesyncd: `timedatectl show -p NTPSynchronized --value` prints
   `yes`), at least 4 GiB of RAM free for the notary. The host runs no
   validator and nothing else exposed.
2. **Key file.** A key holder decrypts the key on their own machine and
   streams it to the host; the plain key is never written on the holder's
   machine. The host keeps the staged copy only if it holds the key the
   ceremony published, so a failed or wrong decryption leaves the current
   key file in place:

   ```bash
   set -o pipefail
   sops decrypt --input-type json --output-type binary demos-notary-1.key.sops.json |
     ssh root@<notary-host> 'set -e; install -d -m 0700 /etc/tlsn-notary; umask 077
       f=/etc/tlsn-notary/notary.key.new; trap "rm -f $f" EXIT
       cat > "$f"
       . <checkout>/tlsnotary/notary-service/lib.sh
       [ "$(k256_pkcs8_pubkey "$f")" = "<hex from demos-notary-1.notary-key.json>" ] ||
         { echo "staged key is not the expected key; current key kept" >&2; exit 1; }
       chown 10001:10001 "$f"; chmod 0400 "$f"
       mv "$f" /etc/tlsn-notary/notary.key'
   ```

   The command must exit 0; a non-zero exit from either side means nothing
   was installed. 10001 is the container user (`NOTARY_UID`). The guard
   refuses a key file that others can read or its group can write.
3. **Settings.** Copy `notary.env.example` to `/etc/tlsn-notary/notary.env`
   (root, 0600) and set `NOTARY_EXPECTED_PUBKEY` to the key's `hex` from the
   ceremony's `<id>.notary-key.json` (it must be in the genesis `notaryKeys`).
4. **Unit.** Copy `tlsn-notary.service` to `/etc/systemd/system/`, replace
   `<checkout>`, then:

   ```bash
   # Pull first: the container refuses a preflight stamp older than 300 s
   (cd <checkout>/tlsnotary/notary-service && docker compose --env-file /etc/tlsn-notary/notary.env pull)
   systemctl daemon-reload
   systemctl enable --now tlsn-notary
   journalctl -u tlsn-notary -n 20   # "preflight passed: key SHA256:..." then "checked, starting notary-server"
   ```

   Start, stop and restart only through the unit. Docker never restarts the
   container itself (restart policy "no"); systemd restarts it through the
   preflight. `docker compose up` or `docker start` by hand, more than 300 s
   after the last preflight, finds no fresh stamp and the container refuses
   to start (exit 7).
5. **TLS reverse proxy.** The notary listens on `127.0.0.1:7047` without TLS.
   Put it behind the site that serves the notary URL; the prover uses
   `POST /session` and a websocket on `/notarize?sessionId=...`, so the proxy
   must keep the query string and pass the upgrade (Caddy does by default; nginx needs `proxy_http_version 1.1`,
   `Upgrade $http_upgrade` and `Connection "Upgrade"`, as in
   [tlsn-reverse-proxy.md](tlsn-reverse-proxy.md)).
   Rate-limit `/session` per client address: each session holds about 1 GiB
   of the notary's memory for up to 5 minutes.
6. **Check.** `notary-check.sh`, run as section 5 shows, exits 0.
7. **Failover drill.** With both hosts up, stop the active instance
   (`systemctl stop tlsn-notary`), check that the public URL serves the
   other one (`<notary-url>/info` shows the same key, a test link
   completes), then start it again. Repeat after every proxy change.

Memory and sessions: `NOTARY_CONCURRENCY` (default 2) is the number of
sessions in flight; each peaks near 1 GiB and the server keeps a few hundred
MiB afterwards, so 2 fit the 3 GiB cap. A third session waits. Raise the cap
and the concurrency together, never the concurrency alone.

The notary's data limits (32 KiB sent, 64 KiB received) and the 300 s
session timeout are fixed in `docker-compose.yml` and match the e2e harness
(`testing/tlsn-e2e`).

### Guard exit codes

`notary-guard.sh`, in the journal (preflight) or as the container's exit
code (`exec`):

| Code | Meaning | Fix |
|---|---|---|
| 2 | configuration: `NOTARY_EXPECTED_PUBKEY` malformed, no key path, `NOTARY_BIND` on every interface | the env file |
| 3 | key file missing, not a file, unreadable, empty or oversized; in the preflight also a file the container user cannot read (owner not `NOTARY_UID`, and not group `NOTARY_GID` with group read) | section 2, step 2 (`chown 10001:10001`) |
| 4 | key file readable by others or writable by its group | `chmod 0400` |
| 5 | not an unencrypted PKCS#8 secp256k1 key with its public key (P-256, SEC1, encrypted, truncated) | decrypt the ceremony's file again |
| 6 | the key file holds another key than `NOTARY_EXPECTED_PUBKEY` | the wrong key or the wrong env file; never "fix" by changing the expected key to what the file holds |
| 7 | clock unsynchronised or more than `NOTARY_MAX_CLOCK_OFFSET_SEC` off, or the preflight stamp is missing, stale or for another key | section 8; start through the unit |

`NOTARY_ALLOW_UNSYNCED_CLOCK=1` skips the clock checks for local development.
It is never set on a host whose key a genesis lists.

## 3. Key ceremony

Two holders per key (the same model as the release key,
[release-signing-key.md](release-signing-key.md)). Each holder has an age
key of their own (`age-keygen`); only their `age1...` recipients come to the
ceremony. Either holder alone can decrypt, so the key survives the loss of
one holder; both being needed is not a property of SOPS age recipients.

On an offline machine (the script refuses a host with a default route) with
`openssl`, `sops` and this repository:

```bash
tlsnotary/notary-service/notary-key-ceremony.sh --id demos-notary-1 \
  --recipient <age1 of holder A> --recipient <age1 of holder B> --out-dir ./ceremony
tlsnotary/notary-service/notary-key-ceremony.sh --id demos-notary-standby \
  --recipient <age1 of holder A> --recipient <age1 of holder B> --out-dir ./ceremony
```

Each run prints the `notaryKeys` entry, the public key and its fingerprint,
and writes:

- `<id>.key.sops.json`: the private key, encrypted to the holders. It goes to
  the holders and the encrypted backup location, never into a repository
  that is not access-controlled for that purpose.
- `<id>.notary-key.json`: `{"id","alg":"k256","hex"}` for the fork payload.

The private key is made in a RAM-backed temporary directory (`/dev/shm`, or
`TMPDIR` when that is tmpfs), never printed, and wiped on exit. Without a
RAM-backed directory the script refuses (exit 6); `--allow-disk-temp` lets
it use disk, for rehearsal keys only, since a wiped file can survive on an
SSD. The script refuses an existing output (a key id is made once).
`--allow-online` exists for rehearsal keys only.

Before the ceremony ends, each holder decrypts their copy and checks it:

```bash
sops decrypt --input-type json --output-type binary ceremony/demos-notary-1.key.sops.json |
  openssl pkey -pubout -outform DER -ec_conv_form compressed | tail -c 33 | xxd -p -c 33
```

prints the same `hex` as `demos-notary-1.notary-key.json`. Then both holders
publish the key ids and fingerprints outside GitHub, in the channel where
the release key fingerprints are published, so a swapped key in a pull
request is caught.

## 4. Filling the mainnet pins

The public keys go to two places, in the same order and with the same ids.

1. **Node, genesis.** `forks.tlsnVerified.notaryKeys[].hex` in the launch
   genesis made from `docs/mainnet/genesis.template.json` (rows in
   [docs/mainnet/genesis.md](../mainnet/genesis.md)). The ids stay
   `demos-notary-1` and `demos-notary-standby`.
2. **SDK.** `TLSN_MAINNET_NOTARY_KEYS` and `TLSN_MAINNET_NOTARY_URL` in
   `src/tlsnotary/network.ts` of `kynesyslabs/sdks`, then an SDK release and
   the node's SDK pin bumped. While they hold `FILL:` the SDK refuses to
   attest on mainnet.

Then go/no-go ([launch-go-no-go.md](launch-go-no-go.md)), run with
`--expected-notary-keys demos-notary-1:<hex>,demos-notary-standby:<hex>` from
the ceremony, must have no `tlsnVerified` or notary keys reason left: it is
NO-GO when the genesis keys are not exactly that set, and on a `FILL` key,
a malformed key or a point not on the curve, a repeated key, and any key of
this repository's devnet, spike or test vectors (`KNOWN_TEST_NOTARY_KEYS`). A notary key is
never generated by a script on a server or copied from a test.

Last, compare the fingerprint `notary-check.sh` prints on each notary host
with the published one.

## 5. Monitoring

`notary-check.sh` takes its settings from the environment, the same
variables as `/etc/tlsn-notary/notary.env`; it does not open the file
itself. Run it by hand with the file loaded:

```bash
(set -a; . /etc/tlsn-notary/notary.env; set +a; <checkout>/tlsnotary/notary-service/notary-check.sh)
```

One line per check, exit code of the first failure:

| Code | Meaning |
|---|---|
| 0 | healthy |
| 1 | configuration error or `curl` missing |
| 2 | `/healthcheck` did not answer 200 |
| 3 | `/info` serves another key than the pinned one, or none (the notary is signing with a key no node accepts) |
| 4 | clock unsynchronised, or offset at or above `NOTARY_MAX_CLOCK_OFFSET_SEC` (30 s, half the mainnet `futureSkewSec`) |

Run it every minute from root's crontab and alert on a non-zero exit through
the team's alert route (owner decision, section 10):

```cron
* * * * * set -a; . /etc/tlsn-notary/notary.env; set +a; <checkout>/tlsnotary/notary-service/notary-check.sh > /run/tlsn-notary/check.last 2>&1 || { rc=$?; <alert command> "tlsn-notary $(hostname): exit ${rc} $(grep FAIL /run/tlsn-notary/check.last | head -3)"; }
```

Check the public URL from outside too (any uptime monitor on
`<notary-url>/healthcheck`): the local check does not see the reverse proxy.

## 6. Key rotation

The `tlsnVerified` payload holds one key list from its activation height.
Every validator judges a presentation against that list, at admission and
again whenever a block is applied, a resync from block 0 included.

- **Adding a key is replay-safe**: nothing on chain was signed by it. It
  ships in a release that adds the entry to `notaryKeys` in every
  validator's genesis and to the SDK pins. Never sign with it before every
  validator runs that release: a validator without it would refuse what the
  others accept.
- **Removing a key is not replay-safe today.** A node resyncing from block 0
  would refuse the presentations that key signed and leave the chain.
  Removal needs a height-scoped key list (a key valid until height H), which
  the current payload does not have. Until it does, a retired key stays
  listed; its private copies are destroyed if it was not compromised.

Planned rotation to the standby (no release needed, the standby is already
pinned):

1. Holders stream `demos-notary-standby` to both hosts as a second file,
   `/etc/tlsn-notary/notary-standby.key` (section 2, step 2, with the
   standby's encrypted file and `hex`, and that name as the last `mv`
   target: owner 10001, mode 0400). The running key file stays untouched, so
   a host can go back to it at any point.
2. Per host, one at a time, starting with the passive one: in
   `/etc/tlsn-notary/notary.env` change `NOTARY_KEY_FILE` to the standby
   file and `NOTARY_EXPECTED_PUBKEY` to the standby key together (the guard
   refuses with exit 6 if only one changes), `systemctl restart
   tlsn-notary`, run `notary-check.sh` (section 5). Then switch the active
   one.
3. When both hosts serve the standby key, destroy the old key's plain
   copies on the hosts (`shred -u /etc/tlsn-notary/notary.key`).
4. Hold a new ceremony for the next standby and ship it as an added key
   (above).

Rehearse this on the rehearsal network (TLSN design, section 6, key-rotation
drill) before mainnet needs it.

## 7. Revocation and emergency

A key is compromised when its private half may be known to anyone but the
holders and the notary hosts: a host breach, a leaked decrypted file, a lost
holder machine with the age key on it.

1. **Stop the forgery path on chain.** The kill switch `tlsnDisabled`,
   scheduled at a height H through an emergency release (tier 2,
   [chain-halt-recovery.md](chain-halt-recovery.md),
   [release.md](release.md); schedule rules in
   [fork-schedule-policy.md](fork-schedule-policy.md)), refuses
   `tlsn_request`, `tlsn_store` and every `tlsnotary` edit from H, before
   any fee. An identity link needs a pending `tlsn_request` of its sender,
   so new links stop once the requests made before H have expired: a
   request lives 500 blocks (`TLSN_REQUEST_TTL_BLOCKS`), about an hour at
   the 7 s block target. Links made with the key in that window are
   recorded in step 3.
2. **Stop both notaries** (`systemctl stop tlsn-notary`) if the key they run
   is the compromised one, and destroy its plain copies.
3. **Record** the height H, the key id and every link made with the key
   since the suspected time (`attestationId` of each), for the owners to
   decide on.
4. **Re-enable.** The kill switch has no lifting fork today, and the
   compromised key cannot be removed from the list (section 6), so turning
   TLSNotary back on after a compromise is a node change: a release that
   ends `tlsnDisabled` and scopes the old key to heights below H. Plan it
   before re-enabling.

A notary that only misbehaves (wrong key served, crash loop) is not a
compromise: stop it, fix it, and the other instance keeps serving.

## 8. NTP failure

Symptoms: `notary-check.sh` exits 4, the preflight refuses with code 7, or
users' links fail with a time refusal while the notary is up.

1. Take the instance out of the proxy's pool, or `systemctl stop
   tlsn-notary` if it is the only one: a clock ahead of the chain makes
   every presentation fail, a clock behind makes it look older than it is.
2. Fix the time source: `timedatectl set-ntp true`, or chrony's sources
   (`chronyc sources -v`); check the host firewall lets NTP out (udp 123).
3. Wait until `timedatectl show -p NTPSynchronized --value` prints `yes`
   and `chronyc tracking` (if used) shows an offset well under a second.
4. `systemctl start tlsn-notary`, then `notary-check.sh` (section 5).

Never step the clock back while the notary runs.

## 9. Out of memory

Symptoms: the container exits with 137, `docker inspect` (project
`tlsn-notary`) shows `"OOMKilled": true`, and systemd restarts it through
the preflight (5 tries in 10 minutes, then it stays down and needs
`systemctl reset-failed tlsn-notary && systemctl start tlsn-notary`).

- The stock notary peaks near 1 GiB per 16 KiB session and keeps memory
  after it; it was OOM-killed at a 1.5 GiB cap. Keep the 3 GiB cap and
  `NOTARY_CONCURRENCY` at 2, or lower it to 1.
- Repeated kills under load mean the proxy lets too many sessions through:
  tighten the per-address limit on `/session` before adding memory.
- If memory grows across idle hours, a nightly
  `systemctl restart tlsn-notary` while no session runs returns it.

## 10. Owner decisions pending

Nothing below is decided in this repository; fill it outside GitHub where
names and hosts are kept, as for the genesis keys
([genesis-key-custody.md](genesis-key-custody.md)).

| Item | Value |
|---|---|
| Holder A of the notary keys | TBD (owner) |
| Holder B of the notary keys | TBD (owner) |
| Where the encrypted key files are kept | TBD (owner) |
| Notary host A, host B (providers, regions) | TBD (owner) |
| Mainnet notary URL (`TLSN_MAINNET_NOTARY_URL`) | TBD (owner) |
| Same key on both instances, or distinct keys (a third genesis entry) | TBD (owner); section 1 |
| Alert route for `notary-check.sh` | TBD (owner) |
| Relay nodes for `requestTLSNproxy` (which public RPC nodes run `TLSNOTARY_ENABLED=true`) | TBD (owner); section 1 |
