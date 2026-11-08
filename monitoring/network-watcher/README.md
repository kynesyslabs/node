# Public RPC network watcher

Read-only Bun service with no packages, keys, wallets, database, or validator-private access.
Configure **at least three public RPC URLs run by different operators** for mainnet. The
mainnet list is not known yet. One URL works for head/signing observations but cannot
establish network agreement. URLs must have distinct hosts (including port); metrics
label endpoints by host only, never by credentials, path, or query. A URL may carry a
proxy path prefix: RPC calls post to the URL itself, and the node's GET `/genesis` is
read at the URL's path plus `/genesis` (query kept), e.g. `https://host/rpc/genesis`.

```sh
cd monitoring/network-watcher
WATCH_RPC_URLS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example bun index.ts
curl http://localhost:9465/metrics
```

| Environment | Default | Meaning |
| --- | --- | --- |
| `WATCH_RPC_URLS` | required | Comma-separated HTTP(S) RPC endpoints |
| `WATCH_POLL_SECONDS` | 15 | Delay between completed polls (1–120 seconds: the advance time moves only when a poll runs, and `NetworkHeadStalled` fires 300 seconds after it) |
| `WATCH_PORT` | 9465 | Metrics HTTP listener port |
| `WATCH_SIGN_WINDOW` | 20 | Complete recent block window (1–20 blocks) |

Every request has an 8-second deadline. Heads and comparison blocks are requested
concurrently across endpoints. Errors, HTTP failures, bad JSON, invalid response shapes,
and unsupported RPCs increment `demos_watch_poll_errors_total{endpoint}`, and so does
each size bound: a response over 4 MiB (a declared `Content-Length` is refused before
reading; an undeclared body is streamed and cancelled once it passes 4 MiB), a block with more
than 1000 signatures, a validator list with more than 1000 entries (the signer union is
used instead), and a signer union over 1000 identities (that endpoint's window is not
exported; the next endpoint is tried). Unsupported `getFinalizedHead` and
`getValidatorSet` are skipped for 10 minutes and then retried, so legacy nodes remain
usable without a request every poll, and a node upgraded behind the same host (e.g. a
rolling upgrade behind a load balancer) is used again. Head reads use `getLastBlockNumber`
when finalized-head reads fail. `endpoint_up` means a complete head/block read succeeded;
later history/set errors are visible in the error counter. Failed heads omit their head
and timestamp series. Scrapes expose only completed poll snapshots.

Hashes are compared at `max(0, min(reachable heads) - 2)`. The signer window ends there,
excludes unsigned genesis, and uses one endpoint's complete history. Another endpoint
is tried if that history fails. No incomplete window is exported. Validator identity
labels retain keys up to 128 characters, otherwise use the complete SHA-256 digest.
`validator_last_signed_height` remembers the last observed signing height while an
identity stays in the set; zero means not observed since startup. Departed series are
removed from the watcher's output; Prometheus keeps them until head compaction. No
signatures are cryptographically verified: these are public RPC observations.

Every listed endpoint is trusted for validator labels. The validator list and signer keys
come unverified from the endpoint that supplies the window, and the 1000 caps bound one
poll, not the change between polls: a hostile or buggy endpoint can add up to 1000 new
identities (2 series each) to Prometheus every poll. The cap is not lower because the
mainnet validator count is not known yet. List only endpoints you trust with that.

Window blocks are kept per endpoint and reused while the fresh comparison block's hash
chain (`content.previousHash`) still reaches them; a broken chain drops them and counts
an error. Request cost per poll: 3 POSTs to every reachable endpoint (finalized head,
head block, comparison block; one more with the `getLastBlockNumber` fallback), plus,
for the endpoint supplying the window, `getValidatorSet` and each window block not
already held. At the defaults (15-second poll, 10-second blocks) that endpoint sees about
4.5 POSTs per poll, roughly 26,000 a day, against the node's default per-IP budget of
200,000 POSTs a day (`RATE_LIMIT_POST_MAX_REQUESTS`, shared with anything else behind
the watcher's IP). A cold poll (startup, a different endpoint, a replaced chain) reads
the whole window: `WATCH_SIGN_WINDOW + 3` POSTs, 23 at most, so even all-cold polls stay
near 132,000 a day. Cost scales with `15 / WATCH_POLL_SECONDS`; an exhausted budget
answers 429 and surfaces as `RpcEndpointDown`.

`getValidatorSet` supplies active (`status="2"`, effective `validAt`) identities at the
comparison height. Otherwise the union of signers in the window supplies the set.
`demos_watch_validator_set_source{source="rpc|signers"}` is one-hot. In signer-union
mode every listed identity signed at least once in the window by construction, so
`ValidatorNotSigning` cannot catch a validator that was silent for the whole window;
only the RPC set can name it. Even with the RPC set, an eligible validator may not be
selected into a committee during the window. Under commitLock the stored certificate
holds only the precommits present when quorum was reached, so a validator whose
precommit usually arrives late can show zero signatures in the window while it signs
every block. `ValidatorNotSigning` is an investigation signal, not proof of failure.

The actual producer quorum is `floor(2 * shardSize / 3) + 1`
(`src/libs/consensus/v2/quorum.ts:10-11,19-26`), using genesis committee size, not
validator pool size. Public GET `/genesis` supplies `properties.shardSize`, cached after
validation. `demos_watch_signature_threshold` exports this quorum; if it cannot be read,
the metric and `SignerCountLow` are unavailable (the error counter increases).
`SignerCountLow` fires below quorum, where a committed block should not exist. It has
no margin above quorum: under commitLock the stored certificate is the precommits held
the moment quorum was reached (`commitLock/precommit.ts:417-419,489-519`,
`PoRBFT.ts:1315-1316`), so healthy blocks can carry exactly quorum. Block signers are
from the comparison block. The stall timer restarts whenever the highest reachable head
exceeds the previous poll's highest head (not an all-time peak, so one inflated head or
a chain reset cannot hold `NetworkHeadStalled` on); it starts on the first successful
observation, and an entirely unreachable network starts it on the first poll. An advance
is any rise of the highest reachable head over the previous poll, so a highest endpoint
that drops out and returns during a stall counts as one. An
endpoint that keeps reporting an inflated head still holds `head_max` up, and
`RpcEndpointBehind` then fires for every honest endpoint.
Losing all endpoints preserves the last advance time and drops signer observations.

In the monitoring stack:

```sh
WATCH_RPC_URLS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example \
  docker compose --profile network up -d
```

The optional service uses internal port 9465, scraped by `demos-network-watcher`.
Compose fixes the container port to match Prometheus; direct execution accepts
`WATCH_PORT`. The default stack does not start the watcher. The configured optional
scrape target is down until the profile is enabled. Alerts use existing critical/warning
Alertmanager routes; `alertmanager.yml` is unchanged. The listener serves `/metrics`
and returns 404 elsewhere; restrict direct-run listener access using the host firewall.

A dead or crash-looping watcher raises no alert: every rule reads `demos_watch_*`
series, and those are simply absent then. An empty `WATCH_RPC_URLS`, for example, makes
the container exit and restart. After enabling the profile, check that
`up{job="demos-network-watcher"}` is 1 (Prometheus query or Targets page). No rule ships
for it because that target is also down whenever the profile is off.

This service cannot diagnose causes or distinguish a stalled/forked network from a
faulty or isolated single RPC. A fork needs at least two successful comparison reads;
`fork_detected=0` with fewer is no evidence of agreement. The lowest reachable endpoint
sets the height of the fork comparison and the signer window, so while one endpoint is
behind or stuck, fork, signer and validator checks describe that old height, and a fork
on that endpoint within two blocks of its head is not seen. Fix that endpoint or remove
it from `WATCH_RPC_URLS`. Local resource use, validator peer connectivity, mempools, and
unpublished/private forks are outside its view.

Run the standalone Bun tests from this directory (the repository root Bun config
preloads unrelated node code): `bun test index.test.ts`. Run all rule tests with
`promtool test rules monitoring/prometheus/tests/*.test.yml` from the repository root.
