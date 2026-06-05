---
type: runbook
title: The /genesisBlock and /identities Endpoints
date: 2026-06-05
status: active
---

# The /genesisBlock and /identities Endpoints

Two read-only GET routes on the node's RPC HTTP server
(`src/libs/network/server_rpc.ts`), served behind the same
CORS + rate-limiter + JSON middleware stack as every other GET route.
Default port is `53550`.

There are now three genesis-related GET routes — know which one you want:

| Route | Returns |
|---|---|
| `/genesis` | Only the embedded `genesisData` (chain params, balances, validators) parsed out of the genesis block's `content.extra.genesisData`. Pre-existing. |
| `/genesisBlock` | The **entire** genesis block (block 0) as stored — full `Blocks` record including `hash`, `number`, `content`, signatures, etc. |
| `/identities` | Paginated listing of every account's linked identities. |

---

## /genesisBlock

Dumps the whole genesis block (block 0) exactly as persisted, via
`Chain.getGenesisBlock()` (which is `getBlockByNumber(0)`).

### Quick check

```bash
curl -fsS http://localhost:53550/genesisBlock | jq
```

### Responses

- **200** — the full genesis `Blocks` object.
- **503** — `{ result: 503, response: "STATE_NOT_READY", extra: { message } }`
  when the genesis block is not found yet (node still booting / chain not
  initialized) or the read threw.

Use `/genesisBlock` when you need block-level fields (hash, signatures,
the raw `content` envelope). Use `/genesis` when you only need the chain
parameters and pre-funded balances.

---

## /identities

Lists the linked identities of every account, **paginated**. Each row is
just the account `pubkey` plus its `identities` jsonb blob — never
balance, nonce, or points. Backed by `GCR.listIdentities(limit, cursor)`
in `src/libs/blockchain/gcr/gcr.ts`.

### Why only pubkey + identities

The `gcr_main` table can hold a large number of jsonb-heavy rows, and the
`balance` column is a `bigint` that `JSON.stringify` cannot serialize. By
projecting only `pubkey` + `identities` at the SQL level
(`.select(["gcr.pubkey", "gcr.identities"])`) the payload stays focused
and the bigint serialization trap is never hit.

### Pagination — keyset, not offset

Pagination seeks on the `pubkey` primary key:
`WHERE pubkey > :cursor ORDER BY pubkey ASC LIMIT :n`. This stays
O(log n) on the PK index no matter how deep into the table you page —
unlike `OFFSET`, which scans and discards rows. An unbounded `find()`
over the whole table is deliberately avoided so a single request can
never load the entire account set into memory.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | `100` | Clamped to `[1, 1000]`. Non-numeric / non-positive falls back to 100; values above 1000 are capped. |
| `cursor` | string | — | The `pubkey` of the last row from the previous page. Omit for the first page. |

### Quick check

```bash
# First page (default 100 per page)
curl -fsS "http://localhost:53550/identities" | jq

# Custom page size
curl -fsS "http://localhost:53550/identities?limit=250" | jq

# Next page — pass back the previous response's nextCursor
curl -fsS "http://localhost:53550/identities?cursor=<lastPubkey>" | jq
```

### Response shape

```jsonc
{
  "success": true,
  "identities": [
    { "pubkey": "0xabc…", "identities": { "xm": { … }, "web2": { … }, "pqc": { … }, "ud": [ … ] } }
    // …
  ],
  "count": 100,        // rows in THIS page
  "limit": 100,        // effective (clamped) page size
  "nextCursor": "0xfff…" // pass as ?cursor= for the next page; null = end of table
}
```

### Paging to the end

Keep calling with `?cursor=<nextCursor>` until `nextCursor` is `null`.
A `null` cursor means the last page returned fewer rows than `limit`,
i.e. the table is exhausted.

```bash
cursor=""
while :; do
  url="http://localhost:53550/identities?limit=500"
  [ -n "$cursor" ] && url="$url&cursor=$cursor"
  resp=$(curl -fsS "$url")
  echo "$resp" | jq -c '.identities[]'
  cursor=$(echo "$resp" | jq -r '.nextCursor')
  [ "$cursor" = "null" ] && break
done
```

### Errors

- **500** — `{ success: false, error: "Failed to list identities", message }`
  if the DB query throws.
- **503** + `Retry-After` header — `{ success: false, error: "Service busy", message }`
  when the node is already serving its max concurrent `/identities` requests
  and a slot did not free in time (see DDoS hardening below).

### DDoS hardening

`/identities` is the most expensive GET route (a paginated full-table read
over jsonb-heavy rows), so it has three independent brakes layered on top
of each other. Tunable via `src/utilities/constants.ts`.

1. **Per-IP rate limit** — `identities` method limit
   (`RATE_LIMIT_IDENTITIES_MAX_REQUESTS` = 30 per
   `RATE_LIMIT_IDENTITIES_WINDOW_MS` = 60s), far below the default GET
   allowance of 2000/60s. Registered in the rate limiter's `pathMethodMap`
   (`src/libs/network/middleware/rateLimiter.ts`) and `methodLimits`
   (`src/utilities/sharedState.ts`). Stops a single source from flooding.
   Over the limit → standard 429 from the rate-limiter middleware.

2. **Global concurrency gate** — at most `IDENTITIES_MAX_CONCURRENT` (= 3)
   `/identities` handlers execute at once across **all** callers, so a
   distributed burst (many IPs × 1 request each, which the per-IP limit
   can't catch) still can't pile unbounded DB load. Overflow callers queue
   up to `IDENTITIES_MAX_QUEUE` (= 12) deep and wait at most
   `IDENTITIES_ACQUIRE_TIMEOUT_MS` (= 2000ms) for a slot; if none frees (or
   the queue is already full) they get the 503 + `Retry-After` above
   instead of waiting forever or deepening the load. Implemented by
   `ConcurrencyGate` (`src/libs/network/utils/concurrencyGate.ts`), a pure
   in-process counting semaphore with a bounded FIFO wait queue.

3. **Bounded work per request** — `limit` is hard-capped at 1000, the query
   projects only `pubkey` + `identities` columns, and pagination is keyset
   (PK seek) not offset, so no single request can pull the whole table into
   memory.

**Note on Bun workers:** workers were considered and deliberately *not*
used here. Workers (as in `txValidatorPool`) offload **CPU-bound** crypto
off the event loop. `/identities` is **I/O-bound** (a Postgres query) — the
event loop is already free while awaiting the DB, so a worker would add IPC
copy overhead, would not reduce DB load, and would give an attacker more
threads/memory to exhaust. The concurrency gate caps DB load directly,
which is the actual bottleneck.
