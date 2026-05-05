# TODO — performance & cost documentation

We owe published documentation for the items below but do not yet have clean stress-test numbers. Track this here so the work isn't lost.

## Owed

### 1. Empirical gas costs (testnet)

Operations to publish costs for:
- `pay()` native DEM transfer — cost per call regardless of amount.
- `StorageProgram.createStorageProgram` — cost per program creation.
- `StorageProgram.writeStorage` — cost per write (currently appears to be ~0 for owners).
- Account creation by first deposit — currently appears free.

Format: a table per network (testnet, mainnet when applicable) with method → cost → notes.

### 2. Recommended max concurrency per public node

Today, integrators discover the concurrency ceiling empirically. The SpaceFort field report observed 80 concurrent agents at 99.4% success and 150 at 86.7%. Publish:
- A recommended `maxConcurrentInflight` figure per public node.
- Guidance on how clients should self-throttle using the new `X-RateLimit-*` headers (cross-link to the rate-limits page once it lands in the docs site).

### 3. Public-node SLO + status page

- Define an availability target for public nodes (e.g. 99.5%).
- Provide a status-page URL once one exists.
- Document how to report outages.

## Cross-links

- `getTransactionStatus` RPC (Phase 1 item 4) — once shipped, reference it from the transaction-lifecycle docs.
- Rate-limit headers (Phase 1 item 2) — once shipped, reference from the throttling guidance.
- `broadcastAndWait` SDK helper (Phase 1 item 8) — once shipped, reference from the quick-start.

## Status

- [ ] Gather gas-cost numbers from a clean testnet run.
- [ ] Run a controlled concurrency ramp on a fresh public node and pick a recommended limit.
- [ ] Publish to the docs site (`kynesyslabs/documentation-mintlify`) — see `PHASE1_DOCS_UPDATE.md` in the engineering planning artifacts for the docs hand-off brief.
- [ ] Remove this TODO once published.
