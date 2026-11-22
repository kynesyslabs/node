# testing/loadgen

This folder contains the **scenario implementations**.

Read `testing/README.md` first. This file explains the narrow question: how individual scenarios are executed.

## What Runs Here

The loadgen registry lives in:

- `testing/loadgen/src/main.ts`

Scenarios are selected with:

```bash
SCENARIO=<name> bun testing/loadgen/src/main.ts
```

Normally you should prefer the wrapper:

```bash
testing/scripts/run-scenario.sh <scenario> [--build] [--env KEY=VALUE]
```

## Run Modes

### From the host through the wrapper

```bash
testing/scripts/run-scenario.sh consensus_tx_inclusion --build
testing/scripts/run-scenario.sh multichain_parser_execute_smoke
```

### Directly inside the devnet image

```bash
cd devnet
docker compose up -d --build

SCENARIO=peer_discovery_smoke \
docker compose -f docker-compose.yml -f ../testing/docker-compose.perf.yml \
run --rm --no-deps --build loadgen
```

## Important Boundary

`loadgen/` contains more scenarios than the current active-feature coverage contract.

That is intentional.

Interpret the registry like this:

- active implemented feature scenarios
- historical token scenarios kept for archaeology and future reactivation
- helper / observation / settle scenarios

Do **not** assume:

- every registered scenario is part of the current release gate
- every registered scenario counts toward active-feature completeness

For that decision, use:

- `docs/references/active-feature-test-coverage-matrix.md`

## Scenario Families

Current registry includes families such as:

- native transfers
- GCR
- consensus
- peer sync
- multichain / XM
- omni
- ZK
- TLSNotary
- Web2 / DAHR
- IM
- FHE
- incentives
- MCP
- L2PS
- token historical scenarios

## Rate limits

A node allows **4 identity confirms per block from one source address** (`RATE_LIMIT_TX_PER_BLOCK` in `src/utilities/constants.ts`, enforced in `src/libs/network/rpcRateLimit.ts`). It answers any further confirm in that block with HTTP 429. Every worker in one loadgen process shares one source address, so the cap applies to the process as a whole on each target node.

`gcr_identity_loadgen` normally stays within this cap:

- it starts 4 workers per distinct node in `TARGETS` (a URL listed twice counts once, but two different URLs for the same node, for example `localhost` and `127.0.0.1`, count as two), but no more workers than there are wallets, since workers that share a wallet race on its nonce. It spreads the workers evenly over the distinct nodes, so a URL listed twice gets no extra workers. An explicit `CONCURRENCY` at or below the cap and the wallet count is used as given. One above either is clamped to the smaller of the two, with a log line that names the limit that applied (the cap or the wallet count), unless `GCR_IDENTITY_OVER_CAP=true` is set, which keeps the requested number with a warning. The Docker perf compose (`testing/docker-compose.perf.yml`) passes `CONCURRENCY=50` by default, which is clamped: with its 4 targets and 4 wallets the scenario runs 4 workers, one per wallet;
- it treats the cap's 429 as back-pressure: the worker waits for the next block on that target and retries the same step, up to `RATE_LIMIT_MAX_RETRIES` blocks (default 10). If no new block shows up within `SETTLE_TIMEOUT_SEC`, the step ends with its 429 and is not sent again; that 429 counts in `counters.rateLimited` as an error, whether or not the run has ended by then. Retries (the extra attempts actually sent) are counted as `counters.rateLimitRetries` in the summary and are not errors. A step whose retry the run deadline cut off is counted as `counters.rateLimitedAtDeadline`, next to `counters.rateLimited` (both also per second in the timeseries): that is a cap 429 with a retry still allowed when the run had ended, before the block wait or once the new block showed up. It stays in `counters.total` but is not an error and does not count towards `MAX_ERROR_RATE`. It is listed as `rate_limit` in `operatorSummary.primaryIssues`, and a run with no successful step fails even when its error rate is 0 (for example when every step's retry is cut off at the deadline). A cap 429 with no retry left (`RATE_LIMIT_MAX_RETRIES` used up, or set to 0) counts in `counters.rateLimited` as an error, even when it arrives after the deadline;
- it retries only the cap's HTTP 429. The node's general rate limiter (`src/libs/network/middleware/rateLimiter.ts`) also answers HTTP 429 with "Rate limit exceeded" when it blocks an address for some seconds, but it sends a `Retry-After` header and a number in the body's `retryAfter`; the cap sends neither (`retryAfter: null`). So a 429 is retried only when it has no `Retry-After` header and its body's `retryAfter` is not a number; a 429 that comes with only a status (no headers or body) counts as the cap. Any other 429, and other rate-limit errors, including an "IP blocked" message without an HTTP 429, end the step at once and count in `counters.rateLimited`, even at the deadline. A 429's error sample says which limiter sent it in `context.limiter` (`identity_cap` or `ip_block`);
- it ends the run at the first 429 only with `STOP_ON_RATE_LIMIT=true`, the old behaviour (the default is now `false`). No 429 is retried then, so one at the deadline also counts in `counters.rateLimited` as an error.

For Docker runs, `GCR_IDENTITY_OVER_CAP`, `RATE_LIMIT_MAX_RETRIES` and `STOP_ON_RATE_LIMIT` pass through from the host environment for a direct `docker compose ... run loadgen` (see "Directly inside the devnet image") as well as through `run-scenario.sh --env KEY=VALUE`, like `CONCURRENCY`. When they are unset, the perf compose passes them empty and the scenario uses its defaults.

End-of-run cleanup removes the identities a worker left behind, waiting out the cap's 429 the same way, and waits up to `SETTLE_TIMEOUT_SEC` for each remove to show before it checks for leaked identities. An identities read still pending at that point counts as not settled, so the wait does not run past `SETTLE_TIMEOUT_SEC`.

A 429 can still occur when the node's limiter has not yet seen the new block (it counts per the node's shared-state block number, which can lag the stored chain head the loadgen waits on); that 429 is retried as described above.

To push more identity load than 4 confirms per block, use:

- fewer workers per target (`CONCURRENCY`);
- more targets (`TARGETS`): the cap is per node;
- more source addresses: run loadgen containers or hosts side by side.

Do not whitelist the loadgen to get around the cap. Loopback is exempt, but a Docker bridge address or gateway (e.g. `172.17.0.1`) counts as a remote client. Whitelisting it on a public node would exempt any traffic that reaches the node through that bridge, which can include internet traffic that Docker forwards to a published port through its proxy.

## Artifacts

Each run writes under:

- `testing/runs/<RUN_ID>/`

Typical outputs:

- `*.summary.json`
- `*.timeseries.jsonl`

## Historical Status

Token-related scenarios are still documented by the registry because they exist and are runnable in the harness, but they are not currently part of the active-feature claim for this repo.
