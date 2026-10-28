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

ap = argparse.ArgumentParser()
ap.add_argument("--run-dir", required=True)
ap.add_argument("--repo", required=True)
ap.add_argument("--nodes", type=int, required=True)
ap.add_argument("--shard-size", type=int, required=True)
ap.add_argument("--binding", choices=["on", "off"], required=True)
ap.add_argument("--genesis-ts", type=int, required=True)
ap.add_argument("--image", required=True)
ap.add_argument("--src", default="")
ap.add_argument("--node-mem", required=True)
ap.add_argument("--consensus-time", required=True)
a = ap.parse_args()

inputs = os.path.join(a.run_dir, "inputs")
n = a.nodes


def port(i):
    return 53549 + 2 * i


pubs = [open(f"{inputs}/pub{i}").read().strip() for i in range(1, n + 1)]

g = json.load(open(f"{a.repo}/testing/devnet/genesis.devnet.json"))
g["timestamp"] = a.genesis_ts
g["properties"]["shardSize"] = a.shard_size
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
json.dump(g, open(f"{inputs}/genesis.json", "w"), indent=2)

# Every node seeds only node-1 and learns the rest from it: a full seed list
# makes a node fail hard on a peer that is not up yet at a cold start
json.dump({pubs[0]: f"http://node-1:{port(1)}"}, open(f"{inputs}/peerlist.json", "w"), indent=2)

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
    # The gossip sidecar needs a node runtime the Bun-only image lacks
    "GOSSIP_ENABLED": "false",
    "IDENTITY_FILE": "/app/state/node.identity",
}

services = {
    "postgres": {
        "image": "postgres:16-alpine",
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
            "test": ["CMD-SHELL", "pg_isready -U demosuser -d postgres"],
            "interval": "2s",
            "timeout": "5s",
            "retries": 30,
        },
        "networks": ["drillnet"],
    }
}
for i in range(1, n + 1):
    volumes = [
        f"{inputs}/node{i}.identity:/app/keys/node.identity:ro",
        f"{inputs}/peerlist.json:/app/demos_peerlist.json:ro",
        f"{inputs}/genesis.json:/app/data/genesis.json:ro",
        f"{inputs}/empty-snapshot:/app/data/snapshot:ro",
        f"{devnet}/l2ps:/app/data/l2ps:ro",
    ]
    if a.src:
        # Same overlay as consensus-race's docker-compose.src.yml
        volumes += [f"{a.src}/src:/app/src:ro", f"{a.src}/bunfig.toml:/app/bunfig.toml:ro"]
    services[f"node-{i}"] = {
        "image": a.image,
        # The identity is copied into a tmpfs state dir so the identity lock
        # and signing record stay inside the container. A readable stdin
        # keeps the node from exiting at boot.
        "entrypoint": [
            "bash",
            "-lc",
            "mkdir -p /app/state && cp /app/keys/node.identity /app/state/node.identity "
            "&& exec ./testing/devnet/run-devnet < /dev/null",
        ],
        "mem_limit": a.node_mem,
        "memswap_limit": a.node_mem,
        # A node that cannot pair with the anchor at a cold boot exits with
        # code 0; it is restarted until the mesh forms. A drill stops a
        # validator with `docker compose stop`, which this policy respects.
        "restart": "unless-stopped",
        "tmpfs": ["/app/state"],
        "hostname": f"node{i}-host",
        "depends_on": {"postgres": {"condition": "service_healthy"}},
        "environment": {
            **node_env,
            "PG_DATABASE": f"node{i}_db",
            "PORT": str(port(i)),
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
