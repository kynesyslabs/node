Perfect! Here's the plan:

## Wave 8.1: COMPLETE ✅

**What we built**:
- ✅ TCP connection infrastructure (ConnectionPool, PeerConnection, MessageFramer)
- ✅ Integration with peerAdapter
- ✅ Automatic HTTP fallback

**Current limitation**: Still using **JSON payloads** (hybrid format)

---

## Wave 8.2: Binary Payload Encoding

**Goal**: Replace JSON envelopes with **full binary encoding** for 60-70% bandwidth savings

**Duration**: 4-6 days

### Current Format (Hybrid)
```
[12-byte binary header] + [JSON envelope payload] + [4-byte CRC32]
                            ↑ This is still JSON!
```

### Target Format (Full Binary)
```
[12-byte binary header] + [binary encoded payload] + [4-byte CRC32]
                            ↑ All binary!
```

### What We'll Build

1. **Binary Encoders** for complex structures:
   - Transaction encoding (from `05_PAYLOAD_STRUCTURES.md`)
   - Block/mempool structures
   - GCR edit operations
   - Consensus messages

2. **Codec Registry Pattern**:
   ```typescript
   interface PayloadCodec<T> {
       encode(data: T): Buffer
       decode(buffer: Buffer): T
   }
   
   const PAYLOAD_CODECS = new Map<OmniOpcode, PayloadCodec<any>>()
   ```

3. **Gradual Migration**:
   - Phase 1: Simple structures (addresses, hashes, numbers) ← Start here
   - Phase 2: Moderate complexity (transactions, blocks)
   - Phase 3: Complex structures (GCR edits, bridge trades)

### Expected Bandwidth Savings
```
Current (JSON):        Target (Binary):
getPeerInfo: ~120 B    getPeerInfo: ~50 B   (60% savings)
Transaction: ~800 B    Transaction: ~250 B  (69% savings)
Block sync:  ~15 KB    Block sync:  ~5 KB   (67% savings)
```

### Implementation Plan

**Step 1**: Update serialization files in `src/libs/omniprotocol/serialization/`
- `transaction.ts` - Full binary transaction encoding
- `consensus.ts` - Binary consensus message encoding
- `sync.ts` - Binary block/mempool structures
- `gcr.ts` - Binary GCR operations

**Step 2**: Create codec registry
**Step 3**: Update peerAdapter to use binary encoding
**Step 4**: Maintain JSON fallback for backward compatibility

---

## Do you want to proceed with Wave 8.2?

We can:
1. **Start 8.2 now** - Implement full binary encoding
2. **Test 8.1 first** - Actually enable TCP and test with real node communication
3. **Do both in parallel** - Test while building 8.2

What would you prefer?
