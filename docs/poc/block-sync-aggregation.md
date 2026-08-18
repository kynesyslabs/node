# Block sync aggregation POC

Version 1 (below) proved the linear-call model. Version 2, documented in
[Version 2: bitmap aggregates and partitioned dissemination](#version-2-bitmap-aggregates-and-partitioned-dissemination),
addresses the three follow-ups the v1 review named: aggregate byte size, the
relay trust rule, and mixed-version activation.

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

## Lightweight transport-scale result

`testing/devnet/scripts/run-sync-scale-emulator.ts` exercises the real
aggregate builder, wire shape, and recipient admission code over loopback HTTP
with hundreds of virtual identities. It injects 20–100 ms baseline jitter, 5%
slow peers with another 220 ms delay, and 5% retryable first-attempt failures.
The VPS wrapper pauses (but does not remove) the six full POC nodes, enforces a
memory floor, verifies DACS health, and resumes all six nodes after the run.

On 2026-08-18, five post-block bursts were measured at each size:

| Peers | Legacy calls/block | Aggregate calls/block | Reduction | Mean burst | Aggregate | Total wire/block | Peak RSS | Event-loop p99 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 10,384 | 195 | 98.1% | 504 ms | 6.8 KB | 0.72 MB | 70 MB | 3.9 ms |
| 250 | 63,484 | 495 | 99.2% | 528 ms | 17.1 KB | 4.51 MB | 104 MB | 14.7 ms |
| 500 | 251,984 | 995 | 99.6% | 810 ms | 34.4 KB | 18.10 MB | 149 MB | 55.2 ms |

The observed logical call count matched the linear model at every size. All
deliveries were admitted after bounded retries; valid aggregates passed, while
non-signer and wrong-block aggregates failed closed. The six full nodes and
all four live DACS services were healthy after automatic resume.

Run the guarded VPS test with:

```text
NODE_COUNTS=100,250,500 ITERATIONS=5 \
  testing/devnet/scripts/run-sync-scale-vps.sh
```

This is strong evidence for the transport path, not a substitute for a real
multi-host validator soak. The emulator multiplexes virtual recipients through
one Bun process and does not reproduce hundreds of databases, consensus loops,
OmniProtocol connections, cryptographic acknowledgement signatures, or WAN
kernel scheduling. The 18.1 MB sender burst at 500 peers also motivates the
documented bitmap/tree follow-up even though the burst completed in under one
second here.

## Version 2: bitmap aggregates and partitioned dissemination

Version 2 is selected with `BLOCK_SYNC_AGGREGATION_VERSION=2` (the default
when aggregation is enabled) and changes two things relative to v1 while
keeping every consensus rule untouched: how acknowledgements are encoded, and
who sends what.

### Bitmap wire format

The v2 aggregate replaces the JSON identity list with a bitmap over the
*canonical acknowledgement index*: the block's committed peerlist identities,
normalized to lowercase, deduplicated and sorted. The committed peerlist is
part of the block-hash preimage (`serializeBlockContent` covers
`content.peerlist`), so every node holding a block derives the identical
index locally and no identities travel on the wire:

```jsonc
{
  "version": 2,
  "blockNumber": 12345,
  "blockHash": "…",
  "peerlistSize": 500, // cross-check against the local index length
  "ackBits": "…"       // base64, bit i = index entry i acknowledged
}
```

At 500 peers the bitmap is 63 bytes (~84 base64 characters), reducing the
aggregate body from 34.4 KB to roughly a quarter of a kilobyte.

The index deliberately does **not** include `validation_data.signatures`:
the signature map is merged incrementally per node, is outside the block-hash
preimage, and is therefore not guaranteed identical across nodes. Building a
bitmap over it would make the same aggregate decode differently on different
nodes. Signers drawn from the committed peerlist (the normal case — the
committee is drawn from it) are representable; a signer absent from the
committed peerlist simply cannot be acknowledged in v2, which is a liveness
hint loss only.

Receivers fail closed on decoding: an aggregate is rejected unless its
`peerlistSize` equals the locally derived index length, its base64 payload is
canonical and exactly `ceil(size / 8)` bytes, and every bit beyond the index
is zero. Both wire versions remain admissible on the receive path
indefinitely, so mixed v1/v2 fleets converge.

### Partitioned block delivery and partial aggregates

v1 made the secretary (`committee[0]`) the sole publisher of both the block
and the aggregate. That concentrated an `O(N)` byte burst on one node and
created a single point of failure — made worse by the fact that the drawn
committee order is liveness-filtered and view-dependent, so nodes can
disagree about who `committee[0]` even is (zero-publisher rounds).

In v2 every *signing* committee member publishes:

- **Block delivery** is partitioned. Peer `p` belongs to the slice
  `H(p, blockHash) mod S`, owned by the member at that position of the
  *sorted signing committee*. The assignment depends only on the peer
  identity, the signing committee and the block hash — never on peerlist
  ordering, which differs between nodes — so divergent local views degrade
  to duplicate deliveries (deduplicated by the receiver's existing
  `handleNewBlock` short-circuits) or missed deliveries (repaired by the
  retained fastSync/anti-entropy path, now affecting ~1/S of peers instead
  of all of them). Salting with the block hash rotates slice ownership every
  block, so a withholding or crashed member cannot starve the same peers
  round after round. Only members whose signature is on the block are
  excluded from slices: a member that aborted mid-round holds neither the
  block nor a signature and stays an ordinary delivery target. Total
  deliveries stay `N − S`; per-sender block bytes divide by `S`.
- **Acknowledgement aggregation** is per-member. Each member builds one
  partial bitmap aggregate from its own slice's delivery responses, applies
  it locally through the admission path, and broadcasts it to every other
  node. Receivers admit each partial through the same fail-closed path and
  union the results; the union is idempotent and order-independent, so no
  merge protocol or extra message type is needed.
- **Race buffering.** A member with a fast slice publishes its partial while
  slower slices are still delivering, so partials routinely reach a peer
  just before that peer's own block delivery. Receivers buffer aggregates
  addressed to `lastBlockNumber + 1` (bounded to 64 entries, 60 s TTL) and
  replay them through the same admission path once the block lands, instead
  of rejecting them permanently.

Modeled post-block request counts for a four-member committee:

```text
legacy:  S*(N-S) + N*(N-S) + N*S
v1:      (N-S) + (N-1)
v2:      (N-S) + S*(N-1)
```

| Nodes |  Legacy |    v1 |    v2 | v2 reduction vs legacy |
| ----: | ------: | ----: | ----: | ---------------------: |
|     6 |      44 |     7 |    22 |                  50.0% |
|    20 |     464 |    35 |    92 |                  80.2% |
|    50 |   2,684 |    95 |   242 |                  91.0% |
|   500 | 251,984 |   995 | 2,492 |                  99.0% |

v2 spends more requests than v1 (each of the `S` members broadcasts its own
partial) and buys three things with them: aggregate bytes shrink by two
orders of magnitude, per-sender block-delivery load divides by `S`, and no
single node is a required publisher for either the block or the hints.

Measured with the same loopback emulator, knobs and pass criteria as the v1
run (2026-08-19, five bursts per size, 20–100 ms jitter, 5% slow peers, 5%
transient failures, bounded retries; `--aggregate-version=2`):

| Peers | Legacy calls | v2 calls | Reduction | Mean burst | Partial aggregate | Total wire/block | Peak RSS | Event-loop p99 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 10,384 | 492 | 95.3% | 573 ms | 119 B | 0.08 MB | 95 MB | 4.0 ms |
| 250 | 63,484 | 1,242 | 98.0% | 754 ms | 143 B | 0.22 MB | 105 MB | 5.9 ms |
| 500 | 251,984 | 2,492 | 99.0% | 1,294 ms | 183 B | 0.54 MB | 206 MB | 28.0 ms |

Observed calls matched `estimatePostBlockTraffic(n, s, true, 2)` exactly at
every size; every partial was admitted everywhere, every non-signer received
the block exactly once, and every receiver's accepted union was exactly the
committed peerlist minus itself. Total post-block wire volume at 500 peers
drops from 18.1 MB (v1) to 0.54 MB — roughly 34× less — while the burst
stays under 1.3 s through a single emulator process. The same v1 safety
cases plus four v2-specific rejection cases (non-signer sender, wrong block,
index-size mismatch, trailing bitmap bit) all fail closed. One integration
requirement surfaced by the emulator: a committee member never receives its
own partial over the wire, so the builder must apply its own partial locally
through the same admission path — `broadcastNewBlock` does exactly that
before publishing.

### Sync-hint monotonicity

v1's `applySyncAggregate` mutated live `Peer.sync` hints without the
monotonicity guard the legacy `updateSyncData` path gets from
`PeerManager.addPeer`, so an aggregate for an older (still locally verified)
block could regress a fresher hint. Those hints feed sync-source selection,
the forge quorum pre-check and the network-ahead veto. v2 adds the guard: an
aggregate never lowers `peer.sync.block`; a same-height aggregate may still
correct a conflicting hash to the locally verified one.

### Trust rule (v1 review gate 1)

The aggregate relay operates under the following rule, which replaces the
per-acknowledgement signature requirement for this feature *only*:

> A sender that signed block `B` (present in the receiver's stored
> `validation_data.signatures` for `B`) is trusted to relay *liveness-only*
> acknowledgement observations about `B`.

This is sound because admission is fail-closed on every axis that could
affect consensus or state:

- an aggregate is only accepted for a block the receiver itself already
  verified and stored — it can never announce, deliver, or advance a chain;
- it can only reference identities already committed in that block's
  hash-covered peerlist (or its signers) *and* already known locally — it
  can never add a peer;
- it never marks a peer online and never regresses a hint (monotonicity
  guard) — it can only advance a known peer's sync pointer to a block the
  receiver holds;
- the sender must hold a consensus identity that signed the block, verified
  via the authenticated RPC envelope.

The residual power of a malicious block signer is to *falsely advance* a
peer's hint to the current block. The reachable consequences are bounded to
liveness: a stale sync-source choice (retried against the next peer), or an
inflated forge-quorum pre-check that lets a round start which then fails to
gather real signatures. No state, no finality, and no block content can be
influenced, because none of the consumers of `peer.sync` feed block
validation. Appendix A documents the upgrade path to per-acknowledgement
detached signatures if a later review rejects this rule.

### Activation protocol (v1 review gate 2)

`BLOCK_SYNC_AGGREGATION_ACTIVATION_HEIGHT` coordinates a mixed-version
fleet. The send-side behaviour switch is evaluated per block height, not at
process start:

1. Roll out the build with `BLOCK_SYNC_AGGREGATION_ENABLED=true`,
   `BLOCK_SYNC_AGGREGATION_VERSION=2` and an agreed future activation
   height `H` on every node, restarting nodes at operator convenience.
2. Below `H` every node keeps byte-identical legacy behaviour (all-member
   block broadcast, receiver status rebroadcasts).
3. From the first block with `number >= H`, upgraded committee members
   switch to partitioned delivery and partial aggregates in the same round.
4. Receivers admit v1 and v2 aggregates regardless of height, and legacy
   `updateSyncData` handlers remain in place, so laggard nodes degrade to
   the anti-entropy path instead of diverging. Nodes that never received
   the flag keep full legacy behaviour and interoperate.

Rollback is the reverse: unset the flag (or raise `H`) and restart; there is
no persistent state to migrate because aggregates only touch in-memory sync
hints.

**Rollout invariant:** any change to `BLOCK_SYNC_AGGREGATION_ENABLED` or
`BLOCK_SYNC_AGGREGATION_VERSION` on a live fleet must ship with a fresh
activation height beyond the expected rollout completion. Nodes disagreeing
about the active mode inside one committee cannot corrupt anything (all
paths fail closed and receivers admit both versions), but a mixed committee
where a v2 member delivers only its slice while v1 members expect a sole
secretary publisher leaves some peers waiting on fastSync for the whole
mismatch window. The activation height exists precisely so that window never
opens; it is per-node configuration, so operators — not the protocol —
enforce agreement today (see finding 6).

### Review findings recorded for maintainers

Discovered while building v2; pre-existing on `stabilisation` unless noted:

1. `BroadcastManager.handleUpdatePeerSyncData` returns
   `peerman.addPeer(peer) ? 200 : 400`, but `addPeer` returns a
   `[boolean, string]` tuple — always truthy, so rejected peers still get
   200 "Sync data updated".
2. The RPC auth header signs only `sha256(identity:timestamp)`; request
   bodies are unbound. Before the `nonceEnforcement` fork activates, a
   captured header is a replayable bearer token, and `gcr_routine` is not in
   `PROTECTED_ENDPOINTS`. The aggregate path fails closed on content, but
   body-binding signatures are worth revisiting network-wide.
3. Hello gossip piggybacks on `isNetworkAhead('mainLoop')` and messages
   every known peer roughly every 2 s — an O(N²)-per-interval background
   load that dwarfs the post-block burst at scale and is the natural next
   target after this change.
4. `peerGossip`/`peerRoutine` are dead code in the live loop (commented out
   of `mainLoopCycle`), although POC comments name peer gossip as a recovery
   path; actual recovery flows through hello + fastSync.
5. The duplicate-block short-circuit in `manageGCRRoutines` returned a bare
   string without `syncData`, so already-synced peers could not be counted
   in aggregates (fixed in this branch by returning the standard
   `handleNewBlock` response shape).
6. `BLOCK_SYNC_AGGREGATION_ACTIVATION_HEIGHT` is per-node configuration
   with no in-band enforcement; committing it as a governance/network
   parameter would remove the operator-coordination requirement.
7. Aggregate admission trusts the locally merged
   `validation_data.signatures` map, which is not hash-covered; a valid
   partial can be rejected 403 on a receiver that has not yet merged the
   sender's signature. Fail-closed, hint-only loss, repaired by
   anti-entropy; verifying the sender's signature cryptographically against
   the block hash would remove the race at the cost of a worker-pool verify
   per aggregate.
8. `updateSyncAggregate` (like `updateSyncData`) has no per-peer rate
   limit; a block signer can replay valid aggregates cheaply. Admission work
   is bounded (one DB fetch plus one sort of ≤ committed-peerlist size), but
   a token bucket on the route would close the amplification avenue.

### Appendix A: detached acknowledgement signatures (designed, not enabled)

If a future review requires cryptographic acknowledgements instead of the
trust rule, the primitives already exist: recipients would sign with the
same worker pool that produces block signatures
(`TxValidatorPool.getInstance().sign`) and return the signature alongside
`syncData` in the `syncNewBlock` response; publishers would verify before
setting a bit and attach the signature set; receivers would verify per bit.

Two constraints for that design, learned here:

- **Domain separation is mandatory.** Block signatures sign the raw block
  hash bytes (`createBlock.ts`). An acknowledgement must sign a
  domain-separated message such as `demos-sync-ack:v1:<number>:<hash>` —
  signing the bare hash would make every acknowledgement a forgeable block
  signature and vice versa.
- **Bytes revert to O(N).** 500 ed25519 signatures ≈ 32 KB — the same order
  as the v1 JSON aggregate — plus ~500 verifications per receiver per
  block. A practical middle ground is carrying the signature set only on
  demand (audit pull) or sampling; a compact certificate needs a BLS-class
  scheme, which is not in the dependency tree today.
