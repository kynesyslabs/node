# Hosts for multi-host quorum drills

`run.sh --hosts FILE` runs the drill's nodes on the hosts listed in `FILE`
and drives them from the machine it is started on (the controller). See
README.md, [Several hosts](README.md#several-hosts), for what the run does.

## Hosts file

One host per line, `user@ip [max_nodes]`; blank lines and `#` comments are
skipped. `ip` is the address the other hosts and the controller reach the
host at (it goes into every node's `EXPOSED_URL`). `max_nodes` caps the nodes
the host gets; without it the host takes its round-robin share.

```
# 30 nodes: 8 + 8 + 7 + 7
demos@203.0.113.10
demos@203.0.113.11
demos@203.0.113.12
demos@203.0.113.13
```

Node 1 always goes to the first host. Check the plan without touching any
host:

```
python3 testing/devnet/quorum-drills/drill_inputs.py hosts --file hosts.txt --nodes 30
```

## Each host

- **OS:** Ubuntu 24.04 LTS, x86_64.
- **Sizing:** per node it runs, 1.6 GB of available RAM (the node and its
  share of postgres; `NODE_EST_MB`), plus 3 GB headroom (`HEADROOM_MB`), and
  10 GB free on `/`. 8 nodes: 16 GB RAM and 4+ vCPUs. Node and postgres state
  are tmpfs, so they count as RAM, not disk.
- **Docker** Engine with the compose plugin (v2), usable by the ssh user
  without sudo (member of the `docker` group). The host pulls the node image
  itself (`--image REF@sha256:<digest>`), so it must reach the registry, and
  be logged in to it if it is private (`docker login ghcr.io`).
- **ssh:** key authentication for `user@ip` from the controller, no password
  or passphrase prompt (`run.sh` uses `BatchMode=yes`); the host key already
  in the controller's `known_hosts` (connect once by hand).
- **Ports** open from the other hosts and the controller, TCP, for node i:
  RPC 53549 + 2i, OMNI 53550 + 2i, gossip 54549 + i. For 30 nodes that is
  53551-53610 and 54550-54579. Nothing else needs to be reachable; postgres
  is not published.
- **Clock:** NTP-synced (chrony). The harness reads node logs with
  `docker logs --since <controller time>` and judges restarts by timestamps.
- **netem (optional):** `--netem` needs root or passwordless sudo for `tc`
  (`sudo -n tc ...`). A host without it is skipped with a warning.
- **Nothing else running** a `qdrill-` or `crace-` stack: the preflight refuses
  a host that has one.

`prepare-host.sh` sets up a fresh Ubuntu 24.04 host for this (Docker from
Docker's apt repository, the compose plugin, chrony, iproute2, the `docker`
group, inotify/socket/file sysctls, open-file limits, and optionally the ufw
rules for the port range). It is idempotent; run it as root on the host:

```
scp testing/devnet/quorum-drills/prepare-host.sh root@203.0.113.10:
ssh root@203.0.113.10 'bash prepare-host.sh --user demos --nodes 30 --allow-from 198.51.100.7'
```

`--nodes` is the highest node index the host may run (it sizes the ufw
rules); `--allow-from` (repeatable) is a controller or peer host address the
ports are opened to. Without `--allow-from` the firewall is left as it is.

## Controller

bash, python3, jq, curl, ssh, tar, and bun (identities and the judges run
there). It needs no Docker. It reaches every host's node ports directly, so it
must be one of the `--allow-from` addresses.

## What a run leaves on a host

Nothing once it ends: the teardown removes the containers, the network, the
tc qdisc and `~/qdrill-runs/<run id>` (it holds the run's devnet keys) on
every host, also on a failure or Ctrl-C. A controller killed with SIGKILL
cannot run the teardown; then on each host:

```
docker ps -a --filter name=qdrill- -q | xargs -r docker rm -f
docker network ls --filter name=qdrill- -q | xargs -r docker network rm
rm -rf ~/qdrill-runs/<run id>
```
