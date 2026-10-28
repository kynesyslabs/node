---
type: runbook
title: Validator Key Handling and Failover
date: 2026-10-28
status: active
---

# Validator Key Handling and Failover

The identity file (`.demos_identity` by default, or `IDENTITY_FILE`) holds the
mnemonic that is the validator key. Anyone who can read it can sign blocks as
this validator.

## What the node protects

Next to the identity file the node keeps `<identity file>.signed.json`, a
record of the last block it signed: chain genesis hash, height, round
timestamp and block hash. Before signing, the node refuses a block that
conflicts with the record (a lower height, an earlier round at the same height,
or a different block for a round it already signed). It writes the record
after signing and before the signature leaves the process.

This covers restarts of the same node and several processes that share one
state directory (for example a shared disk). A copy of the key running on an
independent host is caught only once its signatures reach this node (see
"Self-check against the chain" below).

Keep the record together with the identity file. Deleting it is only safe
after the chain itself was reset.

Under docker compose the container entrypoint links the record for the
configured `IDENTITY_FILE` into the `/app/state` volume. If `IDENTITY_FILE` is
an absolute path or sits in a subdirectory, the entrypoint only warns: put the
identity file and its `.signed.json` record on a persistent volume yourself.

Writing the record takes a short-lived lock file (`<record>.lock`) so that two
nodes sharing a state directory cannot both record a different block for one
round. A lock held by a live process makes the round abort without signing; a
lock from a dead process or older than 30 seconds is replaced.

## One host signs for each key

Exactly one named host runs a validator for a given key at any time. Write the
host down next to the key's backup. Never start a second node with the same
key "just to test".

## The identity lock

The node holds `<identity file>.lock` next to the real identity file. Under
docker compose `/app/.demos_identity` is a link into the `/app/state` volume,
so the lock is on the volume too, and two containers sharing that volume see
each other's lock.

The lock is a lease. The running node rewrites it every 5 seconds with its
pid, hostname, a random instance id and a heartbeat time. A starting node
that finds a lock:

- refuses to start when the heartbeat keeps advancing while it watches. The
  error names the other node's pid, host and how long ago it last beat;
- replaces it once the heartbeat has stopped. It watches for 10 to 25
  seconds first, because clocks of two hosts can disagree;
- replaces at once a lock from its own host whose heartbeat is older than 20
  seconds, and a lock from an older node version whose pid is gone.

So a container recreated after a crash starts without any flag, a few
seconds late. `DEMOS_IDENTITY_TAKEOVER=true` only skips the watch for a lock
whose heartbeat is already older than 20 seconds. It never replaces a lock
that keeps beating: that is a second live node with this key.

If the running node finds its lock deleted or rewritten by another instance,
it logs an error, stops signing and shuts down. Find out which node took the
lock before starting this one again.

## Failover to another host

1. Stop the old node and confirm it is down: no process, no container, no
   answer on its RPC port. If the machine cannot be reached, make sure it
   cannot start again (power it off or revoke its access) before going on.
2. Copy the whole state directory to the new host: the identity file and its
   `.signed.json` record. The record is what keeps the new host from signing
   a round the old one already signed. An older copy of the record makes the
   self-check below stop the new node.
3. Start the new node. If the copied lock still beats, the old node is alive:
   go back to step 1. A stale lock is replaced after a short watch;
   `DEMOS_IDENTITY_TAKEOVER=true` skips that watch. Remove the variable once
   the node runs.

## Self-check against the chain

Every block a validator signs is in its signing record before the signature
leaves the node. When a block received from peers (sync or gossip) passes
verification and carries a valid signature by this node's key, the node
compares it with the record. A signature above the recorded height, or a
different block for the recorded round, was made by another copy of the key.
The node then:

- logs `[SIGNING] another process is signing with this node's key`, with the
  block and the recorded round;
- increments the metric `demos_foreign_signature_total`;
- refuses to sign any further block until it is restarted. It keeps syncing.

Blocks this process signed itself, older heights, and records of another
chain never trigger it. A different block at the recorded height with an
earlier round time is only logged as a warning: it can be a round this node
signed before a restart.

When it fires:

1. Stop every node that has this key, including this one.
2. Find the second host: check where the key was copied, old hosts and
   containers, and restored backups. This node's log may already name it in
   `[IDENTITY] another process is using our identity ... at <url>`.
3. Make sure only one copy can run, then start that one with the newest
   state directory (identity file and record).

Alert on `demos_foreign_signature_total > 0`.

## Production refusals

With `PROD=true` the node refuses some things that are routine on devnets.
Each has an override for the one start that needs it; remove the override
afterwards.

| Situation | What the node does | Override |
|-----------|--------------------|----------|
| Identity file missing | Stops at start; usually the state volume is not mounted | `DEMOS_GENERATE_IDENTITY=true` creates a brand-new key |
| Signing record belongs to another genesis | Refuses to sign; the node is on the wrong chain or got a foreign state directory | `DEMOS_SIGNING_RECORD_REBIND=true` after a deliberate network reset |

Before using either override, check the mount and the chain: a new key or a
rebound record on the wrong chain loses the protection this runbook describes.

## Generating and backing up the key

- Generate the key on a trusted machine, not on the validator host, and copy
  only the identity file over a secure channel.
- Keep one encrypted backup (for example age or gpg) held by a second person.
  The passphrase or key for that backup is stored separately from the backup.
- Never put the mnemonic in chat, tickets, shell history or logs.

## After a chain reset

The record stores the genesis hash of the chain it belongs to. Outside
production, when the node sees a different genesis it logs a warning naming
both hashes, overwrites the record and carries on. With `PROD=true` it
refuses to sign instead; start once with `DEMOS_SIGNING_RECORD_REBIND=true`
after confirming the reset. Lower heights are still refused on the same
chain.

## Expected file modes

- Identity file: `600`. The node tightens it on start if group or other bits
  are set, and logs a warning when it does. If it cannot (read-only mount,
  other owner) it still starts, so fix the mode on the host.
- Signing record: `600`, written by the node.
- The directory holding them should not be readable by other users.
