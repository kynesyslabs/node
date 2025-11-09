# ZK Identity System Implementation - Session Started

## Date
2025-01-31 (approximately)

## Context
Starting implementation of ZK-SNARK identity attestation system based on ZK_PLAN.md

## Implementation Approach
- **Strategy**: Simplest possible working implementation first, then enhance
- **Database**: PostgreSQL (not SQLite) for consistency with existing architecture
- **Proof System**: Groth16 (faster verification than PLONK)
- **Merkle Tree**: Unified global tree (maximum anonymity set)
- **Tree Depth**: 20 levels (supports 1M+ commitments)

## Key Decisions Made

### 1. Database Architecture
- **Decision**: Use PostgreSQL with TypeORM, not SQLite
- **Rationale**: 
  - Consistency with existing Demos Network architecture
  - ACID guarantees across all tables
  - Existing migration infrastructure
  - No additional database management overhead

### 2. Merkle Tree Strategy
- **Decision**: Single unified tree for all providers
- **Rationale**:
  - Larger anonymity set (harder to correlate identities)
  - Simpler validator logic
  - Better privacy guarantees
  - Provider differentiation handled in commitment hash

### 3. Proof System
- **Decision**: Groth16 over PLONK
- **Rationale**:
  - ~5x faster verification (1-2ms vs 5-10ms)
  - Smaller proof size (~200 bytes vs ~800 bytes)
  - Battle-tested in production
  - Can use existing Powers of Tau ceremony

### 4. Integration Pattern
- **Decision**: Extend GCR transaction types, follow existing patterns
- **New Transaction Types**:
  - `identity_commitment`: User submits cryptographic commitment
  - `identity_attestation`: User proves ownership via ZK proof
- **Verification Functions**: Added to `src/libs/abstraction/index.ts` following existing `verifyTelegramProof()` pattern

## Technical Specifications

### Circuit Parameters
```yaml
MERKLE_TREE_DEPTH: 20 # 1,048,576 max commitments
HASH_FUNCTION: poseidon # ZK-friendly
PROOF_SYSTEM: groth16 # Fast verification
```

### Database Entities
1. **IdentityCommitment**: Append-only log of all commitments
2. **UsedNullifier**: Registry to prevent nullifier reuse
3. **MerkleTreeState**: Current tree state and historical snapshots

### Performance Targets
- Proof generation: <5 seconds (client-side)
- Proof verification: <10ms (validator)
- Merkle tree update: <100ms per commitment
- Database operations: <50ms

## Phase Structure
11 phases total, organized in temp/ZK_PLAN_PHASES.md:
1. Environment setup & dependencies
2. Database schema (PostgreSQL)
3. Basic ZK circuit
4. Merkle tree integration
5. Enhanced circuit with Merkle proof
6. Proof generation & verification
7. Transaction types & GCR integration
8. RPC endpoints
9. SDK integration
10. Testing & validation
11. Documentation & examples

## File Structure
```
src/features/zk/
├── circuits/           # Circom circuits
├── keys/              # Proving/verification keys
├── merkle/            # Merkle tree management
├── proof/             # Proof generation/verification
└── types/             # TypeScript types

src/model/entities/GCRv2/
├── IdentityCommitment.ts
├── UsedNullifier.ts
└── MerkleTreeState.ts
```

## Next Actions
- Await user confirmation to proceed with Phase 1
- Phase 1 will install circom, snarkjs, and ZK utilities
- Create workspace structure in src/features/zk/

## Compatibility with Existing System
- Coexists with current public attestation system (telegram, github, discord)
- Users can opt-in to private ZK attestations
- No breaking changes to existing identity verification
- Migration path: existing users can create new ZK commitments while keeping public links

## Security Model
- User secret: Generated client-side, never transmitted
- Commitment: Public hash stored on-chain
- Nullifier: Prevents double-attestation per context
- Merkle proof: Proves commitment exists in tree without revealing which one
- ZK proof: Proves knowledge of secret without revealing it

## Estimated Timeline
8-10 weeks for complete implementation (assuming 1-2 weeks per major phase)
