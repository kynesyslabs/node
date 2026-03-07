# Research: how to run Demos Node for steady-state perf testing

Goal: establish a repeatable way to run a **multi-node** Demos Network locally so we can measure:
- **steady-state TPS** (requests/txs/messages per second sustained without degradation)
- **message responsiveness** (end-to-end latency distribution p50/p95/p99 for “messages”)

This document is intentionally “ops/bench harness” focused (no new tests yet).

---

## 0) Current status (phased roadmap)

We’re keeping all harness code in `better_testing/` so we can iterate without touching node runtime code.

### Phase 1 — RPC baseline (DONE)
- Implemented a Bun load generator that POSTs JSON-RPC-style calls to the node RPC `POST /` and reports RPS + p50/p95/p99.
- Intended usage: run as a `loadgen` container inside the devnet docker network via overlay compose.

Artifacts:
- `better_testing/loadgen/src/rpc_loadgen.ts`
- `better_testing/loadgen/src/main.ts` (`SCENARIO=rpc|transfer`)
- `better_testing/docker-compose.perf.yml`
- `better_testing/loadgen/README.md`

### Phase 2 — Native transfer TPS (IN PROGRESS)
- Implemented a transfer load generator using the SDK path (`confirmTx` + `broadcastTx`) to exercise the real client surface.
- Current blocker: the devnet nodes are currently crashing during genesis insertion with:
  - `QueryFailedError: null value in column "from_ed25519_address" of relation "transactions" violates not-null constraint`
  - This makes RPC intermittently unavailable (loadgen sees `ECONNREFUSED` / high network error rates).
  - Likely root cause: genesis transaction content lacks `from_ed25519_address` (see `src/libs/blockchain/chain.ts` `generateGenesisBlock()`), but the `transactions` table/entity requires it (see `src/model/entities/Transactions.ts`).

Artifacts:
- `better_testing/loadgen/src/transfer_loadgen.ts`

### Phase 2.1 — Ramp + hygiene (DONE)
- Added a `transfer_ramp` scenario to quickly sweep concurrency and spot the knee point.
- Added scenario hygiene knobs:
  - `AVOID_SELF_RECIPIENT=true` (default) to avoid self-send skew
  - `INFLIGHT_PER_WALLET` to increase load even with a small wallet pool
  - `QUIET=true` (default) to suppress noisy dependency logs so results are readable
- Added run artifacts for dashboarding:
  - `better_testing/runs/<RUN_ID>/transfer.summary.json`
  - `better_testing/runs/<RUN_ID>/transfer.timeseries.jsonl` (per-second JSONL points)

### Phase 3 — IM “message responsiveness” (NEXT)
- Add a WebSocket IM load generator (online + offline paths) using the SDK implementation so we can measure message latency distributions under load.

### Phase 4 — Observability + dashboard (NEXT)
- Add a simple dashboard/reporting layer to compare runs (time series TPS/latency + node metrics + run metadata).

### Note on “no node modifications”
The benchmark harness itself lives entirely in `better_testing/`, but devnet/docker tooling may still require occasional repo-level hygiene fixes to run reliably (e.g., `.dockerignore` to avoid accidentally sending local runtime state into the Docker build context). This does not change node behavior; it only prevents build failures.

---

## 1) What “running the node” means in this repo

### Primary entrypoint
- Runtime entrypoint: `src/index.ts`
  - Starts the **HTTP RPC server** (`serverRpcBun()` in `src/libs/network/server_rpc.ts`)
  - Bootstraps chain, peers, and background loops
  - Starts additional services when conditions/config allow:
    - **Signaling Server (IM WebSocket)**: `new SignalingServer(port)` in `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts`
    - **OmniProtocol server**: `startOmniProtocolServer(...)` in `src/libs/omniprotocol/integration/startup`
    - **Metrics server + collector**: `src/features/metrics/*` exposed at `/metrics`
    - **MCP server**: `src/features/mcp` (optional; enabled by default unless `MCP_ENABLED=false`)
    - **TLSNotary**: `src/features/tlsnotary` (optional; default disabled)

### Two “runner” modes

1) Local runner: `./run`
   - High-level script that can manage local postgres, monitoring stack, etc.
   - Supports `--no-tui` for non-interactive logging.

2) Devnet (recommended for performance research): Docker Compose
   - `devnet/docker-compose.yml` starts:
     - 1 Postgres container with 4 DBs
     - 4 node containers on a single docker bridge network
   - Node containers run `./devnet/run-devnet` as entrypoint (see `devnet/Dockerfile`)
   - Devnet uses **external DB** (postgres container), and disables the TUI (legacy logs).

Why devnet for perf work:
- deterministic topology (4 nodes, shared network, shared DB) without needing 4 machines
- lets us add a **loadgen container inside the same docker network**, avoiding host NAT noise

---

## 2) Runtime topology and ports (devnet)

From `devnet/docker-compose.yml`:
- Node i:
  - HTTP RPC port: `${NODEi_PORT}` (defaults 53551..53554)
  - OmniProtocol port: `${NODEi_OMNI_PORT}` (defaults 53561..53564)
  - `EXPOSED_URL=http://node-i:${NODEi_PORT}` inside the docker network
- Postgres:
  - internal service name: `postgres:5432`
  - DB names: `node1_db`, `node2_db`, `node3_db`, `node4_db` (created by `devnet/postgres-init/init-databases.sql`)

Important service ports started by `src/index.ts`:
- **Signaling server** (IM WebSocket): defaults to 3005, and is auto-bumped to next available port
  - In devnet, each container has its own network namespace, so all 4 nodes can bind to `3005` internally without collisions.
  - Devnet does **not** publish `3005` to the host, so any IM benchmark should run from inside docker network (recommended) or we must expose it.
- **Metrics server**: defaults to 9090 (and is auto-bumped to next available port)
  - Devnet does **not** publish metrics ports by default, so scraping should also happen from inside docker network (recommended).

---

## 3) What counts as a “message” here (and how to exercise it)

There are (at least) two relevant “message” paths:

### A) Instant Messaging Protocol (SignalingServer over WebSocket)
- Server: `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts`
- Registers peers and forwards encrypted messages between them.
- Registration requires a cryptographic proof:
  - `register` payload includes `verification: SerializedSignedObject`
  - Server verifies via `ucrypto.verify(...)`

Practical client implementation already exists in the SDK:
- `node_modules/@kynesyslabs/demosdk/build/instant_messaging/index.js`
  - `registerAndWait()` builds the `SerializedSignedObject`
  - `sendMessage(targetId, message)` encrypts using `ml-kem-aes` and sends `type:"message"`

For responsiveness benchmarks, this is the cleanest “message loop” because it has:
- a single hop (client -> node signaling server -> peer client) when both online
- an offline path (store in DB + blockchain write) when recipient is offline

### B) Node RPC (HTTP) request/response path
- Server: `src/libs/network/server_rpc.ts`
- Protocol: POST payload with `{ method, params }`, e.g. `ping`, `nodeCall`, `mempool`, etc.
- This is useful for baseline throughput/latency without WebSocket encryption overhead.

---

## 4) How I plan to run the system for perf research

### 4.1 Baseline: bring up the 4-node devnet

```bash
cd devnet
./scripts/setup.sh              # generate identities + peerlist (if needed)
docker compose up -d --build
docker compose logs -f node-1   # watch for “Signaling server started”
```

“Ready” signals (log-based, since compose has no node healthchecks):
- `[NETWORK] Signaling server started`
- `[METRICS] Prometheus metrics server started on http://0.0.0.0:<port>/metrics`
- Peer bootstrap has completed and node is not stuck “listening…”

### 4.2 Stabilize config for benchmarking (reduce noise)

For performance runs (not correctness):
- disable features that add overhead but aren’t part of the benchmark:
  - `MCP_ENABLED=false` (unless you are benchmarking MCP)
  - `TLSNOTARY_ENABLED=false` (already default)
- reduce logging volume:
  - pass `log-level=warning` or `log-level=error` via args (supported in `src/index.ts` argument digest)

Note: devnet currently runs `bun start:bun` (TS entrypoint). For *benchmark stability*, a production bundle could be introduced later, but first we need repeatable measurements.

### 4.3 Add a load generator inside the docker network (key step)

Rationale:
- If we run load from the host, we measure host->docker NAT + scheduling noise.
- If we run load inside docker network, we measure the node + protocol path more directly.

Plan:
- Add a `loadgen` container service attached to `demos-network`.
- The loadgen uses the existing SDK instant messaging client to:
  1) Connect N clients to `ws://node-1:3005` (or the configured signaling port)
  2) `registerAndWait()` each client
  3) Send messages at controlled rates and measure:
     - time from send -> receive/ack
     - sustained throughput before latency “knees”
  4) Repeat for offline path by intentionally disconnecting the receiver

Metrics captured:
- client-side latency histogram (p50/p95/p99)
- server-side resource metrics from `/metrics` (CPU, mem, peer count, etc.)

---

## 5) Benchmark scenarios (progressive)

### Scenario 0: “is the harness stable?”
- 4 nodes running, 1 loadgen with 10 IM clients, low rate (e.g. 1 msg/sec each)
- verify no disconnect storms, no DB errors, no runaway logs

### Scenario 1: Online IM latency vs throughput
- 2 cohorts: senders + receivers online
- ramp msg rate (step or linear) until p99 latency spikes or errors rise
- record plateau throughput and knee point

### Scenario 2: Offline message path stress
- receivers offline
- senders enqueue messages (SignalingServer stores to DB + writes tx to blockchain path)
- measure enqueue TPS and DB growth behavior
- then bring receiver online and measure “catch-up” drain latency

### Scenario 3: RPC baseline
- high-rate `ping` or a light `nodeCall` (no heavy crypto/DB)
- establishes upper bound for HTTP request handling throughput

---

## 6) Observability plan (minimal, then richer)

### Minimal (works immediately)
- `docker compose logs -f node-1` (watch errors, restarts, peer churn)
- client-side loadgen metrics printed periodically (QPS, p50/p95/p99)

### Better (recommended next)
- run Prometheus/Grafana in the same docker network:
  - either attach the monitoring stack to `demos-network`, or run a dedicated compose for perf experiments.
- scrape each node’s `/metrics` endpoint from within docker network (no need to publish ports).

---

## 7) Known intricacies / risks for perf measurement

- **Signaling server port is not published in devnet compose**:
  - we should benchmark IM from inside docker network (loadgen service).
  - if benchmarking from host, we must expose `3005` (or actual port) per node.
- **Metrics port is auto-bumped**:
  - node uses “next available port” logic; in docker it’s stable, but if multiple metrics servers run in the same namespace it may drift.
  - for scraping, prefer docker-network DNS + known port conventions.
- **Registration proof requirement**:
  - do not hand-roll the proof; use the SDK `registerAndWait()` implementation.
- **Noise from logging/TUI**:
  - TUI is already disabled in devnet; still reduce log level for perf runs.

---

## 8) Next actions (not implemented yet)

1) Make devnet RPC reachability deterministic for `loadgen` (Phase 2 unblock)
   - Confirm whether RPC listens on `0.0.0.0` inside the container (not `127.0.0.1` only).
   - Add “wait for RPC ready” logic in loadgen (retry/backoff + explicit diagnostics).
2) Run the first transfer baseline sweep (Phase 2 deliverable)
   - Start with low concurrency and short duration, then ramp.
   - Emit time-series samples (per-second TPS + p95/p99) to make the knee point obvious.
3) Decide the canonical “message responsiveness” target for the next scenario (Phase 3)
   - IM WS (client ↔ node) vs OmniProtocol (node ↔ node) vs HTTP RPC.
4) Add IM loadgen (Phase 3)
   - Online path: sender → signaling server → receiver.
   - Offline path: sender enqueues to DB/chain, receiver later drains.
5) Add dashboard scaffolding (Phase 4)
   - At minimum: a run folder with `run.json` + `timeseries.jsonl` + a small HTML plot (or Grafana).

### Direction: an intuitive testing dashboard (recommended)

Once the harness exists, the natural next step is a small “perf dashboard” that makes runs easy to interpret and compare:
- A Grafana dashboard (or a lightweight local HTML report) showing:
  - throughput over time
  - p50/p95/p99 latency over time
  - error rate / disconnect rate
  - queue depth / offline-message backlog (if applicable)
  - CPU / memory / GC pressure (from `/metrics`)
- A “run metadata” panel (git SHA, scenario, rates, node counts, env flags) so results are reproducible.

---

## [CLARIFICATION REQUIRED]

Context: “message responsiveness to messages”
Ambiguity: Should we benchmark:
1) IM SignalingServer WebSocket messages (client->server->client), or
2) Node RPC throughput/latency, or
3) OmniProtocol P2P message latency/throughput?
Options: (1) is easiest to control + already has SDK client; (3) is closest to node-to-node but requires protocol-specific loadgen.
Blocking: NO (I can start with IM WebSocket as baseline unless you say otherwise).

## Questions for you to answer (to lock the benchmark spec)

1) Which path is the primary “message responsiveness” KPI?
   - IM SignalingServer WS (client ↔ node) vs OmniProtocol (node ↔ node) vs HTTP RPC
2) What is the desired success metric?
   - e.g. “p99 < 200ms at 1k msgs/sec”, “no message loss”, “max TPS before p99 > 1s”, etc.
3) What payload size should we use for “messages”?
   - e.g. 256B / 1KB / 16KB (encrypted payload sizes matter)
4) How should we define “delivered” for measurement?
   - “receiver got WS message” vs “receiver ACKed application-level receipt” vs “persisted to DB/chain”
5) Should the benchmark include the offline path (DB + blockchain write) or online-only?
6) How many nodes / peers should the harness assume by default?
   - devnet 4 nodes is the baseline; do you want N configurable?
7) Do you want the harness to run fully inside docker (recommended) or from host as well?

---

## Answers captured (this chat)

These answers are recorded here so the harness can be implemented deterministically:

1) KPI focus
- Balanced, but prioritize **TPS** (responsiveness still tracked via latency percentiles).

2) Success metric target
- No fixed target yet; first produce baseline results, then set thresholds based on observed curves.

3) Payload sizes
- Define **multiple tests and payload sizes per transaction type** (a small test matrix), rather than a single “message size”.

4) “Delivered” definition
- Varies by test; choose what is appropriate per scenario (e.g., WS receive vs app-level ACK vs persistence).

5) Offline path
- Include **both online + offline** paths (offline = DB + blockchain write path where applicable).

6) Scale
- N configurable, **default 4** (devnet baseline).

7) Execution environment
- Prefer running fully **inside Docker** (internal network) for stable measurements.

General sequencing note:
- Start with core/native transaction types (e.g., **transfer**) and baseline RPC/chain paths first.
- More complex protocols/features (e.g., advanced messaging modes) come later.

---

## IM WS (online) loadgen — implemented

### Root cause (why `im_online` was 0 ok / 100% timeouts)

The IM signaling server’s online path calls `storeMessageOnBlockchain(...)` on every message.
In devnet, it was throwing:
- `[Signaling Server] Private key not available for message signing`

Reason: it attempted to read `getSharedState.identity.ed25519.privateKey`, which isn’t populated in the devnet runtime (even though the node can still sign via the active `ucrypto` identity / `getSharedState.keypair`).

### Fix

`src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts` now:
- signs the IM tx with `ucrypto.sign(getSharedState.signingAlgorithm, tx.hash)`
- stores a normal `ISignature` `{ type, data }`
- uses the node’s `getSharedState.publicKeyHex` as the tx `from` signer (and records the peer `senderId` in tx `data`)

### Scenarios

- `SCENARIO=im_online` (steady-state latency + ok TPS)
- `SCENARIO=im_online_ramp` (sweep `IM_PAIRS` over `RAMP_PAIRS`)

Key env:
- `IM_PAIRS` (default: 1)
- `INFLIGHT_PER_SENDER` (default: 1)
- `IM_MESSAGE_BYTES` (default: 128)
- `RATE_LIMIT_RPS` (default: 0 = no cap)
- `IM_LOG_EVENTS` (default: false; when true writes `im_online.log.jsonl`)

### Baseline results (devnet, 4 nodes)

Run: `im-online-fix1-20260226-154137`
- `IM_PAIRS=2`, `INFLIGHT_PER_SENDER=10`, `IM_MESSAGE_BYTES=64`, `DURATION_SEC=10`
- ok TPS: ~147.9
- latency p50/p95/p99: ~105ms / ~196ms / ~657ms

Ramp: `im-online-ramp-fix1-20260226-154224` (`INFLIGHT_PER_SENDER=20`, `IM_MESSAGE_BYTES=64`, step=8s)
- best ok TPS: ~262.9 @ `IM_PAIRS=4` (p95 ~395ms)

---

## Token consensus consistency scenario (cross-node)

New scenario: `SCENARIO=token_consensus_consistency`

What it does:
- bootstraps a fresh token (unless `TOKEN_BOOTSTRAP=false`)
- executes a small token tx bundle (transfer + mint + burn) on one node
- waits for **N consensus rounds** across all nodes (`CONSENSUS_ROUNDS`, default 1) using `nodeCall getLastBlockNumber`
- polls all nodes until token snapshots match (`token.get` + `token.getBalance`) and asserts expected deltas

Example run:
- `better_testing/runs/token-consensus-20260227-151903/token_consensus_consistency.summary.json`

---

## Token read/query coverage scenario (cross-node)

New scenario: `SCENARIO=token_query_coverage`

What it does:
- bootstraps + distributes a token to up to 4 devnet wallets (as configured by `WALLET_FILES`)
- asserts read APIs behave consistently across *all* nodes:
  - `token.get` (metadata/state)
  - `token.getBalance` (for each wallet)
  - `token.getHolderPointers` (presence matches balance>0)
  - `token.callView` returns `NO_SCRIPT` when `hasScript=false`
  - `token.get` returns 404 for a missing token address
- also runs a `waitForCrossNodeTokenConsistency` snapshot convergence poll

Example run:
- `better_testing/runs/token-query-20260227-152442/token_query_coverage.summary.json`

---

## Token ACL matrix scenario (grant/revoke + cross-node)

New scenario: `SCENARIO=token_acl_matrix`

What it does:
- bootstraps + distributes a token
- asserts unauthorized mint is rejected (no state change)
- owner grants `canMint` to a grantee, waits consensus, asserts ACL entry is present
- grantee mints successfully, waits consensus, asserts supply/balances update
- owner revokes `canMint`, waits consensus, asserts ACL entry removed
- asserts mint is rejected again
- asserts non-owner cannot grant permissions
- polls for cross-node convergence (`token.get` + `token.getBalance`)

Example run:
- `better_testing/runs/token-acl-matrix-20260227-145423/token_acl_matrix.summary.json`

Note:
- `@kynesyslabs/demosdk/websdk` appears to share wallet state across `Demos` instances inside a single process. For multi-wallet scenarios, prefer `withDemosWallet(...)` (sequential connections) rather than keeping multiple `Demos` objects alive at once.

---

## Token edge-case scenario (rejects + invariants)

New scenario: `SCENARIO=token_edge_cases`

What it does:
- bootstraps + distributes a token
- asserts deterministic rejects:
  - transfer/mint/burn with amount `0`
  - transfer > balance
  - burn > balance
  - burn-from-other without `canBurn`
  - mint without `canMint`
- asserts `totalSupply` + balances are unchanged after the rejected txs
- also asserts `token.get` returns non-200 for a missing token address

Example run:
- `better_testing/runs/token-edge-cases-20260227-150320/token_edge_cases.summary.json`

---

## Token ACL canBurn matrix scenario (burn semantics + grant/revoke)

New scenario: `SCENARIO=token_acl_burn_matrix`

What it does:
- bootstraps + distributes a token to (owner, grantee, outsider)
- asserts **self-burn works without `canBurn`** (by design: only burn-from-other requires `canBurn`)
- asserts burn-from-other is rejected without `canBurn`
- owner grants `canBurn`, waits consensus, asserts ACL entry is present
- grantee burns from owner successfully, waits consensus, asserts supply/balances update
- owner revokes `canBurn`, waits consensus, asserts ACL entry removed
- asserts burn-from-other is rejected again
- asserts non-owner cannot grant permissions
- polls for cross-node convergence (`token.get` + `token.getBalance`)

Example run:
- (run after adding the scenario; output is `token_acl_burn_matrix.summary.json`)

---

## Token ACL pause/unpause matrix scenario (paused blocks writes)

New scenario: `SCENARIO=token_acl_pause_matrix`

What it does:
- bootstraps + distributes a token to (owner, grantee, outsider)
- asserts non-owner cannot `pause`/`unpause` (expects `No pause permission`)
- owner pauses token, waits consensus, asserts `accessControl.paused=true`
- while paused, asserts `transfer`/`mint`/`burn` are rejected with `Token is paused` and state does not change
- owner unpauses token, waits consensus, asserts `accessControl.paused=false`
- asserts a post-unpause transfer applies
- polls for cross-node convergence (`token.get` + `token.getBalance`)

Example run:
- (run after adding the scenario; output is `token_acl_pause_matrix.summary.json`)

---

## Token ACL transferOwnership matrix scenario (owner rotation)

New scenario: `SCENARIO=token_acl_transfer_ownership_matrix`

What it does:
- bootstraps + distributes a token to (current owner, new owner, outsider)
- asserts outsider cannot `transferOwnership` (`No ownership transfer permission`)
- owner transfers ownership to `newOwner`, waits consensus, asserts `accessControl.owner` updates
- asserts **old owner loses implicit permissions**:
  - pause rejected (`No pause permission`)
  - ACL modification rejected (`No ACL modification permission`)
- asserts new owner can pause/unpause (implicit permissions after ownership rotation)
- polls all nodes until they agree on `{ owner, paused }`

Example run:
- (run after adding the scenario; output is `token_acl_transfer_ownership_matrix.summary.json`)

---

## Token ACL multi-permission matrix scenario (compound perms + partial revoke)

New scenario: `SCENARIO=token_acl_multi_permission_matrix`

What it does:
- bootstraps + distributes a token to (owner, grantee, outsider, target)
- asserts grantee is rejected for: `mint`, burn-from-other, `pause`, ACL modification, `transferOwnership`
- owner grants multiple permissions to grantee (`canMint`, `canBurn`, `canPause`, `canModifyACL`, `canTransferOwnership`)
- grantee executes: mint-to-self, burn-from-owner, pause/unpause, grants `canMint` to outsider, transfers ownership to target
- new owner revokes a subset (`canModifyACL`, `canPause`) from grantee and asserts those ops are rejected again
- cross-node convergence checks:
  - balances/supply snapshot convergence (`token.get` + `token.getBalance`)
  - accessControl convergence (`token.get` accessControl subset normalized)

Example run:
- `better_testing/runs/token-acl-multi-perm-20260227-173525/token_acl_multi_permission_matrix.summary.json`

---

## Token ACL updateACL compatibility scenario (updateACL grant/revoke)

New scenario: `SCENARIO=token_acl_updateacl_compat`

What it does:
- bootstraps + distributes a token
- exercises `updateACL` (grant/revoke) and compares behavior to `grantPermission`/`revokePermission` semantics:
  - unauthorized updateACL rejected
  - owner updateACL grant makes permission effective
  - owner updateACL revoke removes effectiveness
- includes consensus/apply polling + cross-node convergence checks

Example run:
- `better_testing/runs/token-acl-updateacl-compat-20260227-174121/token_acl_updateacl_compat.summary.json`

---

## Token scripting smoke scenario (upgradeScript + callView)

New scenario: `SCENARIO=token_script_smoke`

What it does:
- bootstraps a token (unless `TOKEN_BOOTSTRAP=false`)
- asserts `token.callView` returns `NO_SCRIPT` before a script is installed
- upgrades the token script via `upgradeScript`
- polls until `token.get` shows `hasScript=true` and expected `script.codeHash`
- calls `token.callView` on **all nodes** and asserts a stable value

Example run:
- (run after adding the scenario; output is `token_script_smoke.summary.json`)

---

## Token scripting hooks correctness scenario (transfer/mint/burn)

New scenario: `SCENARIO=token_script_hooks_correctness`

What it does:
- bootstraps + distributes a token to (owner, other)
- installs a script with `before*/after*` hooks that increment counters in `customState`
- executes:
  - `transfer` (owner -> other)
  - `mint` (owner -> other)
  - `burn` (other burns self)
- polls until `customState` counters match expected values
- asserts balances/supply deltas match native semantics (script does not alter mutations)
- asserts all nodes converge on the expected `customState` counters

Example run:
- (run after adding the scenario; output is `token_script_hooks_correctness.summary.json`)

---

## Token scripting rejects/invariants scenario (script-enforced reject)

New scenario: `SCENARIO=token_script_rejects`

What it does:
- bootstraps + distributes a token to (owner, other)
- installs a script with `beforeTransfer` that rejects transfers above a threshold (`SCRIPT_REJECT_THRESHOLD`, default 1)
- attempts an oversized transfer and asserts:
  - request is rejected (error contains `rejected`)
  - `totalSupply`, balances, and `customState` are unchanged after consensus
  - cross-node convergence (balances/supply + `customState`)
- then performs a valid transfer at the threshold and asserts it applies

Example run:
- (run after adding the scenario; output is `token_script_rejects.summary.json`)

---

## Token scripting perf ramp scenario (scripted transfer)

New scenarios:
- `SCENARIO=token_script_transfer` (single-step loadgen)
- `SCENARIO=token_script_transfer_ramp` (multi-step ramp)

What it does:
- bootstraps + distributes a token (unless reused via `TOKEN_ADDRESS` / `TOKEN_BOOTSTRAP=false`)
- installs a token script (once) that runs `beforeTransfer`/`afterTransfer` hooks
- runs the same transfer loadgen loop as `token_transfer`, but with hook execution overhead
- emits:
  - `token_script_transfer.summary.json`
  - `token_script_transfer.timeseries.jsonl`
  - `token_script_transfer_ramp.summary.json` (for ramp mode)

Important env vars:
- `RAMP_CONCURRENCY=4,8,16` or `RAMP_INFLIGHT_PER_WALLET=1,2,4`
- `STEP_DURATION_SEC=15` / `COOLDOWN_SEC=3`
- `SCRIPT_WORK_ITERS=0` (CPU loop iterations executed inside each hook)
- `SCRIPT_SET_STORAGE=false` (if `true`, each hook writes counters into `customState`)
- `TOKEN_SCRIPT_UPGRADE=true` (set to `false` on reuse steps; ramp does this automatically)

Example run:
- `cd devnet && RUN_ID=token-script-transfer-ramp-$(date +%Y%m%d-%H%M%S) docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml run --rm -e SCENARIO=token_script_transfer_ramp -e RAMP_CONCURRENCY=4,8,16 -e STEP_DURATION_SEC=15 -e SCRIPT_WORK_ITERS=0 loadgen`

Notes from runs:
- `RUN_ID=token-script-transfer-ramp-20260228-171640` (concurrency ramp): best `okTps≈26.75` but note effective concurrency is capped by available funded wallets.
- `RUN_ID=token-script-transfer-inflight-ramp-20260228-172100` (inflight ramp): best `okTps≈61.93` at `INFLIGHT_PER_WALLET=8`, but `INFLIGHT_PER_WALLET=16` collapses latency (`p50≈2.3s`, `p95≈9.7s`).
- `RUN_ID=token-script-transfer-storage-ramp-20260301-090210` (`SCRIPT_SET_STORAGE=true`, forced script upgrade): best `okTps≈58.12` at `INFLIGHT_PER_WALLET=16`, but latency is very high (`p50≈1.05s`, `p95≈1.45s`).

⚠️ Important observation (potential bug):
- For `RUN_ID=token-script-transfer-storage-ramp-20260301-090210`, the per-step `postRun.settle.ok` is `false` across ramp steps, and the token balances can diverge across nodes even when `getLastBlockHash` and `getLastBlockNumber` match.
- Example snapshot (token `0x463c...`):
  - `token.customState.beforeTransferCount/afterTransferCount` match across nodes
  - but `token.getBalance` values differ for the same addresses across nodes
  - additionally, summing `token.state.balances` could exceed `totalSupply` (self-transfer mint bug)

Quick repro checks:
- last block: `curl -s -X POST -H 'content-type: application/json' --data '{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getLastBlockHash\",\"data\":{},\"muid\":\"dbg\"}]}' http://127.0.0.1:53551/ | jq -r '.response'`
- token balances: `curl -s -X POST -H 'content-type: application/json' --data '{\"method\":\"nodeCall\",\"params\":[{\"message\":\"token.get\",\"data\":{\"tokenAddress\":\"0x463c8d0b0360518757a5d540b1fd31589fb33a3b32b6d132d77e74af1f0ddff5\"},\"muid\":\"dbg\"}]}' http://127.0.0.1:53551/ | jq '.response.state.balances'`

Fix status (2026-03-01):
- Self-transfers now behave as a balance no-op (prevents minting).
- Consensus now validates token edits in `simulate=true`, but persists token edits deterministically at block finalization using the finalized `ordered_transactions` list (avoids token-table divergence when shard members have incomplete mempools at forge time).
- Loadgen recipient selection now normalizes addresses when avoiding self-send.

---

## Token suite sanity pass (2026-03-01)

Ran a quick “confidence sweep” on devnet (all green):
- `RUN_ID=token-edge-20260301-095600` (`SCENARIO=token_edge_cases`): includes explicit self-transfer no-op invariant (tx accepted, state unchanged).
- `RUN_ID=token-acl-smoke-20260301-100120` (`SCENARIO=token_acl_smoke`): fixed a loadgen crash (`connectWallet` missing) and verified attacker mint/burn attempts do not mutate state.
- `RUN_ID=token-script-storage-soak-20260301-100200` (`SCENARIO=token_script_transfer_ramp`, `SCRIPT_SET_STORAGE=true`, `STEP_DURATION_SEC=20`):
  - `INFLIGHT_PER_WALLET=12`: `okTps≈69.55`, `p95≈884ms`, `postRun.settle.ok=true`, `holderPointers.ok=true`.

Note: `token_query_coverage` used to emit very large stdout due to embedding full `token.getHolderPointers` token lists; it now summarizes holder pointers as `(tokenCount, hasPointer)` to keep output manageable.

---

## Agent-invokable scripts

Helpers (host-side):
- `better_testing/scripts/run-scenario.sh` (single scenario runner; supports `--build`, deterministic `RUN_ID`, and extra `--env KEY=VALUE`)
- `better_testing/scripts/token-perf-baseline.sh` (runs `token_transfer_ramp`, `token_mint_ramp`, `token_burn_ramp` sequentially)

Perf knee heuristic (for ramp summaries):
- track `okTps` vs `latencyMs.p95` across ramp steps; the “knee” is typically the last step where `okTps` is still increasing meaningfully before latency starts climbing sharply or errors appear.
