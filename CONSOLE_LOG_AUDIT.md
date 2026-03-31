# Console.log Audit Report

Generated: 2024-12-16

## Summary

Found **500+** rogue `console.log/warn/error` calls outside of `CategorizedLogger.ts`.
These bypass the async buffering optimization and can block the event loop.

---

## 🔴 HIGH PRIORITY - Hot Paths (Frequently Executed)

These run during normal node operation and should be converted to CategorizedLogger:

### Consensus Module (`src/libs/consensus/`)

| File                           | Lines                  | Category  |
| ------------------------------ | ---------------------- | --------- |
| `v2/PoRBFT.ts`                 | 245, 332-333, 527, 533 | CONSENSUS |
| `v2/types/secretaryManager.ts` | 900                    | CONSENSUS |
| `v2/routines/getShard.ts`      | 18                     | CONSENSUS |
| `routines/proofOfConsensus.ts` | 15-57 (many)           | CONSENSUS |

### Network Module (`src/libs/network/`)

| File                         | Lines          | Category  |
| ---------------------------- | -------------- | --------- |
| `endpointHandlers.ts`        | 112-642 (many) | NETWORK   |
| `server_rpc.ts`              | 431-432        | NETWORK   |
| `manageExecution.ts`         | 19-117 (many)  | NETWORK   |
| `manageNodeCall.ts`          | 47-466 (many)  | NETWORK   |
| `manageHelloPeer.ts`         | 36             | NETWORK   |
| `manageConsensusRoutines.ts` | 194-333        | CONSENSUS |
| `routines/timeSync.ts`       | 30-84 (many)   | NETWORK   |
| `routines/nodecalls/*.ts`    | Multiple files | NETWORK   |

### Peer Module (`src/libs/peer/`)

| File                                  | Lines         | Category |
| ------------------------------------- | ------------- | -------- |
| `Peer.ts`                             | 113, 125      | PEER     |
| `PeerManager.ts`                      | 52-371 (many) | PEER     |
| `routines/checkOfflinePeers.ts`       | 9-27          | PEER     |
| `routines/peerBootstrap.ts`           | 31-100 (many) | PEER     |
| `routines/peerGossip.ts`              | 228           | PEER     |
| `routines/getPeerConnectionString.ts` | 35-39         | PEER     |
| `routines/getPeerIdentity.ts`         | 32-76 (many)  | PEER     |

### Blockchain Module (`src/libs/blockchain/`)

| File                              | Lines           | Category |
| --------------------------------- | --------------- | -------- |
| `transaction.ts`                  | 115-490 (many)  | CHAIN    |
| `chain.ts`                        | 57-666 (many)   | CHAIN    |
| `routines/Sync.ts`                | 283, 368        | SYNC     |
| `routines/validateTransaction.ts` | 38-288 (many)   | CHAIN    |
| `routines/executeOperations.ts`   | 51-98           | CHAIN    |
| `gcr/gcr.ts`                      | 212-1052 (many) | CHAIN    |
| `gcr/handleGCR.ts`                | 280-399 (many)  | CHAIN    |

### OmniProtocol Module (`src/libs/omniprotocol/`)

| File                           | Lines          | Category |
| ------------------------------ | -------------- | -------- |
| `transport/PeerConnection.ts`  | 407, 464       | NETWORK  |
| `transport/ConnectionPool.ts`  | 409            | NETWORK  |
| `transport/TLSConnection.ts`   | 104-189 (many) | NETWORK  |
| `server/OmniProtocolServer.ts` | 76-181 (many)  | NETWORK  |
| `server/InboundConnection.ts`  | 55-227 (many)  | NETWORK  |
| `server/TLSServer.ts`          | 110-289 (many) | NETWORK  |
| `protocol/handlers/*.ts`       | Multiple files | NETWORK  |
| `integration/*.ts`             | Multiple files | NETWORK  |

---

## 🟡 MEDIUM PRIORITY - Occasional Execution

These run less frequently but still during operation:

### Identity Module (`src/libs/identity/`)

| File               | Lines    | Category |
| ------------------ | -------- | -------- |
| `tools/twitter.ts` | 456, 572 | IDENTITY |
| `tools/discord.ts` | 106      | IDENTITY |

### Abstraction Module (`src/libs/abstraction/`)

| File              | Lines | Category |
| ----------------- | ----- | -------- |
| `index.ts`        | 253   | IDENTITY |
| `web2/github.ts`  | 25    | IDENTITY |
| `web2/parsers.ts` | 53    | IDENTITY |

### Crypto Module (`src/libs/crypto/`)

| File              | Lines         | Category |
| ----------------- | ------------- | -------- |
| `cryptography.ts` | 28-271 (many) | CORE     |
| `forgeUtils.ts`   | 8-45          | CORE     |
| `pqc/enigma.ts`   | 47            | CORE     |

---

## 🟢 LOW PRIORITY - Cold Paths

### Startup/Shutdown (`src/index.ts`)

- Lines: 387, 477-565 (shutdown handlers, startup logs)
- These run once, acceptable as console for visibility

### Feature Modules (Occasional Use)

- `src/features/multichain/*.ts` - XM operations
- `src/features/fhe/*.ts` - FHE operations
- `src/features/bridges/*.ts` - Bridge operations
- `src/features/web2/*.ts` - Web2 proxy
- `src/features/InstantMessagingProtocol/*.ts` - IM server
- `src/features/activitypub/*.ts` - ActivityPub
- `src/features/pgp/*.ts` - PGP operations

---

## ⚪ ACCEPTABLE - Standalone Tools

These are CLI utilities where console.log is appropriate:

- `src/benchmark.ts` - System benchmark tool
- `src/utilities/keyMaker.ts` - Key generation tool
- `src/utilities/showPubkey.ts` - Public key display
- `src/utilities/backupAndRestore.ts` - Backup utility
- `src/utilities/commandLine.ts` - CLI interface
- `src/tests/*.ts` - Test files
- `src/client/*.ts` - Client CLI

---

## Recommendations

### Immediate Actions (P0)

1. Convert consensus hot path logs to `log.debug()`
2. Convert peer/network hot path logs to `log.debug()`
3. Convert blockchain validation logs to `log.debug()`

### Short Term (P1)

4. Convert OmniProtocol logs to CategorizedLogger
5. Convert GCR operation logs to CategorizedLogger
6. Add `OMNI` or similar category for OmniProtocol

### Medium Term (P2)

7. Audit feature modules and convert where needed
8. Consider adding more log categories for better filtering

---

## Conversion Pattern

```typescript
// Before (blocking):
console.log("[PEER] Connected to:", peer)

// After (async buffered):
import { getLogger } from "@/utilities/tui/CategorizedLogger"
const log = getLogger()
log.debug("PEER", `Connected to: ${peer}`)
```

---

## Statistics

- Total rogue console calls: ~500+
- Hot path calls (HIGH): ~200
- Medium priority: ~50
- Low priority (features): ~150
- Acceptable (tools): ~100
