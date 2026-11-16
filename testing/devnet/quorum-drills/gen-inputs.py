#!/usr/bin/env python3
"""Per-run inputs for an N-validator drill: genesis, peerlist, postgres init
and the compose file. Called by run.sh once the identities exist.

The compose file follows testing/devnet/consensus-race/docker-compose.race.yml
(same node environment, tmpfs state, memory caps, no published ports, no
container_name, no named volumes) with the services generated for N nodes.
It is written as JSON, which docker compose reads as YAML.
"""
import argparse
import json
import os

from drill_inputs import (
    fork_set_text,
    launch_excluded,
    make_empty_snapshot,
    node_tmpfs_specs,
    pg_max_connections,
    seed_peerlist,
    with_genesis_timestamp,
    with_launch_forks,
    write_json,
)

ap = argparse.ArgumentParser()
ap.add_argument("--run-dir", required=True)
ap.add_argument("--repo", required=True)
ap.add_argument("--nodes", type=int, required=True)
ap.add_argument("--shard-size", type=int, required=True)
ap.add_argument("--binding", choices=["on", "off"], required=True)
ap.add_argument("--genesis-ts", type=int, required=True)
ap.add_argument("--image", required=True)
# "devnet": the forks of testing/devnet/genesis.devnet.json, with quorumParity
# and committeeBinding set below (every scenario before the mainnet-shape
# drills). "launch": the fork set of docs/mainnet/genesis.template.json, read
# from the repo at run time.
ap.add_argument("--fork-set", choices=["devnet", "launch"], default="devnet")
# The image's user, read from the image by run.sh: the node tmpfs is mounted
# owned by it. Both or neither: without them the tmpfs is the root-owned
# /app/state of the compose files before #1122 (see node_tmpfs_specs)
ap.add_argument("--uid", type=int)
ap.add_argument("--gid", type=int)
ap.add_argument("--src", default="")
ap.add_argument("--node-mem", required=True)
ap.add_argument("--consensus-time", required=True)
# How a node starts, chosen by run.sh from the image: "run-devnet" execs
# testing/devnet/run-devnet (a devnet-style image carries it); "image" runs the
# image's own ENTRYPOINT and CMD, which a release image needs because it has no
# testing/. The two JSON lists are the image's Config.Entrypoint and Config.Cmd.
ap.add_argument("--start", choices=["run-devnet", "image"], default="run-devnet")
ap.add_argument("--image-entrypoint", default="[]")
ap.add_argument("--image-cmd", default="[]")
a = ap.parse_args()
image_entrypoint = json.loads(a.image_entrypoint) or []
image_cmd = json.loads(a.image_cmd) or []
if a.start == "image" and not (image_entrypoint or image_cmd):
    ap.error("--start image needs the image's entrypoint or cmd")
if a.fork_set == "launch" and a.binding != "on":
    ap.error("--fork-set launch activates committeeBinding (and commitLock needs it): --binding must be on")
try:
    node_tmpfs = node_tmpfs_specs(a.uid, a.gid)
except ValueError as e:
    ap.error(str(e))

inputs = os.path.join(a.run_dir, "inputs")
n = a.nodes


def port(i):
    return 53549 + 2 * i


pubs = [open(f"{inputs}/pub{i}").read().strip() for i in range(1, n + 1)]

g = json.load(open(f"{a.repo}/testing/devnet/genesis.devnet.json"))
g = with_genesis_timestamp(g, a.genesis_ts)
g["properties"]["shardSize"] = a.shard_size
excluded = None
if a.fork_set == "launch":
    with open(f"{a.repo}/docs/mainnet/genesis.template.json") as f:
        template = json.load(f)
    g = with_launch_forks(g, template)
    # run.sh logs these and records them in the verdict
    excluded = launch_excluded(template)
    write_json(f"{inputs}/launch-excluded.json", excluded)
else:
    forks = g.setdefault("forks", {})
    forks["quorumParity"] = {"activationHeight": 0}
    # "off" keeps the fork dormant, to reproduce the pre-fork behaviour on the
    # same code
    forks["committeeBinding"] = {"activationHeight": 0 if a.binding == "on" else None}
stake = "1000000000000000000"
g["validators"] = [
    {
        "address": pk,
        "status": "2",
        "connection_url": f"http://node-{i + 1}:{port(i + 1)}",
        "staked_amount": stake,
        "first_seen": 0,
        "valid_at": 0,
    }
    for i, pk in enumerate(pubs)
]
others = [b for b in g.get("balances", []) if b[0] not in set(pubs)]
g["balances"] = [[pk, stake] for pk in pubs] + others
write_json(f"{inputs}/genesis.json", g)

write_json(f"{inputs}/peerlist.json", seed_peerlist(pubs, port(1)))
make_empty_snapshot(inputs)

pg_init = os.path.join(inputs, "pg-init")
os.makedirs(pg_init, exist_ok=True)
os.chmod(pg_init, 0o755)
with open(f"{pg_init}/init.sql", "w") as f:
    for i in range(1, n + 1):
        f.write(f"CREATE DATABASE node{i}_db;\n")
        f.write(f"GRANT ALL PRIVILEGES ON DATABASE node{i}_db TO demosuser;\n")
os.chmod(f"{pg_init}/init.sql", 0o644)

devnet = os.path.join(a.repo, "testing/devnet")
node_env = {
    "NODE_ENV": "development",
    "LOG_LEVEL": "info",
    "L2PS_HASH_RELAY_NON_PROD": "true",
    "PG_HOST": "postgres",
    "PG_PORT": "5432",
    "PG_USER": "demosuser",
    "PG_PASSWORD": "demospass",
    "CONSENSUS_TIME": str(a.consensus_time),
    "OMNI_MODE": "HTTP_ONLY",
    "TLSNOTARY_ENABLED": "false",
    # Off by default, as in the race harness: the sidecar's node runtime in
    # a devnet-style image is Bun's fallback wrapper. GOSSIP_ENABLED=true runs
    # the production default, where heights ahead of ours arrive as gossip;
    # run.sh forces it on for the halt and ride drills.
    "GOSSIP_ENABLED": "true" if os.environ.get("GOSSIP_ENABLED") == "true" else "false",
    "IDENTITY_FILE": "/app/state/node.identity",
}

services = {
    "postgres": {
        "image": "postgres:16-alpine",
        # Every node has its own database on this one server, and each node
        # opens up to 10 connections (a TypeORM pool with no `max`); real
        # validators have a database each. The default max_connections of 100
        # ran out at 13 nodes (13 x 10 = 130), as "too many clients already".
        # M = 2 x 10 x N + 20: twice the pools, because a killed node's
        # backends outlive it briefly while its restart opens new ones, plus 20
        # for the 3 reserved superuser slots, the harness' psql reads and the
        # healthcheck (drill_inputs.pg_max_connections). N=4: 100, 10: 220, 13: 280.
        # It reserves no memory by itself: shared_buffers stays 128MB (it must
        # be at least 16kB x M, 4.4MB at 280) and a backend costs memory only
        # while it is open, so the 1g limit is unchanged.
        "command": ["postgres", "-c", f"max_connections={pg_max_connections(n)}"],
        "mem_limit": "1g",
        "memswap_limit": "1g",
        "restart": "no",
        "environment": {
            "POSTGRES_USER": "demosuser",
            "POSTGRES_PASSWORD": "demospass",
            "POSTGRES_DB": "postgres",
        },
        "tmpfs": ["/var/lib/postgresql/data"],
        "volumes": [f"{pg_init}:/docker-entrypoint-initdb.d:ro"],
        "healthcheck": {
            "test": ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U demosuser -d postgres"],
            "interval": "2s",
            "timeout": "5s",
            "retries": 30,
        },
        "networks": ["drillnet"],
    }
}
# The image's own entrypoint (bridge_file in scripts/docker-entrypoint.sh) moves a real
# file it finds at /app/demos_peerlist.json into /app/state; a bind mount there
# cannot be moved, and `set -e` ends the container. So on the image path the
# peerlist is mounted elsewhere and copied into /app/state, where the
# entrypoint's own symlink at /app/demos_peerlist.json (the default
# PEER_LIST_FILE) finds it, as an operator's state volume would hold it.
peerlist_mount = "/app/demos_peerlist.json" if a.start == "run-devnet" else "/app/keys/demos_peerlist.json"
# The node's identity lock and signing record sit next to IDENTITY_FILE
# (identityLock.ts:68, signingRecord.ts:205), so the key is copied into the
# uid-owned tmpfs state dir; /app/keys is read-only. The copy runs at every
# container start: a stopped container's tmpfs is empty when it starts again.
copy_identity = "mkdir -p /app/state && cp /app/keys/node.identity /app/state/node.identity"
for i in range(1, n + 1):
    volumes = [
        f"{inputs}/node{i}.identity:/app/keys/node.identity:ro",
        f"{inputs}/peerlist.json:{peerlist_mount}:ro",
        f"{inputs}/genesis.json:/app/data/genesis.json:ro",
        f"{inputs}/empty-snapshot:/app/data/snapshot:ro",
        f"{devnet}/l2ps:/app/data/l2ps:ro",
    ]
    if a.src:
        # Same overlay as consensus-race's docker-compose.src.yml
        volumes += [f"{a.src}/src:/app/src:ro", f"{a.src}/bunfig.toml:/app/bunfig.toml:ro"]
    if a.start == "image":
        # The image's ENTRYPOINT and CMD, unchanged, after the copies the
        # drill needs. Setting `entrypoint` in compose drops the image's CMD,
        # so both are written out; `exec "$@"` runs them as `docker run`
        # would: ENTRYPOINT first, CMD as its arguments. The tmpfs is owned
        # by the image user (see node_tmpfs_specs). No stdin redirect: a
        # container started without -i has /dev/null as stdin already. The
        # image starts the node directly, with no schema step: run.sh migrates
        # each node database in a one-off container before any node starts.
        start = {
            "entrypoint": [
                "/bin/sh",
                "-c",
                f"{copy_identity} && cp /app/keys/demos_peerlist.json /app/state/demos_peerlist.json "
                '&& exec "$@"',
                "sh",
                *image_entrypoint,
            ],
            "command": image_cmd,
        }
        # run-devnet maps its PORT variable to the node's RPC_PORT; the image
        # reads RPC_PORT (and its HEALTHCHECK probes it)
        port_env = {"RPC_PORT": str(port(i))}
    else:
        # The identity is copied into a tmpfs state dir (owned by the image
        # user, see node_tmpfs_specs) so the identity lock and signing record
        # stay inside the container. A readable stdin keeps the node from
        # exiting at boot.
        start = {
            "entrypoint": [
                "bash",
                "-lc",
                f"{copy_identity} && exec ./testing/devnet/run-devnet < /dev/null",
            ],
        }
        port_env = {"PORT": str(port(i))}
    services[f"node-{i}"] = {
        "image": a.image,
        **start,
        "mem_limit": a.node_mem,
        "memswap_limit": a.node_mem,
        # A node that cannot pair with the anchor at a cold boot exits with
        # code 0; it is restarted until the mesh forms. A drill stops a
        # validator with `docker compose stop`, which this policy respects.
        "restart": "unless-stopped",
        "tmpfs": node_tmpfs,
        "hostname": f"node{i}-host",
        "depends_on": {"postgres": {"condition": "service_healthy"}},
        "environment": {
            **node_env,
            "PG_DATABASE": f"node{i}_db",
            **port_env,
            "OMNI_PORT": str(port(i) + 1),
            "EXPOSED_URL": f"http://node-{i}:{port(i)}",
        },
        "volumes": volumes,
        "networks": ["drillnet"],
    }

compose = {"services": services, "networks": {"drillnet": {"driver": "bridge"}}}
json.dump(compose, open(f"{a.run_dir}/compose.yml", "w"), indent=2)
print(
    f"genesis shardSize {a.shard_size} validators {n} committeeBinding {a.binding}; "
    f"compose with {n} nodes"
)
if a.fork_set == "launch":
    print(f"launch fork set (docs/mainnet/genesis.template.json): {fork_set_text(g['forks'], excluded)}")
