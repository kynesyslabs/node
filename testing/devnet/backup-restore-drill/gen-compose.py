#!/usr/bin/env python3
"""Compose file for the backup / wipe / restore drill. Called by run.sh once
the inputs (identities, genesis, peerlist, l2ps copy) exist.

Unlike quorum-drills/gen-inputs.py (tmpfs postgres and tmpfs node state) this
file has what a wipe and restore need to be real:

- one postgres per node, data in a named volume, so a node's database can be
  wiped on its own;
- the node state dir /app/state in a named volume, holding the identity and
  the signing state (<identity>.signed.json, .commitlock.json, .prevote.json),
  so it outlives the container;
- a `node-iso` + `pg-iso` pair for VARIANT=isolated: no identity mounted, not
  in the genesis validator set. Services are always started by name, never
  with a bare `up`.

Everything else follows quorum-drills: same node environment, memory caps,
no container_name, restart policy, generated genesis. Ports are published on
127.0.0.1 only, from BASE_PORT. It is written as JSON, which docker compose
reads as YAML.
"""
import argparse
import json
import os

ap = argparse.ArgumentParser()
ap.add_argument("--run-dir", required=True)
ap.add_argument("--nodes", type=int, required=True)
ap.add_argument("--image", required=True)
ap.add_argument("--pg-image", required=True)
ap.add_argument("--node-mem", required=True)
ap.add_argument("--pg-mem", required=True)
ap.add_argument("--consensus-time", required=True)
ap.add_argument("--base-port", type=int, required=True)
ap.add_argument("--cpu-shares", type=int, required=True)
ap.add_argument("--x-node", type=int, required=True)
ap.add_argument("--migrate-cmd", required=True)
a = ap.parse_args()

inputs = os.path.join(a.run_dir, "inputs")
n = a.nodes


def port(i):
    # Same numbering as quorum-drills: the genesis connection_url holds it
    return 53549 + 2 * i


ISO_PORT = port(n + 1)

# Identity into the state volume only when it is not there yet: a wiped and
# restored node keeps the identity (and signing state) already on the volume.
# The image's own entrypoint is replaced, as in quorum-drills; the devnet
# image ships ./testing/devnet/run-devnet, the release image does not and
# starts the node directly, with bun as PID 1.
START_SCRIPT = (
    "set -e; mkdir -p /app/state; "
    "if [ -f /app/keys/node.identity ] && [ ! -f /app/state/node.identity ]; then "
    "cp /app/keys/node.identity /app/state/node.identity && chmod 600 /app/state/node.identity; fi; "
    "if [ -x ./testing/devnet/run-devnet ]; then exec ./testing/devnet/run-devnet < /dev/null; fi; "
    "exec bun -r tsconfig-paths/register src/index.ts -- --no-tui < /dev/null"
)

node_env = {
    "NODE_ENV": "development",
    "LOG_LEVEL": "info",
    "L2PS_HASH_RELAY_NON_PROD": "true",
    "PG_PORT": "5432",
    "PG_USER": "demosuser",
    "PG_PASSWORD": "demospass",
    "CONSENSUS_TIME": str(a.consensus_time),
    "OMNI_MODE": "HTTP_ONLY",
    "TLSNOTARY_ENABLED": "false",
    "GOSSIP_ENABLED": "true" if os.environ.get("GOSSIP_ENABLED") == "true" else "false",
    "IDENTITY_FILE": "/app/state/node.identity",
    "PEER_LIST_FILE": "demos_peerlist.json",
}

volumes_decl = {}
services = {}


def postgres(name, db, extra_volumes=()):
    volumes_decl[f"pgdata-{name}"] = {}
    for v in extra_volumes:
        volumes_decl[v.split(":")[0]] = {}
    services[f"pg-{name}"] = {
        "image": a.pg_image,
        "mem_limit": a.pg_mem,
        "memswap_limit": a.pg_mem,
        "cpu_shares": a.cpu_shares,
        "restart": "no",
        "environment": {
            "POSTGRES_USER": "demosuser",
            "POSTGRES_PASSWORD": "demospass",
            "POSTGRES_DB": db,
        },
        "volumes": [f"pgdata-{name}:/var/lib/postgresql/data", *extra_volumes],
        "healthcheck": {
            # TCP on 127.0.0.1: the temporary server of the image's init step
            # only listens on the unix socket, so this is green only for the real one
            "test": ["CMD-SHELL", f"pg_isready -h 127.0.0.1 -U demosuser -d {db}"],
            "interval": "2s",
            "timeout": "5s",
            "retries": 30,
        },
        "labels": {"demos.drill": "backup-restore"},
        "networks": ["drillnet"],
    }


def node(name, i, rpc_port, host_port, db, with_identity):
    volumes_decl[f"state-{name}"] = {}
    vols = [
        f"{inputs}/peerlist.json:/app/demos_peerlist.json:ro",
        f"{inputs}/genesis.json:/app/data/genesis.json:ro",
        f"{inputs}/empty-snapshot:/app/data/snapshot:ro",
        f"{inputs}/l2ps:/app/data/l2ps:ro",
        f"state-{name}:/app/state",
    ]
    if with_identity:
        vols.insert(0, f"{inputs}/node{i}.identity:/app/keys/node.identity:ro")
    services[f"node-{name}"] = {
        "image": a.image,
        "entrypoint": ["bash", "-lc", START_SCRIPT],
        "mem_limit": a.node_mem,
        "memswap_limit": a.node_mem,
        "cpu_shares": a.cpu_shares,
        # As in quorum-drills: a node that cannot pair with the anchor at a
        # cold boot exits 0 and is restarted until the mesh forms. The drill
        # stops a node with `docker compose stop`, which this policy respects.
        "restart": "unless-stopped",
        "hostname": f"node{name}-host",
        "depends_on": {f"pg-{name}": {"condition": "service_healthy"}},
        "environment": {
            **node_env,
            "PG_HOST": f"pg-{name}",
            "PG_DATABASE": db,
            "PORT": str(rpc_port),
            "RPC_PORT": str(rpc_port),
            "OMNI_PORT": str(rpc_port + 1),
            "EXPOSED_URL": f"http://node-{name}:{rpc_port}",
        },
        "volumes": vols,
        "ports": [f"127.0.0.1:{host_port}:{rpc_port}"],
        "labels": {"demos.drill": "backup-restore"},
        "networks": ["drillnet"],
    }


for i in range(1, n + 1):
    # The backup staging volume exists on the node being drilled only: it is
    # "the node's own volume" the dump and the state copy are written to
    extra = [f"backup-{i}:/backup"] if i == a.x_node else []
    postgres(str(i), f"node{i}_db", extra)
    node(str(i), i, port(i), a.base_port + i, f"node{i}_db", True)

# The isolated, non-signing node of VARIANT=isolated: no identity, not in the
# genesis validator set, its own database and state volume
postgres("iso", "nodeiso_db")
node("iso", n + 1, ISO_PORT, a.base_port + n + 1, "nodeiso_db", False)

# One-off container for applying migrations by hand (docs/runbooks/database-
# migrations.md): no identity, no ports. run.sh points it at one database
# with `compose run -e PG_HOST=... -e PG_DATABASE=...`
services["migrate"] = {
    "image": a.image,
    "entrypoint": ["bash", "-lc", a.migrate_cmd],
    "mem_limit": a.node_mem,
    "memswap_limit": a.node_mem,
    "cpu_shares": a.cpu_shares,
    "restart": "no",
    "environment": {**node_env, "PG_HOST": "pg-1", "PG_DATABASE": "node1_db"},
    "labels": {"demos.drill": "backup-restore"},
    "networks": ["drillnet"],
}

compose = {
    "services": services,
    "networks": {"drillnet": {"driver": "bridge"}},
    "volumes": volumes_decl,
}
json.dump(compose, open(f"{a.run_dir}/compose.yml", "w"), indent=2)
print(f"compose with {n} nodes + 1 isolated node, one postgres each, node {a.x_node} is the drilled one")
