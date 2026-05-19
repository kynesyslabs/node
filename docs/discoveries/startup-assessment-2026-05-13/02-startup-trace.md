---
type: discovery-slice
title: Node Startup Sequence Trace
date: 2026-05-13
---

# Node Startup Sequence Trace

Source files: `src/index.ts`, `scripts/run`, `package.json`, plus internal subsystem files cited inline.

## Entry Point Chain

- `package.json:21` → `"start": "tsx -r tsconfig-paths/register src/index.ts"`
- `package.json:9` → `"main": "src/index.ts"`
- `run` (repo root, 4 lines) → `exec scripts/run "$@"` — heavy bash wrapper (~970 lines) at `scripts/run` does DB/IPFS/git/env prep, then exec's `bun` / `tsx` on `src/index.ts`.
- Top-level invocation: `src/index.ts:892` `main().catch(...)`

## Numbered Startup Sequence

1. **Module side-effects:** `dotenv.config()` (`src/index.ts:46`); install `uncaughtException` + `unhandledRejection` handlers (`:53`, `:58`) — both **swallow + continue**, no exit.
2. **`main()`** `:440` — check `--no-tui` flag.
3. **TUI init** (if enabled) `:448-476` — `TUIManager.start()`. Failure → `handleError` + sets `TUI_ENABLED=false` (continues).
4. **`Chain.setup()`** `:478` → `chain.ts:46` → `setupChainDb()` (TypeORM datasource bootstrap). **No log line on success.**
5. **`Mempool.init()`** `:479` — static init. **No log line on success.**
6. **`warmup()`** `:481` → `index.ts:242`:
   - `log.cleanLogs(false)` `:244`
   - reads `Config` singleton; sets ports (`PG_PORT`, `SERVER_PORT`, `SIGNALING_SERVER_PORT`, `MCP_SERVER_PORT`, `OMNI_PORT`); for signaling/omni walks `getNextAvailablePort()` — **port drift not logged**, only final value.
   - **Starts RPC server**: `serverRpcBun()` `:302` → `server_rpc.ts:196` logs `"Server is running on 0.0.0.0:<port>"`, then `server.start()` `:197`.
   - `PeerManager.getInstance()` `:303` → "peerManager started" log.
   - `digestArguments()` `:307` parses CLI args.
7. **`calibrateTime()`** `:491` → `getTimestampCorrection()`; logs correction + network timestamp.
8. **OmniProtocol TCP server** (conditional, `OMNI_ENABLED`) `:494-529`:
   - `startOmniProtocolServer()` awaited; if init throws → `handleError` + falls back to HTTP; **then** `if (!getSharedState.omniAdapter) process.exit(1)` `:523`. Comment says "fallback" but the check forces exit.
   - If disabled: single log line `:526`.
9. **`preMainLoop()`** `:531` → `index.ts:312`:
   - `identity.loadIdentity()` `:321` — keypair load. Failure throws (uncaught here → main's `.catch` → `gracefulShutdown("main_error")`).
   - Writes pubkey file `publickey_<algo>_<hex>` to CWD `:367`.
   - `EXPOSED_URL` loopback warning `:335-365`.
   - `PeerManager.loadPeerList()` `:374` — sync, no log on success body.
   - `identity.getPublicIP()` `:384` — try/catch: failure logs `warning "{OFFLINE?}"`.
   - `findGenesisBlock()` `:393` (awaited, no try) — throws → propagates to main `.catch`.
   - `loadGenesisIdentities()` `:394`.
   - `loadNetworkParameters()` `:400`.
   - `peerBootstrap(PeerList)` `:402` — async, may retry internally; **no top-level guard**.
   - `Chain.getLastBlock()` `:425` to seed shared state.
10. **Prometheus metrics server** (conditional `METRICS_ENABLED`, default on) `:547-585`:
    - `metricsServer.start()` + `metricsCollector.start()` awaited. Failure → `log.error` only, continues.
11. **Empty-peer-list guard** `:589-592` — flips `enough_peers=false`. **All subsequent steps 12–17 are gated by `if (enough_peers)` `:594`** — silently skipped if false.
12. **`SignalingServer`** `:605` — constructor only; logs `"Signaling server running on port <port>"` from inside (`signalingServer.ts:117`). Truthy-check `:608` always passes (`new` never returns null) → `process.exit(1)` branch `:614` is **dead code**.
13. **MCP server** (conditional, `MCP_ENABLED` default true) `:617-647` — lazy `import("./features/mcp")`, `mcpServer.start()`. Failure → `log.error` + continues.
14. **TLSNotary service** (conditional) `:650-727` — `initializeTLSNotary()`. If returns false: respects `TLSNOTARY_FATAL` env → `process.exit(1)`, else `log.warning` + continue. Throw branch identical.
15. **Anchor-node wait** `:741-821` — if we are the only peer, `Waiter.wait(STARTUP_HELLO_PEER, 15s)`. TUI mode: bare wait. Non-TUI: raw-stdin Enter-skip handler.
16. **`Mempool.cleanMempool()`** `:823` then **`fastSync([], "index.ts")`** `:824` — awaited; sets `isInitialized=true`.
17. **`mainLoop()`** `:827` — **fire-and-forget**; `.catch` logs + `handleError`; `.finally` always calls `process.exit(1)` `:835` (intentional debug exit per inline comment).
18. **DTR relay retry service** (only if `PROD`) `:841-847` — `DTRManager.getInstance().start()`, no await.
19. **`ParallelNetworks.loadAllL2PS()`** `:851` — try/catch, populates `l2psJoinedUids`.
20. **L2PS hash + batch aggregator** (only if joined uids) `:860-884` — both awaited, errors caught into `handleError`.

## Per-Step Table

| # | Step | Blocking | Failure mode | Logs? | Port |
|---|------|----------|--------------|-------|------|
| 1 | dotenv + global handlers | sync | swallow | only on actual error | — |
| 2 | TUI manager | await | sets TUI off, continue | yes (error path) | — |
| 3 | `Chain.setup` (DB) | await | throws → main catch → graceful shutdown | **no success log** | uses `PG_PORT` 5332 |
| 4 | `Mempool.init` | await | throws → main catch | **no success log** | — |
| 5 | `warmup` config | await | throws → main catch | yes (env block) | — |
| 6 | `serverRpcBun` (HTTP RPC) | await | throws → main catch | yes (`:196`) | `SERVER_PORT` (env `RPC_PORT`, e.g. 53550) |
| 7 | PeerManager singleton | sync | throws → main catch | yes | — |
| 8 | `calibrateTime` | await | throws → main catch | yes | — |
| 9 | OmniProtocol server | await | logs, **then exits 1 if no adapter** | yes | `OMNI_PORT` (next avail) |
| 10 | `preMainLoop` identity load | await | throws → main catch (no try) | yes (after success) | — |
| 11 | `findGenesisBlock`/`loadNetworkParameters` | await | throws → main catch | yes | — |
| 12 | `peerBootstrap` | await | internal try/catch + retries | yes | — |
| 13 | Metrics server | await | log.error + continue | yes | `METRICS_PORT` |
| 14 | SignalingServer | sync ctor | dead exit branch; ws errors async | yes | `SIGNALING_SERVER_PORT` (next avail) |
| 15 | MCP server | await | log.error + continue | yes | `MCP_SERVER_PORT` (next avail) |
| 16 | TLSNotary | await | exit 1 if `TLSNOTARY_FATAL`, else warn | yes | `TLSNOTARY_PORT` |
| 17 | Anchor-node wait 15s | await | timeout normal | yes | — |
| 18 | `mainLoop()` | **background** | always `process.exit(1)` in finally | yes | — |
| 19 | DTRManager.start | background | unhandled internal | "Initializing" log only | — |
| 20 | ParallelNetworks.loadAllL2PS | await | handleError, continue | none on success path | — |
| 21 | L2PSHashService + BatchAggregator | await | handleError, continue | yes if started | — |

## Observability Gaps (with file:line)

- **`Chain.setup()` silent success** — `src/libs/blockchain/chain.ts:46-50`. No "[CHAIN] DB ready" line. If `setupChainDb` hangs on postgres (`PG_PORT 5332`), nothing logs until the next step starts.
- **`Mempool.init()` silent success** — `src/libs/blockchain/mempool.ts:22`.
- **PeerManager `loadPeerList()` no count log** — `src/index.ts:374`. Only per-peer enumeration logs `:378-380`; empty peerlist produces zero output instead of `"loaded 0 peers from <file>"`.
- **`getNextAvailablePort` drift unlogged** — `src/index.ts:268, 279, 552, 622`. If a requested port is busy, the next free port is silently chosen; only the final value appears. Operator can't see "wanted 8080, got 8083".
- **`enough_peers` gate silently skips half the boot** — `src/index.ts:589-594`. If `peers.length < 1`, prints one warning `"🔍 No peers detected, listening..."`, then **skips SignalingServer, MCP, TLSNotary, mainLoop, DTR, L2PS** with no further marker. Looks alive (RPC up, metrics up) but is functionally dormant.
- **`SignalingServer` truthy guard is dead code** — `src/index.ts:608-614`. `new SignalingServer(...)` never returns null; bind failures throw async inside Bun → main path logs `"Signaling server started"` even when WS bind fails. The real bind log is inside the ctor at `signalingServer.ts:117` and prints **before** the bind is actually verified.
- **`mainLoop()` fire-and-forget with hardcoded exit(1)** — `src/index.ts:827-837`. `.finally` always exits, masking why mainLoop returned. The trailing `log.info("Main loop finished")` `:836` is **unreachable**.
- **DTRManager.start() unawaited** — `src/index.ts:846`. Only `"Initializing relay retry service"` is logged; service errors only surface via internal logging. No "DTR ready" / "DTR failed" terminal status.
- **`ParallelNetworks.loadAllL2PS()` no success log** — `src/index.ts:851`. Zero uids prints one "No L2PS networks joined" line; can't distinguish "config absent" from "config failed parse".
- **OmniProtocol fallback exits hard** — `src/index.ts:523`. Comment says "failsafe falls back to HTTP" but the `omniAdapter` check then forces `process.exit(1)` — contradicts the failsafe promise.
- **Process-wide `uncaughtException` / `unhandledRejection` keep node alive** — `src/index.ts:53-61`. Subsystem crashes don't kill the process; RPC keeps answering while internal services are dead. Combined with the skipped-block gate at `:594`, the operator perceives a healthy node while consensus is frozen.
- **`process.exit(1)` paths with no preceding error log:** TLSNotary fatal `:706`, OmniProtocol no-adapter `:523`, dead signaling branch `:614`.
- **`scripts/run` wrapper** (`~970 lines`) does heavy DB-prepare / git-pull / IPFS / migrations before exec'ing node. Its `log_verbose` (`scripts/run:32`) only prints under `VERBOSE=true`; default-run is mostly silent until node prints. If a precondition (e.g. PG wait) hangs, the user sees a stalled terminal with no markers.

## TL;DR Fragility Profile

- 20 distinct bootstrap steps. ~6 are fire-and-forget or have async-bind that the synchronous "started" log can't actually prove.
- 3 silent-success steps (Chain.setup, Mempool.init, ParallelNetworks).
- 1 dormant-but-looks-alive failure mode (`enough_peers=false` skip block).
- `mainLoop`'s mandatory `process.exit(1)` in `.finally` is the single largest source of "node just died" confusion — by design but undocumented to operators.
