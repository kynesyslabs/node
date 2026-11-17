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

    drill_inputs.py launch-forks --template FILE   (genesis JSON on stdin)
prints the genesis with its `forks` replaced by the launch set of the
mainnet genesis template (docs/mainnet/genesis.template.json): active at 0
where the template says the number 0, off for null and "FILL: ...", and off
for the forks in LAUNCH_EXCLUDED_FORKS (see with_launch_forks).

    drill_inputs.py launch-excluded --template FILE
prints the excluded forks the template activates at 0 as a JSON object of
name -> reason ({} when there are none).

    drill_inputs.py readable --dir DIR
sets every file under DIR to 644 and every directory to 755 (run.sh and
../consensus-race/run.sh, once all their inputs are written).

    drill_inputs.py tmpfs [--uid UID --gid GID]
prints the node tmpfs entries, one per line, exactly as gen-inputs.py writes
them into the compose file (run.sh passes the same strings to `docker run
--tmpfs` in its preflight check). Without the two: root-owned, see
node_tmpfs_specs.

    drill_inputs.py pgconn --nodes N
prints "NEEDED CONFIGURED": the fewest max_connections an N-node drill can run
on, and the value gen-inputs.py starts the shared postgres with (run.sh refuses
a postgres below the first).

    drill_inputs.py hosts --file FILE --nodes N
reads a hosts file (one `user@ip [max_nodes]` per line, see parse_hosts) and
prints one tab-separated line per host: index (1-based), user@ip, ip, max_nodes
(0 = no limit) and the comma-separated nodes assigned to it (assign_nodes).
Exit 2 with the reason on a malformed file or too little capacity.
"""
import argparse
import json
import os
import re
import sys

EMPTY_SNAPSHOT = "empty-snapshot"

# Every tmpfs a drill node writes to as the image user. /app/state holds the
# identity copy, its lock, the signing record and the commit lock. The other
# paths the node writes (/app, /app/data, /app/logs) are image directories the
# Dockerfile already chowns to that user.
NODE_TMPFS_PATHS = ["/app/state"]

# Postgres connections. A node opens them from one place: the TypeORM DataSource
# (`dataSource` in src/model/datasource.ts), which sets no pool `max`, so pg-pool's
# default of 10 applies (`this.options.max` in node_modules/pg-pool/index.js, typeorm
# passes `max: options.poolSize` in createPool of
# node_modules/typeorm/driver/postgres/PostgresDriver.js). Nothing else in src/ holds a
# connection while a node runs (README, "Postgres connections").
PG_POOL_PER_NODE = 10
# What is not a node: the superuser_reserved_connections (3, counted inside
# max_connections), run.sh's psql reads (one at a time), the healthcheck's
# pg_isready every 2 s, and slack
PG_FIXED = 20


def pg_connections_needed(n):
    """Fewest max_connections an n-node drill can run on: every pool full."""
    return PG_POOL_PER_NODE * n + PG_FIXED


def pg_max_connections(n):
    """max_connections the shared postgres is started with for n nodes.

    Twice the pools: a node stopped with `docker compose stop -t 0` is killed,
    and the server drops its 10 backends only when it sees the sockets close,
    while the restarted node (restart: unless-stopped, and a node that cannot
    pair yet exits and restarts) is already opening 10 more.
    """
    return 2 * PG_POOL_PER_NODE * n + PG_FIXED


# Up to this many nodes the shared postgres keeps the 1g cap every earlier
# scenario ran with (their generated compose stays as it was).
PG_MEM_FIXED_UP_TO = 13
# Above it: about 100 MB per node. 30 nodes keep up to 600 connections open
# (pg_max_connections), and every open backend holds a few MB of its own.
PG_MEM_PER_NODE_MB = 100


def pg_mem_limit(n):
    """mem_limit of the postgres that holds n node databases."""
    if n <= PG_MEM_FIXED_UP_TO:
        return "1g"
    return f"{PG_MEM_PER_NODE_MB * n}m"


def node_port(i):
    """RPC port of node i; its OMNI port is the next one."""
    return 53549 + 2 * i


def gossip_port(i):
    """Gossip (libp2p) port of node i in multi-host mode.

    On one host every node keeps the default 9095 inside its own container.
    Across hosts the port is published, so it must differ between the nodes
    that share a host, and the node advertises the EXPOSED_URL host with this
    port (getListenAddr in src/libs/gossip/GossipManager.ts). Kept clear of
    the RPC/OMNI range for up to 400 nodes.
    """
    return 54549 + i


_HOST_RE = re.compile(r"^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+)$")


def parse_hosts(text):
    """Hosts of a --hosts file: [{"ssh": "user@ip", "ip": ip, "max": int or 0}].

    One host per line, `user@ip [max_nodes]`; blank lines and `#` comments are
    skipped. max_nodes is a positive integer, absent means no limit (0). The
    same ip twice is refused: both entries would run the same compose project
    on one Docker daemon.
    """
    hosts = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        m = _HOST_RE.match(parts[0])
        if not m or len(parts) > 2:
            raise ValueError(f"line {lineno}: expected `user@ip [max_nodes]`, got {raw.strip()!r}")
        cap = 0
        if len(parts) == 2:
            if not re.fullmatch(r"[1-9][0-9]*", parts[1]):
                raise ValueError(f"line {lineno}: max_nodes must be a positive integer, got {parts[1]!r}")
            cap = int(parts[1])
        if any(h["ip"] == m.group(1) for h in hosts):
            raise ValueError(f"line {lineno}: {m.group(1)} is listed twice")
        hosts.append({"ssh": parts[0], "ip": m.group(1), "max": cap})
    if not hosts:
        raise ValueError("no hosts in the file")
    return hosts


def assign_nodes(hosts, n):
    """Host index (0-based) of nodes 1..n, as a list: round-robin over the
    hosts, skipping a host once it holds its max_nodes. Node 1, the seed of
    the peerlist, always lands on the first host."""
    total = sum(h["max"] for h in hosts) if all(h["max"] for h in hosts) else None
    if total is not None and total < n:
        raise ValueError(f"the hosts take at most {total} nodes, {n} are needed")
    load = [0] * len(hosts)
    out = []
    k = 0
    for _ in range(n):
        while hosts[k]["max"] and load[k] >= hosts[k]["max"]:
            k = (k + 1) % len(hosts)
        out.append(k)
        load[k] += 1
        k = (k + 1) % len(hosts)
    return out


def host_plan(hosts, n):
    """[{"index": 1-based, "ssh", "ip", "max", "nodes": [node ids]}] for n nodes."""
    where = assign_nodes(hosts, n)
    return [
        {"index": k + 1, **h, "nodes": [i + 1 for i, hk in enumerate(where) if hk == k]}
        for k, h in enumerate(hosts)
    ]


def with_genesis_timestamp(genesis, ts):
    """Copy of `genesis` with its timestamp set to `ts` (unix seconds, int)."""
    out = dict(genesis)
    out["timestamp"] = ts
    return out


# What the mainnet-shape drills need active to mean what they say: the bound
# committee and the lock on top of it (loadForkConfig.ts refuses commitLock
# without committeeBinding). A template that drops one is an error, not a drill
# that silently runs something else.
DRILL_REQUIRED_FORKS = ("quorumParity", "committeeBinding", "commitLock")
# gasFeeSeparation validates a treasury even when it is off (loadForkConfig.ts)
OFF_TREASURY = "0x" + "0" * 64
# Active, the zero address is the burn account and the node refuses to boot on
# it, so a genesis without a treasury of its own, or with that one, gets this
# drill-only account.
DRILL_TREASURY = "0x" + "7d" * 32
# Active, tlsnVerified needs its notary keys and verifier pin (loadForkConfig.ts
# refuses it without them), so a genesis without a payload of its own gets the
# devnet one: the keys of testing/devnet/genesis.devnet.json, test material only.
DRILL_TLSN_VERIFIED = {
    "notaryKeys": [
        {"id": "devnet-test-notary-1", "alg": "k256", "hex": "024a6fdca826ecf9f2e89584bdc4cae0d865019aefb625040fe55174507693c15e"},
        {"id": "devnet-test-notary-2", "alg": "k256", "hex": "030a8177a685c7f3c5aac81689a2e8011284b53843d91dda3113bfac99b9195870"},
    ],
    "verifierWasmSha256": "5ed9774dd485266227b633504beba4cb3bed47c26af01b817ed128ce8517e455",
    "maxPresentationBytes": 65536,
    "freshnessWindowSec": 3600,
    "futureSkewSec": 60,
}

# Forks the template activates at 0 that the drills keep off, by name, each with
# the reason. The drills mount an empty data/snapshot, so genesis takes the legacy
# path; a fork that needs a snapshot has to be listed here, or a node with it
# active at 0 refuses to boot (restoreGenesisState in
# src/libs/blockchain/genesis/restoreGenesisState.ts; the `refuse` calls around
# importedIdentityProblems and freshGenesisProblems in
# src/libs/blockchain/routines/findGenesisBlock.ts) and the drill ends as
# "node-N did not serve" (exit 2).
LAUNCH_EXCLUDED_FORKS = {
    "identityCarryover": "needs a genesis snapshot; the drills use the legacy genesis path",
}


def _active_at_zero(entry):
    h = entry.get("activationHeight") if isinstance(entry, dict) else None
    return type(h) is int and h == 0


def launch_fork_heights(template):
    """Fork name -> 0 or None, from a mainnet genesis template's `forks`.

    A fork is active at 0 only where the template's activationHeight is the
    number 0. null, a "FILL: ..." placeholder and anything else stay off, and
    so does every fork in LAUNCH_EXCLUDED_FORKS, whatever the template says
    (it is in the result as None even when the template does not list it).
    """
    forks = template.get("forks")
    if not isinstance(forks, dict) or not forks:
        raise ValueError("the genesis template has no forks object")
    heights = {name: 0 if _active_at_zero(entry) else None for name, entry in forks.items()}
    for name in LAUNCH_EXCLUDED_FORKS:
        heights[name] = None
    missing = [n for n in DRILL_REQUIRED_FORKS if heights.get(n) != 0]
    if missing:
        raise ValueError(f"the genesis template does not activate {', '.join(missing)} at 0, which the drill needs")
    return heights


def launch_excluded(template):
    """Name -> reason, for the excluded forks the template activates at 0.

    Those are the forks the drills took out of the template's launch set.
    """
    launch_fork_heights(template)  # the same checks on the template
    forks = template["forks"]
    return {n: why for n, why in LAUNCH_EXCLUDED_FORKS.items() if _active_at_zero(forks.get(n))}


def excluded_text(excluded):
    """'a (why), b (why)', or 'none', for a launch_excluded result."""
    return ", ".join(f"{n} ({why})" for n, why in excluded.items()) or "none"


def with_launch_forks(genesis, template):
    """Copy of `genesis` whose forks are the template's launch set.

    The whole `forks` object is replaced, so no fork keeps a height the
    template does not give it, and no fork is left to the node's own default
    (osDenomination, nonceEnforcement and gasFeeSeparation default to 0).
    Payload fields (gasFeeSeparation's treasuryAddress, tlsnVerified's notary
    keys) are kept from the genesis' own entry, or filled with ones the node
    accepts. Excluded forks (LAUNCH_EXCLUDED_FORKS) get an explicit
    `activationHeight: null`.
    """
    own = genesis.get("forks") or {}
    forks = {}
    for name, height in launch_fork_heights(template).items():
        entry = {k: v for k, v in own.get(name, {}).items() if k not in ("activationHeight", "description")}
        if name == "gasFeeSeparation":
            if height is None:
                entry.setdefault("treasuryAddress", OFF_TREASURY)
            elif entry.get("treasuryAddress", OFF_TREASURY) == OFF_TREASURY:
                entry["treasuryAddress"] = DRILL_TREASURY
        if name == "tlsnVerified" and height is not None and "notaryKeys" not in entry:
            entry = {**DRILL_TLSN_VERIFIED, **entry}
        forks[name] = {"activationHeight": height, **entry}
    out = dict(genesis)
    out["forks"] = forks
    return out


def fork_set_text(forks, excluded=None):
    """'a@0, b@0 | off: c, d' for a forks object of {name: {activationHeight}}.

    With `excluded` (a launch_excluded result) it ends in ' | excluded: x (why)'.
    """
    on = [n for n, f in forks.items() if f.get("activationHeight") == 0]
    off = [n for n, f in forks.items() if f.get("activationHeight") != 0]
    text = f"{', '.join(f'{n}@0' for n in on)} | off: {', '.join(off) or 'none'}"
    if excluded is not None:
        text += f" | excluded: {excluded_text(excluded)}"
    return text


def seed_peerlist(pubs, node1_port):
    """Peerlist body that seeds node-1 only."""
    return {pubs[0]: f"http://node-1:{node1_port}"}


def make_empty_snapshot(inputs_dir):
    """Creates (if missing) the empty directory to mount over data/snapshot."""
    path = os.path.join(inputs_dir, EMPTY_SNAPSHOT)
    os.makedirs(path, exist_ok=True)
    os.chmod(path, 0o755)
    return path


def node_tmpfs_specs(uid=None, gid=None):
    """Compose `tmpfs:` entries (and `docker run --tmpfs` values) for a node.

    Docker creates a tmpfs root-owned, mode 755, so a node running as the
    image user could not write to it. uid, gid and mode are tmpfs mount
    options; the compose long syntax (`type: tmpfs`) only has size and mode,
    so the short string is the one that can set the owner. Mode 0700: the
    directory holds the identity.

    Without uid and gid: the plain paths, root-owned, as the drills mounted
    them before the owner options (callers that predate --uid/--gid). There is
    no default owner: the tmpfs must belong to the image's user, which only
    the caller can read from the image, and the host user is not it. One of
    the two alone is a ValueError.
    """
    if (uid is None) != (gid is None):
        raise ValueError("--uid and --gid go together: give both, or neither for a root-owned tmpfs")
    if uid is None:
        return list(NODE_TMPFS_PATHS)
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
    lf = sub.add_parser("launch-forks")
    lf.add_argument("--template", required=True)
    le = sub.add_parser("launch-excluded")
    le.add_argument("--template", required=True)
    tf = sub.add_parser("tmpfs")
    tf.add_argument("--uid", type=int)
    tf.add_argument("--gid", type=int)
    pc = sub.add_parser("pgconn")
    pc.add_argument("--nodes", type=int, required=True)
    hs = sub.add_parser("hosts")
    hs.add_argument("--file", required=True)
    hs.add_argument("--nodes", type=int, required=True)
    a = ap.parse_args()
    if a.cmd == "hosts":
        try:
            with open(a.file) as f:
                plan = host_plan(parse_hosts(f.read()), a.nodes)
        except (OSError, ValueError) as e:
            hs.error(f"{a.file}: {e}")
        for h in plan:
            print("\t".join([str(h["index"]), h["ssh"], h["ip"], str(h["max"]), ",".join(map(str, h["nodes"]))]))
        return
    if a.cmd == "readable":
        make_readable(a.dir)
        return
    if a.cmd == "tmpfs":
        try:
            print("\n".join(node_tmpfs_specs(a.uid, a.gid)))
        except ValueError as e:
            tf.error(str(e))
        return
    if a.cmd == "pgconn":
        print(pg_connections_needed(a.nodes), pg_max_connections(a.nodes))
        return
    if a.cmd == "launch-forks":
        with open(a.template) as f:
            json.dump(with_launch_forks(json.load(sys.stdin), json.load(f)), sys.stdout)
        return
    if a.cmd == "launch-excluded":
        with open(a.template) as f:
            json.dump(launch_excluded(json.load(f)), sys.stdout)
        return
    with open(a.genesis) as f:
        genesis = json.load(f)
    stage(genesis, a.pub, a.node1_port, a.genesis_ts, a.out_dir)


if __name__ == "__main__":
    main()
