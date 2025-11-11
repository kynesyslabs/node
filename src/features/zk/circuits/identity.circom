pragma circom 2.0.0;

include "circomlib/poseidon.circom";

/*
 * IdentityProof - Basic ZK-SNARK Identity Commitment Circuit
 *
 * Purpose: Prove knowledge of a secret associated with a provider identity
 *          without revealing the specific identity or secret.
 *
 * Inputs:
 *   - provider_id (private): Hash of the provider and account ID (e.g., 'github:12345')
 *   - secret (private): User-generated secret (never leaves client)
 *   - context (public): Context for nullifier generation (e.g., 'vote_123', 'airdrop_456')
 *
 * Outputs:
 *   - commitment (public): Hash linking provider_id to secret
 *   - nullifier (public): Unique hash for this (provider, context) pair
 *
 * Privacy Guarantees:
 *   - provider_id and secret remain private
 *   - commitment proves "I have a valid identity" without revealing which one
 *   - nullifier prevents double-use in same context while maintaining privacy
 *
 * Note: This is Phase 3 - basic circuit without Merkle proof.
 *       Phase 5 adds Merkle tree verification for commitment existence.
 */
template IdentityProof() {
    // Private inputs (never revealed)
    signal input provider_id;
    signal input secret;

    // Public input (part of the proof statement)
    signal input context;

    // Public outputs (verifiable by anyone)
    signal output commitment;
    signal output nullifier;

    // Compute commitment = Poseidon(provider_id, secret)
    // This binds the user's secret to their provider identity
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== provider_id;
    commitmentHasher.inputs[1] <== secret;
    commitment <== commitmentHasher.out;

    // Compute nullifier = Poseidon(provider_id, secret, context)
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

// Main component - context is public input, others are private
component main {public [context]} = IdentityProof();
