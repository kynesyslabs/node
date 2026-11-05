#!/usr/bin/env python3
"""The per-run drill inputs that do not depend on how the devnet is composed.

Shared by gen-inputs.py (run.sh, its own compose file) and by the rehearsal
harness (scenario 12, the stock devnet compose plus an override file), so both
stage the same thing:

  * the genesis timestamp, set in the future so every node is up before it;
  * a peerlist that seeds node-1 only: a full seed list makes a node fail hard
    on a peer that is not up yet at a cold start, and node-1 hands out the rest;
  * an empty directory to mount over /app/data/snapshot: the image carries the
    testnet snapshot, whose 35 validators win over the genesis `validators`.

CLI (used by the rehearsal harness):
    drill_inputs.py stage --genesis FILE --pub PUB [--pub PUB ...] \
        --node1-port PORT --genesis-ts TS --out-dir DIR
reads the genesis FILE and writes genesis.json, peerlist.json and an empty
empty-snapshot/ into DIR, readable by any uid (see make_readable).

    drill_inputs.py readable --dir DIR
sets every file under DIR to 644 and every directory to 755 (run.sh, once all
its inputs are written).

    drill_inputs.py tmpfs --uid UID --gid GID
prints the node tmpfs entries, one per line, exactly as gen-inputs.py writes
them into the compose file (run.sh passes the same strings to `docker run
--tmpfs` in its preflight check).
"""
import argparse
import json
import os

EMPTY_SNAPSHOT = "empty-snapshot"

# Every tmpfs a drill node writes to as the image user. /app/state holds the
# identity copy, its lock, the signing record and the commit lock. The other
# paths the node writes (/app, /app/data, /app/logs) are image directories the
# Dockerfile already chowns to that user.
NODE_TMPFS_PATHS = ["/app/state"]


def with_genesis_timestamp(genesis, ts):
    """Copy of `genesis` with its timestamp set to `ts` (unix seconds, int)."""
    out = dict(genesis)
    out["timestamp"] = ts
    return out


def seed_peerlist(pubs, node1_port):
    """Peerlist body that seeds node-1 only."""
    return {pubs[0]: f"http://node-1:{node1_port}"}


def make_empty_snapshot(inputs_dir):
    """Creates (if missing) the empty directory to mount over data/snapshot."""
    path = os.path.join(inputs_dir, EMPTY_SNAPSHOT)
    os.makedirs(path, exist_ok=True)
    os.chmod(path, 0o755)
    return path


def node_tmpfs_specs(uid, gid):
    """Compose `tmpfs:` entries (and `docker run --tmpfs` values) for a node.

    Docker creates a tmpfs root-owned, mode 755, so a node running as the
    image user could not write to it. uid, gid and mode are tmpfs mount
    options; the compose long syntax (`type: tmpfs`) only has size and mode,
    so the short string is the one that can set the owner. Mode 0700: the
    directory holds the identity.
    """
    return [f"{p}:uid={uid},gid={gid},mode=0700" for p in NODE_TMPFS_PATHS]


def write_json(path, body):
    with open(path, "w") as f:
        json.dump(body, f, indent=2)


def make_readable(root, include_root=True):
    """Files under `root` to 644 and directories to 755, whatever the umask.

    The containers run as an image user (uid 1000 in the release image) that
    is not the host user, and bind-mounted files must be readable by it. The
    keys are throwaway devnet keys, and the directory that holds `root` is
    0700, so other host users still cannot reach them.
    """
    if include_root:
        os.chmod(root, 0o755)
    for dirpath, dirnames, filenames in os.walk(root):
        for d in dirnames:
            os.chmod(os.path.join(dirpath, d), 0o755)
        for f in filenames:
            os.chmod(os.path.join(dirpath, f), 0o644)


def stage(genesis, pubs, node1_port, genesis_ts, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    write_json(os.path.join(out_dir, "genesis.json"), with_genesis_timestamp(genesis, genesis_ts))
    write_json(os.path.join(out_dir, "peerlist.json"), seed_peerlist(pubs, node1_port))
    make_empty_snapshot(out_dir)
    # The staging dir itself keeps the mode its creator gave it (0700 from mkdtemp)
    make_readable(out_dir, include_root=False)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stage")
    st.add_argument("--genesis", required=True)
    st.add_argument("--pub", action="append", required=True)
    st.add_argument("--node1-port", required=True)
    st.add_argument("--genesis-ts", type=int, required=True)
    st.add_argument("--out-dir", required=True)
    rd = sub.add_parser("readable")
    rd.add_argument("--dir", required=True)
    tf = sub.add_parser("tmpfs")
    tf.add_argument("--uid", type=int, required=True)
    tf.add_argument("--gid", type=int, required=True)
    a = ap.parse_args()
    if a.cmd == "readable":
        make_readable(a.dir)
        return
    if a.cmd == "tmpfs":
        print("\n".join(node_tmpfs_specs(a.uid, a.gid)))
        return
    with open(a.genesis) as f:
        genesis = json.load(f)
    stage(genesis, a.pub, a.node1_port, a.genesis_ts, a.out_dir)


if __name__ == "__main__":
    main()
