# OmniProtocol Session - December 1, 2025

## Session Summary

Continued work on OmniProtocol integration, fixing authentication and message routing issues.

## Key Fixes Implemented

### 1. Authentication Fix (c1f642a3)

- **Problem**: Server only extracted peerIdentity after `hello_peer` (opcode 0x01)
- **Impact**: NODE_CALL messages with valid auth blocks had `peerIdentity=null`
- **Solution**: Extract peerIdentity from auth block for ANY authenticated message at top of `handleMessage()`

### 2. Mempool Routing Fix (59ffd328)

- **Problem**: `mempool` is a top-level RPC method, not a nodeCall message
- **Impact**: Mempool merge requests got "Unknown message" error
- **Solution**: Added routing in `handleNodeCall` to detect `method === "mempool"` and route to `ServerHandlers.handleMempool()`

### 3. Identity Format Fix (1fe432fd)

- **Problem**: OmniProtocol used `Buffer.toString("hex")` without `0x` prefix
- **Impact**: PeerManager couldn't find peers (expects `0x` prefix)
- **Solution**: Added `0x` prefix in `InboundConnection.ts` and `verifier.ts`

## Architecture Verification

All peer-to-peer communication now uses OmniProtocol TCP binary transport:

- `peer.call()` → `omniAdapter.adaptCall()` → TCP
- `peer.longCall()` → internal `this.call()` → TCP
- `consensus_routine` → NODE_CALL opcode → TCP
- `mempool` merge → NODE_CALL opcode → TCP

HTTP fallback only triggers on:

- OmniProtocol disabled
- Node keys unavailable
- TCP connection failure

## Commits This Session

1. `1fe432fd` - Fix 0x prefix for peer identity
2. `c1f642a3` - Authenticate on ANY message with valid auth block
3. `59ffd328` - Route mempool RPC method to ServerHandlers

## Pending Work

- Test transactions with OmniProtocol (XM, native, DAHR)
- Consider dedicated opcodes for frequently used methods
- Clean up debug logging before production

## Key Files Modified

- `src/libs/omniprotocol/server/InboundConnection.ts`
- `src/libs/omniprotocol/protocol/handlers/control.ts`
- `src/libs/omniprotocol/auth/verifier.ts`
