# ZK Identity System - Technical Architecture

## Proof System
- **Algorithm**: Groth16 (via snarkjs/circom)
- **Hash Function**: Poseidon (ZK-friendly, from circomlib)
- **Trusted Setup**: Powers of Tau ceremony (powersOfTau28_hez_final_14.ptau)

## Circuits
| Circuit | File | Constraints | Purpose |
|---------|------|-------------|---------|
| Basic | `identity.circom` | 486 NL | Prototype |
| Production | `identity_with_merkle.circom` | 5,406 NL | 20-level Merkle proof |

## Key Files (Node)
```
src/features/zk/
├── circuits/identity_with_merkle.circom  # Production circuit
├── keys/verification_key_merkle.json     # Committed for consensus
├── merkle/MerkleTreeManager.ts           # Tree operations
├── proof/ProofVerifier.ts                # Groth16 verification
├── proof/BunSnarkjsWrapper.ts            # Bun-compatible wrapper
├── scripts/ceremony.ts                   # Multi-party setup
└── types/index.ts                        # Groth16Proof, etc.
```

## Key Files (SDK at ../sdks/)
```
src/encryption/zK/identity/
├── CommitmentService.ts    # Poseidon via poseidon-lite
├── ProofGenerator.ts       # snarkjs.groth16.fullProve
└── ZKIdentity.ts           # User-facing class
```

## Database Entities (TypeORM)
- `IdentityCommitment`: commitment_hash, leaf_index, provider, block_number
- `UsedNullifier`: nullifier_hash, block_number (prevents double-attestation)
- `MerkleTreeState`: tree_id, root_hash, leaf_count, tree_snapshot (JSONB)

## GCR Transaction Types
- `applyZkCommitmentAdd`: Add commitment to Merkle tree
- `applyZkAttestationAdd`: Verify proof, mark nullifier used

## RPC Endpoints
- `GET /zk/merkle-root`: Current tree root
- `GET /zk/merkle/proof/:commitment`: Merkle proof for commitment
- `GET /zk/nullifier/:hash`: Check if nullifier used

## Cryptographic Flow
1. **Commitment**: `Poseidon(provider_id, secret)` - stored in Merkle tree
2. **Nullifier**: `Poseidon(provider_id, context)` - prevents double-use
3. **Proof**: Groth16 proves knowledge without revealing identity

## Performance
- Proof generation: ~5s (client)
- Proof verification: <10ms (validator)
- Merkle tree ops: <100ms

## Phase Tracking
See beads-mcp for current implementation status.
