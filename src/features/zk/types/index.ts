/**
 * ZK Identity System - TypeScript Type Definitions
 */

/**
 * Identity Commitment Payload
 * Submitted by users to create a cryptographic commitment to their provider identity
 */
export interface IdentityCommitmentPayload {
    /** Commitment hash: Poseidon(provider_id, secret) */
    commitment_hash: string
    /** Provider type: github, telegram, discord, etc. */
    provider: string
    /** Timestamp when commitment was created */
    timestamp: number
}

/**
 * Groth16 ZK Proof Structure
 * Standard Groth16 proof format used across all ZK operations
 */
export interface Groth16Proof {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
    protocol: string
    curve?: string
}

/**
 * Identity Attestation Payload
 * Submitted by users to prove ownership of a committed identity via ZK proof
 */
export interface IdentityAttestationPayload {
    /** Nullifier hash: Poseidon(provider_id, context) - prevents double-attestation */
    nullifier_hash: string
    /** Current Merkle root that proof is verified against */
    merkle_root: string
    /** Groth16 ZK proof */
    proof: Groth16Proof
    /** Public signals: [nullifier, merkle_root, context] */
    public_signals: string[]
    /** Provider type (for categorization) */
    provider: string
}

/**
 * Merkle Proof Structure
 * Returned by RPC endpoint for generating ZK proofs
 */
export interface MerkleProofResponse {
    /** Merkle proof structure */
    proof: {
        /** Sibling hashes along the path from leaf to root */
        siblings: string[]
        /** Path indices (0 = left, 1 = right) */
        pathIndices: number[]
        /** Root hash */
        root: string
        /** Leaf hash (the commitment) */
        leaf: string
    }
    /** Leaf index in the tree */
    leaf_index: number
}

/**
 * Merkle Root Response
 * Current state of the Merkle tree
 */
export interface MerkleRootResponse {
    /** Current root hash */
    root: string
    /** Block number when root was last updated */
    block_number: number
    /** Number of commitments in the tree */
    leaf_count: number
}

/**
 * Nullifier Check Response
 * Check if a nullifier has been used
 */
export interface NullifierCheckResponse {
    /** Whether the nullifier has been used */
    used: boolean
    /** Block number when nullifier was used (if used) */
    block_number?: number
}

/**
 * ZK Circuit Input
 * Input to the identity proof circuit
 */
export interface IdentityProofCircuitInput {
    /** Provider ID (private) */
    provider_id: string
    /** User secret (private) */
    secret: string
    /** Context for nullifier generation (public) */
    context: string
    /** Current Merkle root (public) */
    merkle_root: string
    /** Merkle proof path elements (private) */
    pathElements: string[]
    /** Merkle proof path indices (private) */
    pathIndices: number[]
}

/**
 * ZK Proof Generation Result
 */
export interface ProofGenerationResult {
    /** Groth16 proof */
    proof: Groth16Proof
    /** Public signals */
    public_signals: string[]
}
