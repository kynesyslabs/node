# Block sync aggregation POC

## Purpose

This POC tests one narrow change to the existing PoRBFT network path. It does
not change transaction validation, committee voting, block construction, or
finality.

The legacy path invokes block broadcast on every committee member, then makes
each non-signing block recipient rebroadcast its sync status to every known
peer. With `N` nodes and `S` block signers, its modeled post-block request
burst is:

```text
S * (N - S) duplicate block deliveries
+ N * (N - S) recipient status calls
+ N * S sender status calls
```

The POC designates the existing committee secretary as the sole block
publisher and replaces the recipient broadcasts with one acknowledgement
aggregate:

```text
(N - S) block deliveries + (N - 1) aggregate deliveries
```

## Activation

The experiment is disabled by default. Enable it only on an isolated devnet:

```text
BLOCK_SYNC_AGGREGATION_ENABLED=true
```

Every node in the experiment must use the same setting. This POC does not
define a mixed-version activation protocol.

The repository includes a loopback-only, resource-bounded overlay. Generate
six identities and enable both POC profiles so a four-validator committee has
two real non-signing block recipients:

```text
NODE_COUNT=6 testing/devnet/scripts/setup.sh
docker compose --profile rehearsal --profile scale-poc -p demos-sync-poc \
  -f testing/devnet/docker-compose.yml \
  -f testing/devnet/docker-compose.fixture.yml \
  -f testing/devnet/docker-compose.sync-aggregation-poc.yml up --build
```

Set `BLOCK_SYNC_AGGREGATION_ENABLED=false` on the compose command to run the
same resource-bounded topology through the legacy path for comparison.

Six full processes are the safe ceiling for the current 4-CPU production VPS.
The 20/30/50-node validation must run across dedicated hosts; putting those
processes on one busy machine would benchmark CPU and memory starvation rather
than consensus networking.

## Validation performed by recipients

An aggregate is accepted only when:

- it has the bounded version-1 shape;
- its block number and hash match a locally stored block;
- its RPC sender signed that block;
- each claimed identity was committed in the block peerlist or signed the
  block; and
- the peer is already known locally.

The aggregate only advances the peer's sync hint to an already verified local
block. It never marks a peer online. Existing authenticated hello calls and
peer gossip remain the anti-entropy path for missed aggregate deliveries.

## POC limitation

The aggregate authenticates the block-signing publisher, not each relayed
peer acknowledgement. A production protocol should either carry a detached
signature from every acknowledging peer or formally state that a quorum block
signer is trusted to relay inclusion-only liveness observations. This POC must
not be deployed until that trust decision and mixed-version activation are
reviewed.

## Modeled request counts

For a four-validator committee:

| Nodes |  Legacy | Aggregate | Reduction |
| ----: | ------: | --------: | --------: |
|     5 |      29 |         5 |     82.8% |
|     6 |      44 |         7 |     84.1% |
|    20 |     464 |        35 |     92.5% |
|    30 |   1,004 |        55 |     94.5% |
|    50 |   2,684 |        95 |     96.5% |
|   500 | 251,984 |       995 |     99.6% |

With 500 realistic 66-character public-key identities, the version-1 JSON
aggregate is about 34.4 KB before its authenticated RPC envelope. A production
version should encode acknowledgements as a peerlist-indexed bitmap (or use a
bounded gossip tree) to reduce bytes as well as request count.

The model excludes periodic anti-entropy because it is not triggered once per
block. A real multi-host run is still required to measure bytes, latency,
retries, convergence, and failure recovery.

## Six-node VPS result

On 2026-08-18 the legacy and aggregate paths were run on the same isolated
six-node Docker topology (four-member shard, two non-signing recipients), with
a 20-second consensus cadence. Each measurement excluded startup traffic and
covered five complete blocks.

| Mode | Block deliveries | Sender status | Receiver status | Aggregate | Total calls/block |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy | 8 | 24 | 12 | 0 | 44 |
| Aggregate | 2 | 0 | 0 | 5 | 7 |

The measured reduction was 84.1%, exactly matching the model. All six nodes
started and ended each sample at the same height (height spread zero).

A missed-update recovery check then stopped node 6 while the chain advanced,
restarted it, and observed node 6 automatically converge with node 1 at height
10. This confirms the retained fast-sync/anti-entropy path repairs missed
aggregate deliveries in this topology.

The host had four CPUs and 15 GiB RAM. Six full nodes saturated the available
CPU during rounds and used roughly 1 GiB resident memory each, so larger real
tests must use dedicated multi-host infrastructure. Running 20–50 processes on
that host would measure resource starvation rather than network scalability.
