# ZK-SNARK Identity Attestation System

Privacy-preserving identity attestation using zero-knowledge proofs with nullifier-based uniqueness guarantees.

## Directory Structure

```
src/features/zk/
├── circuits/           # Circom ZK circuits
│   ├── identity.circom                    # Basic commitment/nullifier circuit (Phase 3)
│   └── identity_with_merkle.circom        # Full circuit with Merkle proof (Phase 5)
├── keys/              # Proving and verification keys
│   ├── powersOfTau28_hez_final_14.ptau   # Powers of Tau ceremony (download separately)
│   ├── identity_0000.zkey                # Proving key (generated)
│   └── verification_key.json             # Verification key (generated)
├── merkle/            # Merkle tree management
│   └── MerkleTreeManager.ts              # Tree operations and persistence
├── proof/             # Proof generation and verification
│   ├── CommitmentService.ts              # Commitment/nullifier generation
│   ├── ProofGenerator.ts                 # Client-side proof generation
│   └── ProofVerifier.ts                  # Node-side proof verification
├── scripts/           # Setup and utility scripts
│   └── setup.ts                          # Generate proving/verification keys
├── types/             # TypeScript type definitions
│   └── index.ts                          # ZK-related types
└── tests/             # Test files
    └── identity.test.ts                  # E2E tests
```

## Setup Instructions

### Quick Setup (All-in-One) 🚀

For node operators and developers, run the complete ZK setup with a single command:

```bash
bun run zk:setup-all
```

This automated script will:
1. ✅ Download Powers of Tau ceremony file (~140MB, one-time)
2. ✅ Compile all Circom circuits
3. ✅ Generate proving and verification keys
4. ✅ Provide clear status and next steps

**What happens:**
- Powers of Tau: Downloaded from public Hermez ceremony (if not already present)
- Circuits: Compiled to R1CS + WASM format
- Proving key: Generated for proof creation (`.zkey` file, ~10MB)
- Verification key: Generated for validators (`verification_key.json`, ~3KB)

**First-time setup takes:** ~2-3 minutes (mostly downloading Powers of Tau)

**Re-running setup (after circuit changes):** ~30 seconds

---

### What Gets Committed to Git? 🔑

**✅ MUST Commit (Critical for Consensus):**
- `circuits/*.circom` - Circuit source code (all nodes need identical circuits)
- `keys/verification_key.json` - **CRITICAL**: All validators must use same verification key

**❌ DO NOT Commit (Gitignored):**
- `keys/powersOfTau*.ptau` - Public download (~140MB)
- `keys/*_*.zkey` - Proving keys (only clients need these, ~10MB each)
- `circuits/*.r1cs`, `*.wasm`, `*.sym` - Generated artifacts (can be recreated)

**Why?** The verification key is the "trust anchor" for your network. All validators must verify proofs using the identical verification key, or consensus will fail. It's small (~3KB) and deterministically generated from the circuit, so it belongs in the repo.

---

### Manual Setup (Step-by-Step)

If you prefer manual control or troubleshooting:

#### 1. Install Dependencies (✅ Already Done)
```bash
bun add snarkjs ffjavascript @zk-kit/incremental-merkle-tree poseidon-lite circomlib
bun add -d circom_tester circom2
```

#### 2. Download Powers of Tau File
```bash
cd src/features/zk/keys/
curl -L -o powersOfTau28_hez_final_14.ptau \
  https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_14.ptau
```

**Note**: Supports circuits with up to 2^14 (16,384) constraints. Our circuit uses ~1,000 constraints.

#### 3. Compile Circuits
```bash
# Basic circuit (Phase 3)
bun run zk:compile

# Full circuit with Merkle proof (Phase 5)
bun run zk:compile:merkle
```

#### 4. Generate Keys Manually
```bash
# Generate proving key
npx snarkjs groth16 setup \
  src/features/zk/circuits/identity.r1cs \
  src/features/zk/keys/powersOfTau28_hez_final_14.ptau \
  src/features/zk/keys/identity_0000.zkey

# Export verification key
npx snarkjs zkey export verificationkey \
  src/features/zk/keys/identity_0000.zkey \
  src/features/zk/keys/verification_key.json
```

#### 5. Run Tests
```bash
bun run zk:test
```

---

### For Validators (Node Operators Only)

**What you need:**
- ✅ Circuit source code (from repo)
- ✅ Verification key (from repo)
- ❌ Proving key (NOT needed - validators only verify proofs, don't generate them)

**Setup:**
```bash
git clone <repo>
cd demos-node
bun install
bun run zk:setup-all  # Downloads Powers of Tau, but only uses it if generating proving keys
bun start
```

Validators will verify proofs using `verification_key.json` from the repo. No proof generation required!

## Architecture Overview

### Two-Phase Flow

**Phase 1: Link Identity (One-time setup)**
1. User generates secret locally (never leaves device)
2. Creates commitment = H(provider_id, secret)
3. Submits commitment transaction to blockchain
4. Validator adds commitment to Merkle tree, updates root

**Phase 2: Prove Ownership (Repeatable, anonymous)**
1. User generates ZK proof: "I know (provider_id, secret) that exists in the commitment tree"
2. Submits proof + nullifier to blockchain
3. Validator verifies:
   - Proof is cryptographically valid
   - Nullifier hasn't been used before (enforces uniqueness)
   - Proof references current Merkle root
4. If valid, marks nullifier as used

### Key Components

**Commitment**: `Poseidon(provider_id, secret)`
- Public hash stored on-chain
- Links user's secret to their provider ID
- Never reveals which provider or which user

**Nullifier**: `Poseidon(provider_id, context)`
- Unique per (provider, context) pair
- Prevents double-attestation for same context
- Unlinkable to commitment

**Merkle Tree**:
- Depth: 20 levels (supports 1M+ commitments)
- Hash: Poseidon (ZK-friendly)
- Global tree (all providers, maximum anonymity)

**ZK Proof**:
- Proves: "I know a commitment in the tree"
- Public inputs: nullifier, merkle_root, context
- Private inputs: provider_id, secret, merkle_path

## Transaction Types

### `identity_commitment`
```typescript
{
    type: 'identity_commitment',
    payload: {
        commitment_hash: string,  // Poseidon(provider_id, secret)
        provider: string,          // 'github', 'telegram', etc.
        timestamp: number
    }
}
```

### `identity_attestation`
```typescript
{
    type: 'identity_attestation',
    payload: {
        nullifier_hash: string,   // Poseidon(provider_id, context)
        merkle_root: string,      // Current tree root
        proof: {                  // Groth16 proof
            pi_a: string[],
            pi_b: string[][],
            pi_c: string[],
            protocol: string
        },
        public_signals: string[], // [nullifier, merkle_root]
        provider: string          // For categorization only
    }
}
```

## Database Schema (PostgreSQL/TypeORM)

**IdentityCommitment**: Append-only log of commitments
- commitment_hash (PK)
- leaf_index (Merkle tree position)
- provider
- block_number
- timestamp
- transaction_hash

**UsedNullifier**: Prevent double-attestation
- nullifier_hash (PK)
- block_number
- timestamp
- transaction_hash

**MerkleTreeState**: Current tree state
- tree_id (PK) - 'global'
- root_hash
- block_number
- leaf_count
- tree_snapshot (JSONB)

## Security Guarantees

**Privacy**:
- ✅ Provider ID completely hidden
- ✅ No linkability between commitment and attestation
- ✅ Anonymity set = all users across all providers

**Uniqueness**:
- ✅ Nullifier prevents double-attestation per context
- ✅ Commitment uniqueness enforced at database level
- ✅ Merkle root verification prevents fake proofs

**Soundness**:
- ✅ Cryptographically secure (Poseidon + Groth16)
- ✅ Client-side secret generation
- ✅ No trusted third party

## Performance Targets

- ⚡ Proof generation: <5 seconds (client-side)
- ⚡ Proof verification: <10ms (validator)
- ⚡ Merkle tree update: <100ms per commitment
- 📊 Database operations: <50ms

## Development Phases

See `temp/ZK_PLAN_PHASES.md` for complete implementation roadmap.

**Current Status**: Phase 1 Complete ✅
- [x] Dependencies installed
- [x] Directory structure created
- [x] Build scripts configured
- [ ] Download Powers of Tau file
- [ ] Phase 2: Database schema...

## References

- **Circom**: https://docs.circom.io/
- **snarkjs**: https://github.com/iden3/snarkjs
- **Poseidon Hash**: https://www.poseidon-hash.info/
- **Groth16**: https://eprint.iacr.org/2016/260.pdf
- **Powers of Tau**: https://github.com/iden3/snarkjs#7-prepare-phase-2
