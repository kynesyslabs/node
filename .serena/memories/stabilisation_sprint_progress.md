# Stabilisation Sprint Progress

## Completed (2026-03-16)

### 1. Unified Error Handling Module (`src/errors/`)
- `AppError` base class extending `Error` for backward compatibility
- 11 domain error classes (NetworkError, PeerError, ConsensusError, etc.)
- `ErrorCode` constants (~40 codes), `ErrorSource` constants (~40 sources), `ErrorSeverity` enum
- `tryCatch`/`tryCatchSync` tuple pattern, `handleError` utility, `toErrorResponse`
- Legacy exceptions in `src/exceptions/` now extend AppError
- Applied to `src/index.ts` and 14+ files (console.error → handleError)
- 23 unit tests passing

### 2. Unified Config Module (`src/config/`)
- `Config` singleton class with typed accessors per domain
- Domains: server, database, core, tlsnotary, omni, l2ps, metrics, diagnostics, identity, bridges, ipfs
- `EnvKey` constants, `DEFAULT_CONFIG`, deep-frozen at load
- `dotenv.config()` in loader.ts for ES module import hoisting
- Fixed `envStr` bug: `??` → `||` (empty string env vars bypassing defaults)
- 95 env vars across 33 files migrated to Config.getInstance().*

### 3. File Structure Cleanup — Types/Constants Extraction (7 modules)
- `utilities/`: 16 constants + Diagnostic types
- `identity/tools/`: 10 interfaces + 30+ constants
- `l2ps/`: L2PSBatchPayload type + 7 connection pool constants
- `tlsnotary/`: 16 types/enums + signing key, port config, token config constants
- `metrics/`: 3 config interfaces + histogram buckets, default configs
- `omniprotocol/`: 35 constants (server defaults, TLS, rate limits, error codes)
- All backward-compatible via re-exports

### 4. Code Structure Refactor — Split Large Files
- **manageNodeCall.ts** (1007→~20 lines): Split 45 switch cases into `network/handlers/` by domain (blocks, txs, peers, identity, tlsnotary, l2ps, misc)
- **GCRIdentityRoutines.ts** (2212→~170 lines): Split 19 routines into `routines/` by domain (xm, web2, pqc, ud, rewards, zk, nomis, humanpassport, ethos, tlsn) + shared utils

## Remaining
- [ ] `chain.ts` (781 lines) → split by concern
- [ ] `server_rpc.ts` (741 lines) → routes by domain
- [ ] `endpointHandlers.ts` (891 lines) → handlers by domain
- [ ] Test environment unification (assigned to another developer)
- [ ] Migrate remaining magic string error sources to ErrorSource constants

## Key Decisions
- All refactors are pure file reorganization — no logic changes
- Backward compatibility maintained via re-exports from original files
- `this.method()` calls in class methods → standalone exported functions in split files
- Shared utilities (safeGCRSave, isFirstConnection, normalize*) extracted to `routines/utils.ts`

## Test Baseline
- 98 pass, 12 fail, 1 error (all failures pre-existing)
- 0 new TypeScript errors from our changes
