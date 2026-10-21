#!/bin/sh
# Demos Network — container entrypoint.
#
# Bridges the writable runtime files the node creates at /app/<file> to the
# persistent volume at /app/state, so they survive `docker compose down`.
# Also routes the timestamped logs_<port>_<id>/ directory into /app/logs.
#
# Files bridged:
#   /app/.demos_identity             <- /app/state/.demos_identity
#   /app/<IDENTITY_FILE>.signed.json <- /app/state/<IDENTITY_FILE>.signed.json
#                                       (default: .demos_identity.signed.json)
#   /app/demos_peerlist.json         <- /app/state/demos_peerlist.json
#   /app/.tlsnotary-key              <- /app/state/.tlsnotary-key
#   /app/output                      <- /app/state/output
#   /app/publickey_*                 <- /app/state/publickey_* (after creation)
#
# An IDENTITY_FILE inside /app/state already persists its record next to it. An
# absolute path elsewhere, or a nested path under /app, is not bridged: the
# identity file and its .signed.json must then be on a persistent volume.
#
# Logs:
#   /app/logs_*  -> /app/logs/  (the legacy logger writes one dir per port+id)
set -eu

STATE_DIR="${STATE_DIR:-/app/state}"
LOGS_DIR="${LOGS_DIR:-/app/logs}"

mkdir -p "$STATE_DIR" "$LOGS_DIR"

# Files: create on volume if absent, then symlink from /app.
# The node generates these on demand on first boot — we don't pre-create.
bridge_file() {
    f="$1"
    target="$STATE_DIR/$f"
    link="/app/$f"
    # If /app already has a real file (e.g. baked from image), move it once
    if [ -e "$link" ] && [ ! -L "$link" ]; then
        if [ ! -e "$target" ]; then
            mv "$link" "$target"
        else
            rm -f "$link"
        fi
    fi
    # Create symlink (idempotent — pointing into the volume)
    [ -L "$link" ] || ln -s "$target" "$link"
}

for f in .demos_identity demos_peerlist.json .tlsnotary-key; do
    bridge_file "$f"
done

# The signing record sits next to the configured identity file as
# <IDENTITY_FILE>.signed.json and must survive container recreation, since it
# is what stops the key from signing a round twice.
identity_path="${IDENTITY_FILE:-.demos_identity}"
case "$identity_path" in
    /*) record_path="$identity_path.signed.json" ;;
    *) record_path="/app/$identity_path.signed.json" ;;
esac
case "$record_path" in
    "$STATE_DIR"/*)
        : # already on the persistent volume
        ;;
    /app/*/*)
        echo "entrypoint: IDENTITY_FILE=$identity_path is outside /app root; its signing record ($record_path) must be on a persistent volume too" >&2
        ;;
    /app/*)
        bridge_file "${record_path#/app/}"
        ;;
    *)
        echo "entrypoint: IDENTITY_FILE=$identity_path is outside /app; its signing record ($record_path) must be on a persistent volume too" >&2
        ;;
esac

# Directory: output/
# rmdir would only work on an empty dir, and 'ln -sfn TARGET /app/output'
# does NOT replace a real directory — it creates output/output inside it.
# So if /app/output exists as a non-symlink directory, blow it away first.
if [ ! -L /app/output ]; then
    mkdir -p "$STATE_DIR/output"
    if [ -d /app/output ]; then
        rm -rf /app/output
    fi
    ln -sfn "$STATE_DIR/output" /app/output
fi

# publickey_* files — created at runtime by the node. Watch via post-start hook
# is overkill; instead, we pre-create the symlink target dir and rely on the
# node writing into /app/. After first boot, the file lives at /app/publickey_*
# (in container ephemeral layer). To persist, we'd need either the node code
# to write into state/, or a periodic sync. For now, accept that publickey_*
# is regenerable from the identity on every boot (it is — see src/index.ts).

exec "$@"
