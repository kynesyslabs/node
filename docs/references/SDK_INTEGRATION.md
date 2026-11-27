---
type: reference
title: TLSNotary SDK Integration Guide
date: 2026-11-05
status: active
tags: [tlsnotary, sdk, requestTLSNproxy, paid-flow]
author: agent
---

# TLSNotary SDK Integration Guide

This document describes how an SDK client uses the node's TLSNotary proxy
endpoint (`requestTLSNproxy`) and the paid flow around it. It covers issues
#608 (endpoint reference) and #607 (paid flow).

The endpoint sections are taken from the node code at the commit named in
[Sources](#sources). The fee and `tlsn_store` statements use two sources: the
node code, and `@kynesyslabs/demosdk` `4.0.19` (the version pinned in
`package.json`), which was read as a published package and not run. Where the
code does not answer a question, the text says "not determined from the code".

## Overview

To attest an HTTPS request, a client does the following:

1. Sends a `tlsn_request` native transaction. The sender pays the access fee
   (plus the SDK's gas edit; see [Pricing](#pricing)).
   The node that handles the broadcast creates an attestation token locked to
   the target domain (see [Step 1](#step-1-pay-for-access-tlsn_request)).
2. Calls `requestTLSNproxy`, on the node that handled the broadcast, with the
   token ID, the token owner and the target URL. The node starts (or reuses) a `wstcp` WebSocket-to-TCP proxy for the
   target host and returns its URL.
3. Uses the proxy URL and the node's notary (see `tlsnotary.getInfo`) to
   perform the attestation with a TLSNotary prover such as `tlsn-js`.
   The node does not run the prover; this step happens in the client.
4. Optionally submits the proof and token ID in a `tlsn_store` native
   transaction using the SDK's `storeProof()`. The sender pays the storage
   fee (plus the same gas edit; see [Step 4](#step-4-store-the-proof-tlsn_store)).

## Calling a node endpoint

Node calls are JSON-RPC style POSTs to the node's RPC root, with method
`nodeCall` and one `params` entry. The outer envelope below is the one used by
`scripts/test-tlsnotary-proxy.ts` (lines 105-121). Do not copy that script's
`data`: it sends only `{ targetUrl }`, and the current handler would answer
`400 INVALID_REQUEST` because `tokenId` and `owner` are missing. The `data`
fields that `requestTLSNproxy` needs are listed [below](#request).

```typescript
{
  method: "nodeCall",
  params: [{
    message: "requestTLSNproxy",   // handler name
    data: { /* handler input */ },
    muid: "optional-message-id"
  }]
}
```

The reply is an RPC response. `result` is a numeric status (200 unless the
handler changes it) and `response` holds the handler output
(`manageNodeCall.ts` sets `result = 200` before calling the handler). An
unknown `message` returns `result: 404` with
`response: { error: "Unknown message", message: <name> }`.

## `requestTLSNproxy`

Requests a WebSocket-to-TCP proxy for the host in `targetUrl`. A valid,
unspent token is required.

### Request

`data` fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tokenId` | string | yes | Token ID, format `tlsn_<uuid>` |
| `owner` | string | yes | The `from` of the `tlsn_request` transaction exactly as signed. The SDK writes it as `0x` + hex (`build/websdk/demosclass.js:662`, `711-713`; `uint8ArrayToHex`, `build/encryption/unifiedCrypto.js:14-21`), and the node sets the token's owner from `tx.content.from` without normalising it (`handleGCR.ts:3242-3246`). Compared as a string with the token's owner, so a key sent without `0x` gets 403 `TOKEN_OWNER_MISMATCH` |
| `targetUrl` | string | yes | Must start with `https://` (case-sensitive prefix check) |
| `requestOrigin` | string | no | Base URL the node uses to build the proxy URL; falls back to `EXPOSED_URL`, then the node's exposed URL, then `ws://localhost:<port>` |

```typescript
{
  method: "nodeCall",
  params: [{
    message: "requestTLSNproxy",
    data: {
      tokenId: "tlsn_3f2c...",
      owner: "<owner public key>",
      targetUrl: "https://api.example.com/endpoint"
    },
    muid: "optional-message-id"
  }]
}
```

The handler checks `tokenId`/`owner` first, then `targetUrl`, then the
`https://` prefix, then the token, then it requests the proxy.

### Success response

`result: 200`. `response` is the proxy information plus two token fields:

```typescript
{
  result: 200,
  response: {
    websocketProxyUrl: "wss://node.example.com/tlsn/55123/",
    targetDomain: "api.example.com",
    expiresIn: 30000,        // milliseconds of idle time before cleanup
    proxyId: "uuid-here",
    tokenId: "tlsn_3f2c...",
    retriesLeft: 2
  }
}
```

- `websocketProxyUrl` form: for a `localhost` or `127.0.0.1` base it is
  `ws://<host>:<port>`. For any other base it is
  `wss://<host><path>/<port>/`, where `<path>` is the base URL path with
  trailing slashes removed, or `/tlsn` if empty (`buildWsUrl`,
  `proxyManager.ts:209-220`).
- `expiresIn` is `PORT_CONFIG.IDLE_TIMEOUT_MS`, 30000 ms. It is a
  milliseconds value, not seconds.
- `retriesLeft` is the token's remaining retries after this call.

A successful call consumes one token retry, including when an already-running
proxy for the same host and port is reused. Calls that return an error from
the proxy manager do not consume a retry.

A token starts with 3 retries; each successful call uses one.

### Error responses

Every error has the shape `{ error: <code>, message: <text> }` in
`response`, with the status in `result`.

| `result` | `error` | Cause |
|----------|---------|-------|
| 400 | `INVALID_REQUEST` | `tokenId` or `owner` missing ("Missing tokenId or owner parameter"), or `targetUrl` missing ("Missing targetUrl parameter") |
| 400 | `INVALID_URL` | `targetUrl` does not start with `https://` ("Only HTTPS URLs are supported for TLS attestation"). An `https://` URL that cannot be parsed gives 500 `INTERNAL_ERROR` instead (see the note below). The proxy manager also returns it when the host cannot be resolved (`proxyManager.ts:523-527`) |
| 404 | `TOKEN_NOT_FOUND` | No token with that ID on this node |
| 403 | `TOKEN_OWNER_MISMATCH` | `owner` differs from the token's owner |
| 403 | `TOKEN_EXPIRED` | Current time is past the token's `expiresAt`, or its status is already expired |
| 403 | `TOKEN_DOMAIN_MISMATCH` | Host of `targetUrl` differs from the token's locked domain. `response.domain` carries the locked domain |
| 403 | `TOKEN_EXHAUSTED` | Token status is exhausted |
| 403 | `TOKEN_ALREADY_STORED` | Token status is `stored` |
| 403 | `TOKEN_NO_RETRIES_LEFT` | `retriesLeft` is 0 or less (the token is marked exhausted at this point) |
| 403 | `TARGET_NOT_ALLOWED` | The target port is not in `TLSNOTARY_ALLOWED_PORTS` (default `443`), or, unless `TLSNOTARY_ALLOW_PRIVATE_TARGETS` is set (default off), the host, or any address it resolves to, is not a public unicast address: the refused ranges include private, loopback, link-local, shared (CGNAT), multicast, reserved, documentation and NAT64/6to4/Teredo addresses (`checkRelayTarget`, `proxyManager.ts:497-529`; `src/utilities/outboundAddress.ts:7-35`, `113-130`; `config/defaults.ts:236-237`) |
| 503 | `PORT_EXHAUSTED` | No free port in the proxy port range |
| 500 | `WSTCP_NOT_AVAILABLE` | `wstcp` is not installed and could not be installed, or the installed version is not the pinned one and the pinned reinstall failed (`ensureWstcp`, `proxyManager.ts:128-169`). The install runs `cargo install` inside the request, so it can be slow |
| 500 | `PROXY_SPAWN_FAILED` | Spawning failed after 3 attempts |
| 500 | `INTERNAL_ERROR` | Unexpected exception ("Failed to request TLSNotary proxy") |

Token errors other than `TOKEN_NOT_FOUND` use `result: 403`; the message is
`Token validation failed: <code>`. The checks run in this order: not found,
owner, expiry, domain, status (exhausted, expired, `stored`), retries.

Extra fields on proxy errors (from `proxyManager.ts`):

```typescript
// PROXY_SPAWN_FAILED
{ error: "PROXY_SPAWN_FAILED", message: "Failed to spawn proxy after 3 attempts",
  targetDomain: "api.example.com", lastError: "<last spawn error text>" }

// PORT_EXHAUSTED
{ error: "PORT_EXHAUSTED", message: "All ports in range 55000-57000 are exhausted",
  targetDomain: "api.example.com" }
```

The `PORT_EXHAUSTED` message text is fixed. The actual range can be changed
with `TLSNOTARY_PROXY_PORT_MIN` and `TLSNOTARY_PROXY_PORT_MAX`
(code defaults 55000 and 57000; `docker-compose.yml` sets 55000 and 55063), so
the text can differ from the real range.

A `targetUrl` that starts with `https://` but that `new URL()` rejects throws
inside token validation. The outer `try`/`catch` turns this into
`500 INTERNAL_ERROR`. This happens only after the earlier checks in
`validateToken` pass: the token exists (otherwise 404 `TOKEN_NOT_FOUND`), the
`owner` matches (otherwise 403) and the token is not expired (otherwise 403).
This comes from reading the code; it was not run.

### Request example (raw `nodeCall`)

```typescript
const MAX_RESPONSE_CHARS = 64 * 1024 // example cap; pick your own

async function requestProxy(
  nodeUrl: string,
  tokenId: string,
  owner: string,
  targetUrl: string,
) {
  const res = await fetch(nodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "nodeCall",
      params: [{
        message: "requestTLSNproxy",
        data: { tokenId, owner, targetUrl },
      }],
    }),
    signal: AbortSignal.timeout(10_000), // example deadline: 10 s
  })
  // The signal also covers the body read. Read text, stop at the cap, then parse.
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.length > MAX_RESPONSE_CHARS) {
      await reader.cancel()
      throw new Error("response too large")
    }
  }
  const body = JSON.parse(text)
  // A rejected envelope is an HTTP error with no `response`, and some replies
  // carry a string `response`; neither has an `error` field to read.
  if (!res.ok || typeof body?.response !== "object" || body.response === null) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (body.result !== 200) {
    // body.response.error is one of the codes in the table above
    throw new Error(`${body.response.error}: ${body.response.message}`)
  }
  return body.response // { websocketProxyUrl, targetDomain, expiresIn, proxyId, tokenId, retriesLeft }
}
```

Two kinds of reply do not have the `{ result, response: { error, message } }`
shape:

- A body that is not an RPC request gets HTTP 400 and
  `{ error: "Invalid request format. Not an RPCRequest" }`
  (`server_rpc.ts:477-481`); an unreadable body gets HTTP 400 and
  `{ error: "Invalid request format" }` (`server_rpc.ts:510-512`). Neither has
  `result` or `response`.
- If `manageNodeCall` throws, the RPC layer replies with `result: 500` and the
  string `response: "Error in nodeCall: "` (`rpcDispatch.ts:133-142`). It is
  sent with HTTP 200, so `res.ok` alone does not catch it.

## Other node calls used by the flow

### `tlsnotary.getInfo`

Request: `message: "tlsnotary.getInfo"`, `data: {}`.

Success (`result: 200`):

```typescript
{
  notaryUrl: "wss://node.example.com/tlsn/7047/",
  proxyUrl: "wss://node.example.com/tlsn/55688/",   // default proxy
  publicKey: "<hex public key>",
  version: "0.1.0"
}
```

`notaryUrl` and `proxyUrl` are built with the same `getPublicUrl` rules as
the proxy URL, from the notary port (default 7047) and
`tlsnotary.proxyPort` (default 55688). If the TLSNotary service is not
enabled or not running, the reply is `result: 503` with
`{ success: false, error: "TLSNotary service is not enabled or not running" }`.
Other failures return `result: 500` with `{ success: false, error: "Failed to get TLSNotary info" }`.

### `tlsnotary.getToken`

Looks up a token by `tokenId` or by the `txHash` of the payment transaction.
Use it to find the token ID after sending `tlsn_request`.

```typescript
data: { tokenId: "tlsn_..." }   // or: { txHash: "<hash>" }
```

Success: `response: { token: { id, owner, domain, status, expiresAt, retriesLeft } }`.
Errors: `400 INVALID_REQUEST` (neither field given), `404 TOKEN_NOT_FOUND`,
`500 INTERNAL_ERROR`. `tokenId` takes priority when both are given.

### `tlsnotary.getTokenStats`

`data` is not read. Success: `response: { stats: { total, byStatus } }`, where
`byStatus` has counts for `pending`, `active`, `completed`, `stored`,
`exhausted`, `expired`. Failure: `500 INTERNAL_ERROR`.

### HTTP routes

When `TLSNOTARY_ENABLED=true`, the node also registers `GET /tlsnotary/health`,
`GET /tlsnotary/info` and `POST /tlsnotary/verify` (`routes.ts`;
`server_rpc.ts:517`). Without it these routes do not exist. Their formats are
outside the scope of this guide.

## Paid flow

A token is required. `requestTLSNproxy` never creates one; it only validates
and uses one.

### Pricing

The node regenerates the expected GCR edits of a transaction with
`GCRGeneration.generate` from the SDK (`generateGcrEdits.ts:16`) and compares
them with the edits the transaction
carries (`verifyGcrEditsMatch`, called at `handleGCR.ts:1267`;
`handleValidateTransaction` regenerates at `endpointValidation.ts:38` and
compares hashes at `:85`, and once edit binding is active the verdict comes
from `verifyAdmissionEdits` instead, `:88-95`, which was not traced here). So
the TLSNotary fee a client is charged is the one the pinned SDK generates. In
`@kynesyslabs/demosdk` `4.0.19` (`build/websdk/GCRGeneration.js:333-347` and `350-366`), the
TLSNotary-specific deduction is:

| Operation | TLSNotary edit generated by the SDK |
|-----------|-------------------------------------|
| `tlsn_request` (access) | one `balance` `remove` of `1` DEM from the sender |
| `tlsn_store` (storage) | one `balance` `remove` of `1 + ceil(proof.length / 1024)` DEM from the sender |

The amounts are DEM, as the SDK generates them (`amount: 1` in
`GCRGeneration.js:343`). Once the `osDenomination` fork is active, the SDK
sends `balance` edit amounts as OS strings, with 1 DEM = 10^9 OS, so `1` DEM
is `"1000000000"` on the wire (`build/denomination/serializerGate.js:12-15`,
`127-131`), and the node's edit-binding check brings edits to that same shape
(`editBinding.ts:97-110`). The fork is active from height 0 by default
(`forkConfig.ts:560-561`; `data/genesis.json:12-14`). By contrast, the
`storageFee` in `StoreProofResponse` (see [SDK usage](#sdk-usage)) is a
`bigint` in OS.

This table is not the whole charge. For every transaction type except
`identity` and `d402_payment`, SDK `4.0.19` also adds a universal gas edit, a
`balance` `remove` of `1` from the sender, and a nonce edit
(`build/websdk/GCRGeneration.js:165-182`). `Demos.sign` adds them when it
builds the signed edits (`build/websdk/demosclass.js:714`). So the edits of a
`tlsn_request` transaction are two `balance` removals of `1` and a nonce add of
`1`, and those of a `tlsn_store` transaction with a short proof are removals of
`2` and `1` and a nonce add of `1`. The node adds up all `balance` removals
from the sender when it validates a transaction
(`endpointValidation.ts:137-150`) and applies the edits the transaction
carries (`handleGCR.ts:1582-1648`). A client that budgets only the table
amount can fail the balance check. The edit lists above were read from the SDK
code and were not run here. Other fork-dependent fees (see below) are not
covered.

The amounts in the table match the issue text (1 DEM access; 1 DEM base +
1 DEM/KB storage); the issue does not mention the gas edit. Details the issue
does not state:

- **KB rounding.** `proof.length` is the JavaScript string length, that is the
  number of characters (UTF-16 code units), not the UTF-8 byte length. It is
  rounded up in steps of 1024. A proof of 1 to 1024 characters costs `2`;
  1025 characters costs `3`. An empty proof costs `1`. A proof with non-ASCII
  characters is priced by its character count.
- **Not determined from the code:** whether the `gasFeeSeparation` fork changes
  these amounts for TLSNotary transactions. When the fork is active, the node
  also prepends fee edits computed from the transaction's `transaction_fee`
  (`verifyGcrEdits.ts:154-225`); how that interacts with the SDK's flat
  `1` was not traced. `DEFAULT_FORK_CONFIG` sets
  `gasFeeSeparation.activationHeight` to `0` (`forkConfig.ts:565-577`), while
  the `data/genesis.json` in this repo sets it to `null`. Genesis can override
  the default.
- Balance checks and any separate network gas fee for the transaction itself
  are not covered here (not determined from the files in Sources).

### Step 1: pay for access (`tlsn_request`)

The client sends a native transaction (`tx.content.type === "native"`) whose
data is `["native", { nativeOperation: "tlsn_request", args: [targetUrl] }]`.

- The token's domain is the hostname of `targetUrl` (port and path are not
  part of the lock). If `targetUrl` does not parse as a URL, `extractDomain`
  throws before a token is made (`handleGCR.ts:3238`). The caller catches and
  logs that error (`handleGCR.ts:1655-1663`), so no token exists for that
  transaction. Whether something else rejects such a transaction is not
  determined from the code. The SDK's `requestAttestation` rejects non-`https:`
  URLs before sending.
- The node that handles the broadcast creates the token and keeps it in
  memory only. Other nodes, including those that apply the block, do not
  create it. Call `requestTLSNproxy` on that node; another node returns 404
  `TOKEN_NOT_FOUND`.

Read the token with `tlsnotary.getToken` (by `txHash`) to get its ID.

### Step 2: get the proxy (`requestTLSNproxy`)

See [above](#requesttlsnproxy). Up to 3 retries per token. Send the call to the
node that handled the broadcast.

### Step 3: attest

Use `websocketProxyUrl` and the `notaryUrl` from `tlsnotary.getInfo` with
the TLSNotary prover in the client. The proxy is eligible for cleanup after
30 s idle (killed lazily on a later request), so start the attestation right
after the call. The node's `TLSNOTARY_MAX_SENT_DATA` and
`TLSNOTARY_MAX_RECV_DATA` (defaults 16384 and 65536 bytes) apply only with
`TLSNOTARY_MODE=ffi` (`TLSNotaryService.ts:392-396`). In the default `docker`
mode the node does not run the notary (`TLSNotaryService.ts:341-344`); the
notary container's limits apply. Its sent limit is `TLSNOTARY_MAX_SENT_DATA`
with Docker Compose (default 32768, `docker-compose.yml:89`) and a fixed 32768
with `./run` (`tlsnotary/docker-compose.yml:17`, started at
`scripts/run:937-949`). This repo sets no receive limit for the container.

### Step 4: store the proof (`tlsn_store`)

The client calls the SDK's `storeProof(tokenId, proof, { storage: storageType })`
to submit a native transaction whose data is
`["native", { nativeOperation: "tlsn_store", args: [tokenId, proof, storageType] }]`.

- `tokenId`: the ID of the attestation token, referencing the token from
  the access request.
- `proof`: the proof as a string.
- `storageType`: the SDK's `StoreProofOptions.storage` is
  `"onchain" | "ipfs"`.

These fields are defined by SDK `4.0.19`'s
`build/tlsnotary/TLSNotaryService.d.ts:107-110`, `:318` and
`build/tlsnotary/TLSNotaryService.js:585-607`. The SDK computes the storage
price as 1 DEM base + 1 DEM per KB: `1 + ceil(proof.length / 1024)` DEM, where
`proof.length` counts UTF-16 code units (`build/websdk/GCRGeneration.js:351-357`).
It adds a gas removal of `1` on top (`build/websdk/GCRGeneration.js:165-182`;
see [Pricing](#pricing)).

## Token lifecycle

A token is an in-memory record (`tokenManager.ts`), kept in shared state.
It is not persisted: a node restart drops all tokens (the store is a `Map`
created at first use; no database code is involved).

Fields: `id` (`tlsn_<uuid>`), `owner`, `domain`, `status`, `createdAt`,
`expiresAt`, `retriesLeft`, `txHash`, `proxyId` (set once a proxy is linked).

Constants: expiry 30 minutes from creation; 3 retries; cleanup sweep every
minute.

| Status | Meaning | Code reference |
|--------|---------|--------|
| `pending` | Created, not used | `createToken` |
| `active` | Proxy requested | `consumeRetry`, on each successful `requestTLSNproxy` |
| `completed` | Attestation successful | `markCompleted` |
| `stored` | Defined token status value | `TokenStatus.STORED` (`tokenManager.ts:31`) |
| `exhausted` | No retries left | `validateToken`, when `retriesLeft <= 0` |
| `expired` | Past `expiresAt` | `validateToken`, when called after expiry |

Transitions as the code performs them:

```
tlsn_request broadcast ──> pending
requestTLSNproxy ok     ──> active   (retriesLeft - 1, proxyId set)
```

Notes:

- `markCompleted` is defined but no code in `src` calls it, so in this
  commit a token does not reach `completed`.
- After the third sequential successful `requestTLSNproxy`, `retriesLeft` is 0
  and the status is still `active`. The next `requestTLSNproxy` call returns
  `TOKEN_NO_RETRIES_LEFT` and sets the status to `exhausted`; later calls
  return `TOKEN_EXHAUSTED`.
- A `requestTLSNproxy` call made after `expiresAt` sets the status to
  `expired`, and one made with `retriesLeft` at 0 sets it to `exhausted`
  (`tokenManager.ts:178-180`, `201-203`).
- The domain lock compares hostnames only. A token for `api.example.com`
  cannot be used for `other.example.com`, but the URL's port is not part of
  the lock.
- Expiry is checked in `requestTLSNproxy`. The cleanup sweep deletes tokens past `expiresAt` unless their status is
  `stored`, so a token is deleted about 30 to 31 minutes after creation unless
  its status is `stored`; the sweep never deletes a token with status `stored`.
- Fees are not refunded when a token expires or runs out of retries.
  The code has no refund path (not found in the files listed in Sources).

## Proxy lifecycle

1. **Creation.** If no live proxy exists for `host:port`, a `wstcp` process
   is spawned on a free port in the range 55000 to 57000 by default; Docker
   sets 55000 to 55063 (`TLSNOTARY_PROXY_PORT_MIN` /
   `TLSNOTARY_PROXY_PORT_MAX`). Up to 3 spawn
   attempts are made; each has a 5 s start timeout.
2. **Reuse.** A later request for the same `host:port` can get the running
   proxy; it resets its idle timer.
   This uses a token retry.
3. **Activity.** Output on the `wstcp` process resets the 30 s idle timer.
4. **Cleanup.** Idle proxies (more than 30 s) are killed lazily, on the next
   `requestTLSNproxy` that gets past the `wstcp`, URL and target checks in the
   proxy manager (`proxyManager.ts:543-575`). The ports of the proxies it
   kills are released for reuse.
5. **Restart.** Proxy state is in memory only; it is not persisted.

The upstream port is the explicit port in `targetUrl`, else 443. The port must
be listed in `TLSNOTARY_ALLOWED_PORTS`, which defaults to `443` only;
otherwise the call returns 403 `TARGET_NOT_ALLOWED`
(`proxyManager.ts:497-509`, `config/defaults.ts:236`).

## SDK usage

### `TLSNotaryService.requestAttestation()` and `storeProof()`

`@kynesyslabs/demosdk` `4.0.19` (the version pinned in `package.json`)
exports `TLSNotaryService` from `@kynesyslabs/demosdk/tlsnotary`. The
signatures below are from its `build/tlsnotary/TLSNotaryService.d.ts`; the
flow is from `build/tlsnotary/TLSNotaryService.js`. This was read from the
published package, not run, and nothing was sent to a network.

```typescript
requestAttestation(options: RequestAttestationOptions): Promise<AttestationTokenResponse>
storeProof(tokenId: string, proof: string, options: StoreProofOptions): Promise<StoreProofResponse>
```

- `RequestAttestationOptions`: `targetUrl: string` (an HTTPS URL; the SDK
  throws for any other protocol) and an optional `nonce`.
- `AttestationTokenResponse`: `proxyUrl`, `tokenId`, `expiresAt`,
  `retriesLeft`, `txHash`.
- `StoreProofOptions`: `storage: "onchain" | "ipfs"` and an optional `nonce`.
- `StoreProofResponse`: `txHash`, `storageFee` (a `bigint` in OS),
  `broadcastStatus`, optional `broadcastMessage`.

What `requestAttestation` does in 4.0.19:

1. Builds and signs a `native` transaction to the sender's own address with
   `nativeOperation: "tlsn_request"` and `args: [targetUrl]`, then confirms
   and broadcasts it. It throws if the broadcast result is not `200`.
2. Polls `nodeCall` `tlsnotary.getToken` with `{ txHash }`, up to 30 times
   with 1 second between attempts, until the reply has `token.id`. It throws
   if no token appears.
3. Calls `requestTLSNproxy` with `{ tokenId, owner, targetUrl }`, where
   `owner` is the hex encoding of the wallet's ed25519 public key. This
   matches the token's owner (the `from` of the `tlsn_request` transaction)
   only when the wallet uses the default `ed25519` algorithm; with `falcon` or
   `ml-dsa` the proxy request is refused with 403 `TOKEN_OWNER_MISMATCH`. It
   throws if the reply has no `websocketProxyUrl`.
4. Returns `proxyUrl` (the `websocketProxyUrl`), `tokenId`, `txHash`,
   `retriesLeft` (the reply's value, else `3`) and `expiresAt`
   (`Date.now()` plus the reply's `expiresIn`, else 30000).

`storeProof` builds and signs a `native` transaction to the sender's own
address with `nativeOperation: "tlsn_store"` and
`args: [tokenId, proof, storage]`, then confirms and broadcasts it. The request
fields and SDK price are described in
[Step 4](#step-4-store-the-proof-tlsn_store).

The same file also has `requestAttestationWithConfirmation`,
`createTLSNotary` (returns a `TLSNotary` instance already configured with the
proxy, plus `tokenId`, `proxyUrl`, `expiresAt` and `requestTxHash`),
`storeProofWithConfirmation`, `getToken` and `getTokenByTxHash`. They are not
covered further here.

### Example

```typescript
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { TLSNotaryService } from "@kynesyslabs/demosdk/tlsnotary"

const demos = new Demos()
await demos.connect("<node RPC URL>")
await demos.connectWallet("<mnemonic>")

const service = new TLSNotaryService(demos)

// Pays for access, waits for the token, gets the proxy.
const { proxyUrl, tokenId, txHash } = await service.requestAttestation({
  targetUrl: "https://api.github.com/users/octocat",
})

// Run the TLSNotary prover against proxyUrl and the node's notary
// (see tlsnotary.getInfo). Not covered by this repo.
const proof: string = "<serialized proof from the prover>"

// TLSNotary storage deduction: 1 + ceil(proof.length / 1024), plus the
// SDK's gas removal of 1 (see Pricing).
const stored = await service.storeProof(tokenId, proof, { storage: "onchain" })
console.log(stored.txHash, stored.broadcastStatus)
```

The `Demos` calls (`connect`, `connectWallet`) are copied from the usage
example in the `.d.ts` header comment of `TLSNotaryService.d.ts`; their
arguments here are placeholders. The `.d.ts` examples serialize
the prover's `result.presentation` with `JSON.stringify` before calling
`storeProof`; the prover step itself is outside this guide.

## Configuration

| Variable | Used for | Default |
|----------|----------|---------|
| `TLSNOTARY_ENABLED` | `true` starts the node's TLSNotary service (`index.ts:1079`; in the default `docker` mode it connects to a notary container started by Compose or `./run`) and registers the `/tlsnotary/*` HTTP routes (`server_rpc.ts:517`) | Code: `false` (`config/defaults.ts:104`). `docker-compose.yml:231` and `.env.example:368`: `true` |
| `TLSNOTARY_DISABLED` | `true` disables the service | `false` |
| `TLSNOTARY_PORT` | Notary port | `7047` |
| `TLSNOTARY_MAX_SENT_DATA` / `TLSNOTARY_MAX_RECV_DATA` | Notary data limits in bytes. The node reads them only with `TLSNOTARY_MODE=ffi`. With Docker Compose, `TLSNOTARY_MAX_SENT_DATA` also sets the notary container's sent limit (default `32768`); see Step 3 | `16384` / `65536` (node) |
| `TLSNOTARY_PROXY_PORT_MIN` / `TLSNOTARY_PROXY_PORT_MAX` | Port range for `wstcp` proxies | Code: `55000` / `57000`. `docker-compose.yml:245-246`: `55000` / `55063` (64 ports) |
| `TLSNOTARY_ALLOWED_PORTS` | Target ports a proxy may relay to | `443` |
| `TLSNOTARY_ALLOW_PRIVATE_TARGETS` | `true` skips the address check, so non-public targets are allowed (see the `TARGET_NOT_ALLOWED` row) | `false` |
| `EXPOSED_URL` | Base for public URLs when the request gives no `requestOrigin` | Code: not set. `docker-compose.yml:171`: `http://localhost:53550` |

## Error handling notes

- `TOKEN_NOT_FOUND` can mean the token was never created on this node, has
  expired and been swept, or the node restarted.
- `PORT_EXHAUSTED` and `PROXY_SPAWN_FAILED` do not consume a retry, so the
  call can be repeated with the same token.
- `INVALID_URL` for a non-`https://` URL is returned before the token is
  checked, so no retry is consumed.
- Retry behaviour beyond the node's 3 spawn attempts is a client decision;
  the code gives no guidance.

## Sources

Commit `8185f2f557045456e61c5868b2b51977c21252f8`, branch `stabilisation`.
Every `file:line` citation in this guide was re-read at that commit. The
previous version of this file was
`src/features/tlsnotary/SDK_INTEGRATION.md`, deleted in `bff37bbe`. This
version is written from the current code, not from that one. It now lives in
`docs/references/` because `.gitignore` line 86 (`src/**/*.md`) ignores
Markdown files under `src/`.

- `src/libs/network/handlers/tlsnotaryHandlers.ts` — `requestTLSNproxy`
  (lines 6-108), `tlsnotary.getInfo` (110-153), `tlsnotary.getToken`
  (155-207), `tlsnotary.getTokenStats` (209-227)
- `src/libs/network/handlers/index.ts:22` — handler registration
- `src/libs/network/manageNodeCall.ts` — default `result = 200` (24), unknown
  message 404 (38)
- `src/libs/network/rpcDispatch.ts:127-144` — `nodeCall` method; `:133-142`
  error reply
- `src/libs/network/server_rpc.ts:445-514` — main RPC endpoint
  (malformed-envelope replies at 477-481 and 510-512)
- `src/features/tlsnotary/tokenManager.ts` — token fields, statuses (27-34),
  `TOKEN_CONFIG` (lines 18-22), `createToken` (115-141), `validateToken`
  (160-207), `consumeRetry` (216-240), `cleanupExpiredTokens` (312-329)
- `src/features/tlsnotary/proxyManager.ts` — `ProxyError` (56-62),
  `ensureWstcp` (128-169), `buildWsUrl` (209-220), `getPublicUrl` (228),
  `checkRelayTarget` (497-529), `requestProxy` (539-647)
- `src/utilities/outboundAddress.ts:7-35`, `113-130` — refused address ranges
  and the resolve-and-check step (`resolvePublicAddress`)
- `src/config/defaults.ts:236-237` — `TLSNOTARY_ALLOWED_PORTS` and
  `TLSNOTARY_ALLOW_PRIVATE_TARGETS` defaults
- `src/features/tlsnotary/constants.ts` — `PORT_CONFIG` (51-68),
  `TOKEN_CONFIG` (77-84), notary defaults (27-33)
- `src/libs/blockchain/validation/generateGcrEdits.ts:16`,
  `src/libs/blockchain/validation/verifyGcrEdits.ts:126-225`,
  `src/libs/blockchain/gcr/handleGCR.ts:1267` (edit apply loop at
  `1582-1648`), `src/libs/network/endpointValidation.ts:38`, `:85`, `:137-150`
  — the node regenerates a transaction's GCR edits with the SDK's
  `GCRGeneration.generate` and compares
- `@kynesyslabs/demosdk` `4.0.19`, `build/websdk/GCRGeneration.js:165-182` and
  `333-347` and `350-366` — the gas and nonce edits and the `tlsn_request` and `tlsn_store`
  edits; `build/websdk/demosclass.js:662`, `711-714` — `from` with `0x` and
  the edit generation in `sign`; `build/encryption/unifiedCrypto.js:14-21` —
  `uint8ArrayToHex`; `build/tlsnotary/TLSNotaryService.d.ts` and `.js` —
  `requestAttestation`, `storeProof` (read from the published package, not
  run); `build/tlsnotary/TLSNotaryService.js:116-118` — `owner` from the
  `ed25519` identity; `build/websdk/demosclass.js:44-57` — the `keypair`
  getter, which follows the connected algorithm (default `ed25519`, line 60).
  `4.0.17` was read as well: `TLSNotaryService.js`, `.d.ts` and
  `unifiedCrypto.js` are identical in both versions, and `GCRGeneration.js`
  and `demosclass.js` differ only outside the cited line ranges (storage
  program edits from line 602 in `GCRGeneration.js`; comments from line 1331
  in `demosclass.js`)
- `src/libs/blockchain/gcr/handleGCR.ts:1655-1663` and `:3221-3251` — token
  creation; `:1853-1858` — block application
- `src/libs/consensus/v2/PoRBFT.ts:1019`,
  `src/libs/blockchain/routines/Sync.ts:1762-1791` — consensus and sync apply
  blocks through `applyTransactions`
- `src/forks/forkConfig.ts:552-577`, `data/genesis.json:12-18` — fork
  activation values
- `src/features/tlsnotary/routes.ts:216-224` — HTTP routes
- `src/features/tlsnotary/TLSNotaryService.ts:164-222` — environment
  variables
- `scripts/test-tlsnotary-proxy.ts:105-121` — `nodeCall` request shape
- `package.json:124` — SDK pin `@kynesyslabs/demosdk` `4.0.19` (also in
  `overrides`, line 196)
