---
type: runbook
title: Validator Key Handling and Failover
date: 2026-10-21
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
state directory (for example a shared disk). It does not cover a copy of the
key running on an independent host: nothing in software can see that node.

Keep the record together with the identity file. Deleting it is only safe
after the chain itself was reset.

## One host signs for each key

Exactly one named host runs a validator for a given key at any time. Write the
host down next to the key's backup. Never start a second node with the same
key "just to test".

The node also holds `<identity file>.lock`. A lock left by another host stops
the node from starting, and the error names that host and pid.

## Failover to another host

1. Stop the old node and confirm it is down: no process, no container, no
   answer on its RPC port. If the machine cannot be reached, make sure it
   cannot start again (power it off or revoke its access) before going on.
2. Copy the whole state directory to the new host: the identity file and its
   `.signed.json` record. The record is what keeps the new host from signing
   a round the old one already signed.
3. Start the new node with `DEMOS_IDENTITY_TAKEOVER=true`. It replaces the old
   host's lock and logs that the identity was taken over.
4. Once it is running, remove the variable so the next start is guarded again.

## Generating and backing up the key

- Generate the key on a trusted machine, not on the validator host, and copy
  only the identity file over a secure channel.
- Keep one encrypted backup (for example age or gpg) held by a second person.
  The passphrase or key for that backup is stored separately from the backup.
- Never put the mnemonic in chat, tickets, shell history or logs.

## After a chain reset

Nothing to do. The record stores the genesis hash of the chain it belongs to.
When the node sees a different genesis it logs a warning naming both hashes,
overwrites the record and carries on. Lower heights are still refused on the
same chain.

## Expected file modes

- Identity file: `600`. The node tightens it on start if group or other bits
  are set, and logs a warning when it does. If it cannot (read-only mount,
  other owner) it still starts, so fix the mode on the host.
- Signing record: `600`, written by the node.
- The directory holding them should not be readable by other users.
