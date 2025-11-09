# ZK Production Implementation - CDN-Agnostic Plan

## Context
After Phase 9 (SDK integration) completion, we need to implement production-ready cryptographic implementations. However, CDN is not ready yet, so we split implementation into phases.

## Phase A: Implement All Code (No CDN Dependencies)

### SDK Repository (`../sdks/`)
1. Add `snarkjs` and `poseidon-lite` dependencies to package.json
2. Replace placeholder Poseidon hash with real `poseidon-lite` implementation in CommitmentService.ts
3. Replace mock proof generation with real `snarkjs.groth16.fullProve()` in ProofGenerator.ts
4. Add local proof verification support
5. Update all TypeScript types and interfaces
6. **Skip**: WASM/proving key loading logic (awaiting CDN URLs)

### Node Repository
1. Make `ZK_ATTESTATION_POINTS` configurable via environment variable at GCRIdentityRoutines.ts:722
2. Standardize types between SDK and node
3. Add validation improvements
4. Update documentation comments

### Verification
- Run `bun run build` in SDK
- Run `bun run lint:fix` in node repo
- Commit working code

## Phase B: CDN Upload Instructions

Provide user with:
1. List of files to upload from node repo
2. Recommended CDN structure
3. File sizes and locations
4. Expected URLs format

Files to upload:
- `src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm`
- `src/features/zk/keys/proving_key_merkle.zkey` (after final contribution)
- Reference to existing Powers of Tau: `https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_19.ptau`

## Phase C: User CDN Setup

User uploads files and provides final URLs.

## Phase D: Complete CDN Integration

After receiving URLs:
1. Add WASM loading logic with CDN URLs
2. Add proving key loading logic with CDN URLs
3. Add fallback strategies (local files vs CDN)
4. Test and commit final version

## Benefits of This Approach
- 90% of production code written immediately
- Everything compiles and type-checks
- Clear separation between code and infrastructure
- Easy to complete once CDN is ready
