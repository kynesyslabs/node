# OmniProtocol Step 2: Opcode Mapping Design

## Completed Design Decisions

### Category Structure (8 categories + 1 reserved block)
- **0x0X**: Control & Infrastructure (16 opcodes)
- **0x1X**: Transactions & Execution (16 opcodes)
- **0x2X**: Data Synchronization (16 opcodes)
- **0x3X**: Consensus PoRBFTv2 (16 opcodes)
- **0x4X**: GCR Operations (16 opcodes)
- **0x5X**: Browser/Client (16 opcodes)
- **0x6X**: Admin Operations (16 opcodes)
- **0x7X-0xEX**: Reserved (128 opcodes for future categories)
- **0xFX**: Protocol Meta (16 opcodes)

### Total Opcode Space
- **Assigned**: 112 opcodes (7 categories × 16)
- **Reserved**: 128 opcodes (8 categories × 16)
- **Protocol Meta**: 16 opcodes
- **Total Available**: 256 opcodes

### Key Opcode Assignments

**Control (0x0X):**
- 0x00: ping (most fundamental)
- 0x01: hello_peer (peer handshake)
- 0x03: nodeCall (HTTP compatibility wrapper)

**Transactions (0x1X):**
- 0x10: execute (transaction submission)
- 0x12: bridge (external bridge operations)

**Sync (0x2X):**
- 0x20: mempool_sync
- 0x22: peerlist_sync
- 0x24-0x27: block/tx queries

**Consensus (0x3X):**
- 0x31: proposeBlockHash
- 0x34: getCommonValidatorSeed (CVSA)
- 0x36: setValidatorPhase
- 0x38: greenlight (secretary signal)

**GCR (0x4X):**
- 0x4A: gcr_getAddressInfo
- 0x4B: gcr_getAddressNonce

**Protocol Meta (0xFX):**
- 0xF0: proto_versionNegotiate
- 0xF2: proto_error
- 0xF4: proto_disconnect

### Wrapper Opcodes for HTTP Compatibility
- **0x03 (nodeCall)**: All SDK query methods
- **0x30 (consensus_generic)**: Generic consensus wrapper
- **0x40 (gcr_generic)**: Generic GCR wrapper

These may be deprecated post-migration.

### Security Mapping
**Auth Required:** 0x10-0x16, 0x20-0x22, 0x30-0x3A, 0x41, 0x48, 0x60-0x62
**No Auth:** 0x00, 0x04-0x07, 0x24-0x27, 0x42-0x47, 0x49-0x4B, 0xF0-0xF4
**Special:** 0x60-0x62 require SUDO_PUBKEY verification

### Design Rationale
1. **Category-based organization**: High nibble = category for quick identification
2. **Logical grouping**: Related operations together for easier implementation
3. **Future-proof**: 128 reserved opcodes for new categories
4. **HTTP compatibility**: Wrapper opcodes (0x03, 0x30, 0x40) for gradual migration
5. **Security first**: Auth requirements baked into opcode design

### Verified Against Codebase
- All HTTP RPC methods mapped
- All consensus_routine submethods covered
- All gcr_routine submethods covered
- All nodeCall submethods covered
- Deprecated methods (vote, voteRequest) excluded
- Future browser/client opcodes reserved (0x5X)

### Files Created
- `OmniProtocol/02_OPCODE_MAPPING.md` - Complete opcode specification
- `OmniProtocol/SPECIFICATION.md` - Updated with opcode summary

### Next Step
Design payload structures for each opcode category.