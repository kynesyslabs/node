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
empty-snapshot/ into DIR.
"""
import argparse
import json
import os

EMPTY_SNAPSHOT = "empty-snapshot"


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


def write_json(path, body):
    with open(path, "w") as f:
        json.dump(body, f, indent=2)


def stage(genesis, pubs, node1_port, genesis_ts, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    write_json(os.path.join(out_dir, "genesis.json"), with_genesis_timestamp(genesis, genesis_ts))
    write_json(os.path.join(out_dir, "peerlist.json"), seed_peerlist(pubs, node1_port))
    make_empty_snapshot(out_dir)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stage")
    st.add_argument("--genesis", required=True)
    st.add_argument("--pub", action="append", required=True)
    st.add_argument("--node1-port", required=True)
    st.add_argument("--genesis-ts", type=int, required=True)
    st.add_argument("--out-dir", required=True)
    a = ap.parse_args()
    with open(a.genesis) as f:
        genesis = json.load(f)
    stage(genesis, a.pub, a.node1_port, a.genesis_ts, a.out_dir)


if __name__ == "__main__":
    main()
