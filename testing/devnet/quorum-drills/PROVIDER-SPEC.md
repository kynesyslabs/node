# What to rent for the 30-validator cloud drill

For `cloud-drill.sh` (README.md, [Cloud drill](README.md#cloud-drill)) on any
provider that rents Linux hosts by the hour. The only provider input is the
inventory (`inventory.example`). Every figure below is marked:

- **measured**: read off a run of the release image, with where it came from;
- **estimated**: derived from measured figures or from the harness's
  constants, with how.

Sources: the rc.13 launch rehearsal (3 validators on a 6 vCPU / 12 GB VPS,
`docker stats` and the load metrics of its drills), and a local
smoke of this harness on 2026-11-18: `cloud-drill.sh` over ssh against one
host, 4 validators, image
`ghcr.io/kynesyslabs/node:v1.0.0-rc.13@sha256:6ec7fa48...d0cc`, scenarios
`third-n4s4` and `load-n4s4` (2 TPS for 180 s), and `load-n4s4 --carryover`
(every fork of the launch genesis at block 0, 2 TPS for 120 s), sampled every
15 s. All three passed.

## Per validator

| Resource | Figure | Kind |
|---|---|---|
| Node memory | 572-653 MiB steady (rc.13 rehearsal); peak 686-839 MiB under 2 TPS load (smoke, the higher with `--carryover`) | measured |
| Postgres memory | 145-148 MiB for one database (rehearsal); 197 MiB peak for 4 databases (smoke): about 50 MiB per extra database | measured |
| Node CPU | mean 11% of a core idle, 15% at 2 TPS; peaks of 0.8-1.6 cores at boot and catch-up (smoke) | measured |
| Postgres CPU | mean 3% of a core for 4 databases, peak 14% (smoke) | measured |
| Node database | 11.7 MB after 20 blocks with 360 transfers (smoke). On tmpfs in the drills, so it counts as RAM | measured |
| Volumes | `/app/data` 66.5 MB and `/app/logs` 1.5 MB per node after a 6-minute run (anonymous, removed by `down -v`; smoke) | measured |
| Image | 616 MB to download, 2.55 GB unpacked, one copy per host | measured |
| Network, node to node | about 210 MB/h per validator (rx + tx) at 2 TPS with 4 validators; about 50 MB/h idle. The sampled figure also holds the node's postgres traffic, which stays on the host: 537 MB/h per node at 2 TPS, of which 320 MB/h is postgres | measured (4 validators) |
| Network at 30 validators | up to 10x the 4-validator figure, about 2 GB/h per validator at 2 TPS, if every block and transaction goes to every peer (29 peers instead of 3); the drill's own `resources.tsv` measures it on the first campaign | estimated |
| What the harness asks for | `NODE_EST_MB` 1600 MB available RAM per node, plus `HEADROOM_MB` 1536 per host (`cloud-drill.sh` default), 10 GB free disk (`MIN_DISK_GB`); node memory cap 1536 MB above 13 nodes | constants |

Spec per validator: **1 vCPU, 2 GB RAM, 7 GB disk** (estimated from the
above: under 1 GB of real use, room for the harness's 1.6 GB check and for
boot peaks; disk is the host's share of the image, volumes and logs). The
host adds 1.5 GB RAM and one image (2.55 GB). Throughput was not the limit
at 2 TPS; rc.6 lost liveness near 7 client TPS on a shared host, so do not
size for load above that from these numbers.

## Layouts

`q = 7` and `guaranteedTolerance(10, 30) = 3`: any committee of 10 drawn from
30 keeps 7 live members while at most 3 validators are down.

| Layout | Host | Hosts | hostloss drill | Notes |
|---|---|---|---|---|
| **10 x 3 (recommended)** | 4 vCPU, 8 GB RAM, 40 GB disk | 10 | runs: a host outage stops 3 = the tolerance, so the chain must keep forging | One postgres per host; 3 x 1.6 GB + 1.5 GB = 6.3 GB checked of 8 GB |
| 30 x 1 | 2 vCPU, 4 GB RAM, 20 GB disk | 30 | runs, but stops only 1 validator: proves less | 1.6 + 1.5 = 3.1 GB checked of 4 GB, tight on hosts that keep 0.5 GB for themselves; 30 image pulls and 30 ssh connections per step |
| 5 x 6 | 8 vCPU, 16 GB RAM, 60 GB disk | 5 | skipped: 6 down is over the tolerance, a host outage halts the chain | Cheapest to manage, least like production |

**Regions:** 3, as near-equal thirds (4 + 3 + 3 hosts for 10 x 3), listed in
the inventory alternating region by region so that consecutive validators
land in different regions (node i goes to host ((i - 1) mod H) + 1). The ping matrix in
`ping-matrix.tsv` records what the hosts saw. Clocks must agree within 500 ms
(`CLOCK_MAX_MS`); NTP (chrony, installed by `--prepare`).

**OS and access:** Ubuntu 24.04 x86_64, a non-root ssh user with key login
and passwordless sudo (for `--prepare`, which installs Docker, chrony and the
firewall rules). Hosts need outbound HTTPS to ghcr.io; the image is pulled
with `REGISTRY_TOKEN` (`read:packages`), never stored on the host.

## Ports

TCP, open between all hosts and from the controller only (`--prepare` sets
the `DOCKER-USER` rules; ufw alone does not cover published container ports):

| What | Ports for 30 validators |
|---|---|
| ssh | 22 (or the inventory's port), from the controller |
| Node RPC and OMNI, node i: 53549 + 2i and 53550 + 2i | 53551-53610 |
| Gossip, node i: 54549 + i | 54550-54579 |

Postgres is not published. The controller reaches every node RPC directly.

## Time and cost

Per scenario run at N validators (estimated from the harness's timeouts and
the smoke, where `third-n4s4` took 6.6 min and `load-n4s4` 7 min end to end):

- preflight and image pull: 1-3 min (a first pull of 616 MB per host);
- genesis delay `60 + 25 N` s: 13.5 min at N = 30 (the nodes boot during it);
- the scenario: `third` about 5 min, `hostloss` up to 6 min, `halt` about
  8 min, `load` about 8 min at the default 300 s + drain, `restart` 5-30 min
  (5 restarts, 1-6 min each);
- teardown and evidence: about 1 min.

Default campaign at 30 validators (`restart third hostloss halt load`):
about 5 x 16 min + 45 min of scenarios = **about 2 h**, plus 10 min of
`--prepare` on fresh hosts: **T = 2.2-2.5 h** (estimated; `results.tsv` in
the campaign dir records the real minutes per scenario).

Hourly cost:

```
cost = H x price_per_host_hour x ceil(T + setup_h)
     + egress_GB x price_per_GB
```

- `H`: hosts in the inventory (10 for 10 x 3).
- `T`: the campaign, about 2.5 h for the default scenarios at 30 validators.
- `setup_h`: renting and filling the inventory before the campaign starts,
  and any hour a host is kept for inspection afterwards.
- `ceil`: a provider that bills by the started hour; drop it for per-minute
  billing.
- `egress_GB`: 30 validators x the per-validator network above x T; up to
  about 2 GB/h x 30 x 2.5 h = 150 GB under load, far less idle (estimated:
  the 30-validator figure is not measured yet). Most providers include a
  monthly allowance well above that; check before renting.

Example: 10 hosts, 3 h billed, egress inside the allowance:
`cost = 10 x 3 x price_per_host_hour` = 30 host-hours of a 4 vCPU / 8 GB host.
