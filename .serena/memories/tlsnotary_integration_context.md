# TLSNotary Backend Integration Context

## Beads Tracking

- **Epic**: `node-6lo` - TLSNotary Backend Integration
- **Tasks** (in dependency order):
  1. `node-3yq` - Copy pre-built .so library (READY)
  2. `node-ebc` - Create FFI bindings 
  3. `node-r72` - Create TLSNotaryService
  4. `node-9kw` - Create Fastify routes
  5. `node-mwm` - Create feature entry point
  6. `node-2fw` - Integrate with node startup
  7. `node-hgf` - Add SDK discovery endpoint
  8. `node-8sq` - Type check and lint

## Reference Code Locations

### Pre-built Binary
```
/home/tcsenpai/tlsn/demos_tlsnotary/node/rust/target/release/libtlsn_notary.so
```
Target: `libs/tlsn/libtlsn_notary.so`

### FFI Reference Implementation
```
/home/tcsenpai/tlsn/demos_tlsnotary/node/ts/TLSNotary.ts
```
Complete working bun:ffi bindings to adapt for `src/features/tlsnotary/ffi.ts`

### Demo App Reference
```
/home/tcsenpai/tlsn/demos_tlsnotary/demo/src/app.tsx
```
Browser-side attestation flow with tlsn-js WASM

### Integration Documentation
```
/home/tcsenpai/tlsn/demos_tlsnotary/BACKEND_INTEGRATION.md
/home/tcsenpai/tlsn/demos_tlsnotary/INTEGRATION.md
```

## FFI Symbols (from reference TLSNotary.ts)

```typescript
const symbols = {
  tlsn_init: { args: [], returns: FFIType.i32 },
  tlsn_notary_create: { args: [FFIType.ptr], returns: FFIType.ptr },
  tlsn_notary_start_server: { args: [FFIType.ptr, FFIType.u16], returns: FFIType.i32 },
  tlsn_notary_stop_server: { args: [FFIType.ptr], returns: FFIType.i32 },
  tlsn_verify_attestation: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  tlsn_notary_get_public_key: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  tlsn_notary_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  tlsn_free_verification_result: { args: [FFIType.ptr], returns: FFIType.void },
  tlsn_free_string: { args: [FFIType.ptr], returns: FFIType.void },
};
```

## FFI Struct Layouts

### NotaryConfig (40 bytes)
- signing_key ptr (8 bytes)
- signing_key_len (8 bytes) 
- max_sent_data (8 bytes)
- max_recv_data (8 bytes)
- server_port (2 bytes + padding)

### VerificationResultFFI (40 bytes)
- status (4 bytes + 4 padding)
- server_name ptr (8 bytes)
- connection_time (8 bytes)
- sent_len (4 bytes)
- recv_len (4 bytes)
- error_message ptr (8 bytes)

## SDK Integration (Already Complete)

Package `@kynesyslabs/demosdk` v2.7.2 has `tlsnotary/` module with:
- TLSNotary class: initialize(), attest(), verify(), getTranscript()
- Located in `/home/tcsenpai/kynesys/sdks/src/tlsnotary/`
