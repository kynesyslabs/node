# Public RPC network watcher

Read-only Bun service with no packages, keys, wallets, database, or validator-private access.
Configure **at least three public RPC URLs run by different operators** for mainnet. The
mainnet list is not known yet. One URL works for head/signing observations but cannot
establish network agreement. URLs must have distinct hosts (including port); metrics
label endpoints by host only, never by credentials, path, or query.

```sh
cd monitoring/network-watcher
WATCH_RPC_URLS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example bun index.ts
curl http://localhost:9465/metrics
```

| Environment | Default | Meaning |
| --- | --- | --- |
| `WATCH_RPC_URLS` | required | Comma-separated HTTP(S) RPC endpoints |
| `WATCH_POLL_SECONDS` | 15 | Delay between completed polls (1–3600 seconds) |
| `WATCH_PORT` | 9465 | Metrics HTTP listener port |
| `WATCH_SIGN_WINDOW` | 20 | Complete recent block window (1–1000 blocks) |

Every request has an 8-second deadline. Heads and comparison blocks are requested
concurrently across endpoints. Errors, HTTP failures, bad JSON, invalid response shapes,
and unsupported RPCs increment `demos_watch_poll_errors_total{endpoint}`. Unsupported
`getFinalizedHead` and `getValidatorSet` are remembered until restart, so legacy nodes
remain usable without repeated unsupported requests. Head reads use `getLastBlockNumber`
when finalized-head reads fail. `endpoint_up` means a complete head/block read succeeded;
later history/set errors are visible in the error counter. Failed heads omit their head
and timestamp series. Scrapes expose only completed poll snapshots.

Hashes are compared at `max(0, min(reachable heads) - 2)`. The signer window ends there,
excludes unsigned genesis, and uses one endpoint's complete history. Another endpoint
is tried if that history fails. No incomplete window is exported. Validator identity
labels retain keys up to 128 characters, otherwise use the complete SHA-256 digest.
`validator_last_signed_height` remembers the last observed signing height while an
identity stays in the set; zero means not observed since startup. Departed series are
removed. No signatures are cryptographically verified: these are public RPC observations.

`getValidatorSet` supplies active (`status="2"`, effective `validAt`) identities at the
comparison height. Otherwise the union of signers in the window supplies the set.
`demos_watch_validator_set_source{source="rpc|signers"}` is one-hot. Fallback cannot
name a validator absent from the entire window, so it cannot alert for such a validator.
Even with the RPC set, an eligible validator may not be selected into a committee during
the window: `ValidatorNotSigning` is an investigation signal, not proof of failure.

The actual producer quorum is `floor(2 * shardSize / 3) + 1`
(`src/libs/consensus/v2/quorum.ts:10-11,19-26`), using genesis committee size, not
validator pool size. Public GET `/genesis` supplies `properties.shardSize`, cached after
validation. `demos_watch_signature_threshold` exports this quorum; if it cannot be read,
the metric and `SignerCountLow` are unavailable (the error counter increases).
`SignerCountLow` fires at or below quorum + 1. Block signers are from the comparison
block. The head high-water mark starts a 300-second grace period on first successful
observation; an entirely unreachable network starts that timer on the first poll.
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

This service cannot diagnose causes or distinguish a stalled/forked network from a
faulty or isolated single RPC. A fork needs at least two successful comparison reads;
`fork_detected=0` with fewer is no evidence of agreement. Local resource use, validator
peer connectivity, mempools, and unpublished/private forks are outside its view.

Run the standalone Bun tests from this directory (the repository root Bun config
preloads unrelated node code): `bun test index.test.ts`. Run all rule tests with
`promtool test rules monitoring/prometheus/tests/*.test.yml` from the repository root.
