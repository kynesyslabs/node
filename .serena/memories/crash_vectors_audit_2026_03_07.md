# Crash Vectors Audit - 2026-03-07

## Executive Summary
The node has **NO global error handlers** and 50+ `process.exit()` calls scattered throughout. Any unhandled exception or rejection crashes the node.

## Critical Findings

### 1. NO Global Error Handlers
- **Missing**: `process.on('uncaughtException')` 
- **Missing**: `process.on('unhandledRejection')`
- **src/index.ts:865**: `main()` called without `.catch()` - any throw crashes node

### 2. process.exit() Locations (50+)
| Area | Files | Lines |
|------|-------|-------|
| Main | src/index.ts | 131, 611, 705, 720, 880, 983, 987 |
| Consensus | PoRBFT.ts, secretaryManager.ts | 260, 388, 404, 612, 688, 808, 903, 920 |
| Peer | peerBootstrap.ts | 80, 100, 110, 117, 173, 200 |
| Sync | Sync.ts | 257, 266, 274, 858 |
| TLSNotary | TLSNotaryService.ts | 342, 351, 373, 439, 458, 492 |

### 3. RPC Crash Vectors (server_rpc.ts)
- **Line 321**: `payload.params[0].message` - no validation
- **Line 694**: `payload.params[0].extra` - no null check
- **Line 699**: `payload.params[0].data.content.data[0]` - 4-level chain, no guards

### 4. Database Saves Without Try-Catch (17 instances)
GCRIdentityRoutines.ts: Lines 106, 193, 291, 398, 480, 557, 639, 708, 741, 770, 1415, 1483, 1607, 1705, 1779, 1983, 2102

### 5. Async Patterns That Lose Errors
| Pattern | Location | Risk |
|---------|----------|------|
| setInterval + async no catch | L2PSHashService.ts:125 | HIGH |
| setInterval + async no catch | L2PSBatchAggregator.ts:158 | HIGH |
| Fire-and-forget sync | Sync.ts:579, 831 | MEDIUM |
| Socket data handler not awaited | InboundConnection.ts:60 | MEDIUM |

### 6. Silent Error Swallowing
- L2PSConcurrentSync.ts:62-66 - `.catch(() => {})` with no logging
- Sync.ts:579-583 - `.catch(error => {})` completely empty

## What DOES Work
- Graceful shutdown handlers (SIGTERM, SIGINT)
- Re-entrance prevention in gracefulShutdown
- Per-service cleanup try-catch
- RPC server stays up on handler errors (Bun resilience)
- Rate limiting middleware

## Recommended Fix Priority

### P0 - Prevent Crashes
1. Add global `uncaughtException` and `unhandledRejection` handlers
2. Wrap `main()` in try-catch at src/index.ts:865
3. Add input validation to RPC handlers (lines 321, 694, 699)

### P1 - Improve Resilience  
4. Wrap all database `.save()` calls in try-catch
5. Add error handlers to setInterval async callbacks
6. Replace silent `.catch(() => {})` with logging

### P2 - Clean Up
7. Audit all 50+ process.exit() calls - convert to graceful shutdown
8. Standardize error response format in RPC
9. Add circuit breakers for external services
