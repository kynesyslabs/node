# OmniProtocol - Step 7: Phased Implementation Plan

**Status**: 🧭 PLANNED  
**Dependencies**: Steps 1-6 specifications (message format, opcode catalog, peer discovery, connection lifecycle, payload structures, module layout)

---

## 1. Objectives
- Deliver a staged execution roadmap that turns the Step 1-6 designs into production-ready OmniProtocol code while preserving current HTTP behaviour.
- Cover **every existing node RPC**; no endpoints are dropped, but they are grouped into progressive substeps for focus and validation.
- Ensure feature-flag controlled rollout with immediate HTTP fallback to satisfy backward-compatibility requirements.

## 2. Handler Registry Strategy (Q4 Response)
Adopt a **typed manual registry**: a single `registry.ts` exports a `registerHandlers()` function that accepts `{ opcode, decoder, handler, authRequired }` tuples. Handlers live beside their modules, but registration stays centralised. This keeps:
- Deterministic wiring (no hidden auto-discovery).
- Exhaustive compile-time coverage via a `Opcode` enum and TypeScript exhaustiveness checks.
- Straightforward auditing and change review during rollout.

## 3. RPC Coverage Inventory
The following inventory consolidates all payload definitions captured in Step 5 and Step 6. These are the RPCs that must be implemented during Step 7.

| Category | Opcode Range | Messages / RPCs |
|----------|--------------|------------------|
| **Control & Infrastructure (0x0X)** | 0x00 – 0x0F | `Ping`, `Pong`, `HelloPeer`, `HelloPeerResponse`, `NodeCall`, `GetPeerlist`, `PeerlistResponse` |
| **Transactions (0x1X)** | 0x10 – 0x1F | `TransactionContent`, `Execute`, `BridgeTransaction`, `ConfirmTransaction`, `BroadcastTransaction` |
| **Sync (0x2X)** | 0x20 – 0x2F | `MempoolSync`, `MempoolSyncResponse`, `PeerlistSync`, `PeerlistSyncResponse`, `BlockSync`, `BlockSyncResponse` |
| **Consensus (0x3X)** | 0x30 – 0x3F | `ProposeBlockHash`, `VoteBlockHash`, `GetCommonValidatorSeed`, `CommonValidatorSeedResponse`, `SetValidatorPhase`, `Greenlight`, `SecretaryAnnounce`, `ConsensusStatus`, `ConsensusStatusResponse` |
| **Global Contributor Registry (0x4X)** | 0x40 – 0x4F | `GetIdentities`, `GetIdentitiesResponse`, `GetPoints`, `GetPointsResponse`, `GetLeaderboard`, `GetLeaderboardResponse` |
| **Browser / Client (0x5X)** | 0x50 – 0x5F | `Login`, `LoginResponse`, `Web2ProxyRequest`, `Web2ProxyResponse` |
| **Admin (0x6X)** | 0x60 – 0x6F | `SetRateLimit`, `GetCampaignData`, `GetCampaignDataResponse`, `AwardPoints` |
| **Protocol Meta (0xFX)** | 0xF0 – 0xFF | `VersionNegotiation`, `VersionNegotiationResponse`, `CapabilityExchange`, `CapabilityExchangeResponse`, `ErrorResponse` |

Reserved opcode bands (0x7X – 0xEX) remain unassigned in this phase.

## 4. Implementation Waves (Step 7 Substeps)

### Wave 7.1 – Foundations & Feature Gating
**Scope**
- Implement config toggles defined in Step 6 (`migration.mode`, `omniPeers`, environment overrides).
- Wire typed handler registry skeleton with no-op handlers that simply proxy to HTTP via existing Peer methods.
- Finalise codec scaffolding: ensure encoders/decoders from Step 6 compile, add checksum smoke tests.
- Confirm `PeerOmniAdapter` routing + fallback toggles are functional behind configuration flags.

**Deliverables**
- `src/libs/omniprotocol/protocol/registry.ts` with typed registration API.
- Feature flag documentation in `DEFAULT_OMNIPROTOCOL_CONFIG` and ops notes.
- Basic integration test proving HTTP fallback works when OmniProtocol feature flag is disabled.
- Captured HTTP json fixtures under `fixtures/` for peerlist, mempool, block header, and address info parity checks.
- Converted `getPeerlist`, `peerlist_sync`, `getMempool`, `mempool_sync`, `mempool_merge`, `block_sync`, `getBlocks`, `getBlockByNumber`, `getBlockByHash`, `getTxByHash`, `nodeCall`, `getPeerInfo`, `getNodeVersion`, `getNodeStatus`, the protocol meta suite (`proto_versionNegotiate`, `proto_capabilityExchange`, `proto_error`, `proto_ping`, `proto_disconnect`), and `gcr_getAddressInfo` to binary payload encoders per Step 5, with parity tests verifying structured decoding. Transactions and block metadata now serialize key fields (addresses, amounts, hashes, status, ordered tx hashes) instead of raw JSON blobs.

**Exit Criteria**
- Bun type-check passes with registry wired.
- Manual end-to-end test: adapter enabled → request proxied via HTTP fallback when OmniProtocol disabled.

### Wave 7.2 – Consensus & Sync Core (Critical Path)
**Scope**
- Implement encoders/decoders + handlers for Control, Sync, and Consensus categories.
- Support hello handshake, peerlist sync, mempool sync, and full consensus message suite (0x0X, 0x2X, 0x3X).
- Integrate retry semantics (3 attempts, 250 ms sleep) and circuit breaker hooks with real handlers.

**Deliverables**
- Fully implemented payload codecs for 0x0X/0x2X/0x3X.
- Consensus handler factory mirroring existing secretary/validator flows.
- Regression harness that replays current HTTP consensus test vectors via OmniProtocol and verifies identical outcomes.

**Exit Criteria**
- Deterministic test scenario showing consensus round-trip parity (leader election, vote aggregation).
- Observed latency within ±10 % of HTTP baseline for consensus messages (manual measurement acceptable at this stage).

### Wave 7.3 – Transactions & GCR Services
**Scope**
- Implement Transaction (0x1X) and GCR (0x4X) payload codecs + handlers.
- Ensure signature validation path identical to HTTP (same KMS/key usage).
- Cover bridge transaction flows and loyalty points lookups.

**Deliverables**
- Transaction execution pipeline backed by OmniProtocol messaging.
- GCR read endpoints returning identical data to HTTP.
- Snapshot comparison script to validate transaction receipts and GCR responses between HTTP and OmniProtocol.

**Exit Criteria**
- Side-by-side replay of a batch of transactions produces identical block hashes and receipts.
- GCR leaderboard diff tool reports zero drift against HTTP responses.

### Wave 7.4 – Browser, Admin, and Meta
**Scope**
- Implement Browser (0x5X), Admin (0x6X), and Meta (0xFX) codecs + handlers.
- Ensure migration manager governs which peers receive OmniProtocol vs HTTP for these ancillary endpoints.
- Validate capability negotiation to advertise OmniProtocol support.

**Deliverables**
- OmniProtocol login flow reusing existing auth tokens.
- Admin award/rate-limit commands via OmniProtocol.
- Version/capability negotiation integrated into handshake.

**Exit Criteria**
- Manual UX check: browser client performs login via OmniProtocol behind feature flag.
- Admin operations succeed via OmniProtocol when enabled and fall back cleanly otherwise.

### Wave 7.5 – Operational Hardening & Launch Readiness
**Scope**
- Extend test coverage (unit + integration) across all codecs and handlers.
- Document operator runbooks (enable/disable OmniProtocol, monitor connection health, revert to HTTP).
- Prepare mainnet readiness checklist (dependencies, peer rollout order, communication plan) even if initial launch remains branch-scoped.

**Deliverables**
- Comprehensive `bun test` suite (serialization, handler behaviour, adapter fallback).
- Manual validation scripts for throughput/latency sampling.
- Runbook in `docs/omniprotocol/rollout.md` describing toggles and fallback.

**Exit Criteria**
- All OmniProtocol feature flags default to `HTTP_ONLY` and can be flipped peer-by-peer without code changes.
- Rollback to HTTP verified using the same scripts across Waves 7.2-7.4.

## 5. Feature Flag & Config Plan
- `migration.mode` drives global behaviour (`HTTP_ONLY`, `OMNI_PREFERRED`, `OMNI_ONLY`).
- `omniPeers` set controls per-peer enablement; CLI helper (future) can mutate this at runtime.
- `fallbackTimeout` ensures HTTP retry kicks in quickly when OmniProtocol fails.
- Document configuration overrides (env vars or config files) in Wave 7.1 deliverables.

## 6. Testing & Verification Guidelines (Q8 Response)
Even without a mature harness, adopt the following minimal layers:
1. **Unit** – `bun test` suites for each encoder/decoder (round-trip + negative cases) and handler (mocked Peer adapters).
2. **Golden Fixtures** – Capture existing HTTP responses (JSON) and assert OmniProtocol decodes to the same structures.
3. **Soak Scripts** – Simple Node scripts that hammer consensus + transaction flows for 5–10 minutes to observe stability.
4. **Manual Playbooks** – Operator checklist to flip `migration.mode`, execute representative RPCs, and confirm fallback.

## 7. Rollout & Backward Compatibility (Q6 & Q10 Responses)
- All work happens on the current feature branch; no staged environment rollout yet.
- OmniProtocol must remain HTTP-compliant: every OmniProtocol handler calls existing business logic so HTTP endpoints stay unchanged.
- Keep HTTP transport as authoritative fallback until OmniProtocol completes Wave 7.5 exit criteria.

## 8. Deliverable Summary
- `07_PHASED_IMPLEMENTATION.md` (this document).
- New/updated source files per wave (handlers, codecs, registry, config docs, tests, runbooks).
- Validation artefacts: regression scripts, diff reports, manual checklists.

## 9. Immediate Next Steps
1. Implement Wave 7.1 tasks: feature flags, registry skeleton, codec scaffolding checks.
2. Prepare golden HTTP fixtures for Control + Sync categories to speed up Wave 7.2 parity testing.
3. Schedule design review after Wave 7.1 to confirm readiness for Consensus + Sync implementation.
