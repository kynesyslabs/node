pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";
include "circomlib/circuits/comparators.circom";

/*
 * MerkleProof - Verify a Merkle tree membership proof
 *
 * Verifies that a leaf exists in a Merkle tree with a given root
 * by checking the path from leaf to root using Poseidon hash.
 *
 * Inputs:
 *   - leaf: The leaf value to verify
 *   - pathElements[levels]: Sibling hashes along the path
 *   - pathIndices[levels]: 0 or 1 indicating left/right position
 *
 * Output:
 *   - root: The computed Merkle root
 */
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    component mux[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Ensure pathIndices[i] is binary (0 or 1)
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // Create Poseidon hasher for this level
        hashers[i] = Poseidon(2);

        // Create multiplexer to choose left/right ordering
        mux[i] = MultiMux1(2);

        // If pathIndices[i] == 0: current hash is left, sibling is right
        // If pathIndices[i] == 1: sibling is left, current hash is right
        mux[i].c[0][0] <== levelHashes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== levelHashes[i];
        mux[i].s <== pathIndices[i];

        // Hash the two elements in correct order
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[levels];
}

/*
 * IdentityProofWithMerkle - Complete ZK Identity Attestation with Merkle Proof
 *
 * Purpose: Prove knowledge of a secret associated with a provider identity
 *          AND prove that the commitment exists in the global Merkle tree.
 *
 * Private Inputs (never revealed):
 *   - provider_id: Hash of provider and account ID (e.g., 'github:12345')
 *   - secret: User-generated secret (never leaves client)
 *   - pathElements[levels]: Merkle proof siblings
 *   - pathIndices[levels]: Merkle proof path directions
 *
 * Public Inputs (part of the proof statement):
 *   - context: Context for nullifier generation (e.g., 'vote_123', 'airdrop_456')
 *   - merkle_root: Current Merkle root (validators verify against this)
 *
 * Public Outputs (verifiable by anyone):
 *   - nullifier: Unique hash for this (provider, context) pair
 *
 * Privacy Guarantees:
 *   - provider_id, secret, and Merkle path remain private
 *   - Commitment existence proven without revealing which commitment
 *   - Nullifier prevents double-use in same context while maintaining privacy
 *   - Anonymity set = all users across all providers (global tree)
 *
 * Security:
 *   - Merkle root verification prevents fake commitments
 *   - Nullifier tracking prevents double-attestation
 *   - Zero-knowledge: no information leaked about identity
 */
template IdentityProofWithMerkle(levels) {
    // Private inputs (never revealed)
    signal input provider_id;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Public inputs (part of the proof statement)
    signal input context;
    signal input merkle_root;

    // Public output (verifiable by anyone)
    signal output nullifier;

    // Step 1: Compute commitment = Poseidon(provider_id, secret)
    // This binds the user's secret to their provider identity
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== provider_id;
    commitmentHasher.inputs[1] <== secret;
    signal commitment;
    commitment <== commitmentHasher.out;

    // Step 2: Verify Merkle proof - prove commitment exists in tree
    component merkleProof = MerkleProof(levels);
    merkleProof.leaf <== commitment;

    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // Step 3: Verify computed root matches the public input
    // This ensures the commitment is in the actual global tree
    merkle_root === merkleProof.root;

    // Step 4: Compute nullifier = Poseidon(provider_id, secret, context)
    // This prevents double-attestation in the same context
    // Including secret ensures nullifiers cannot be linked even if provider_id leaks
    // Different context → different nullifier (allows reuse across contexts)
    // SECURITY: Secret inclusion prevents cross-context tracking and linkability attacks
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== provider_id;
    nullifierHasher.inputs[1] <== secret;
    nullifierHasher.inputs[2] <== context;
    nullifier <== nullifierHasher.out;
}

// Main component - context and merkle_root are public inputs
// Tree depth: 20 levels (supports 1M+ commitments)
component main {public [context, merkle_root]} = IdentityProofWithMerkle(20);
