/**
 * ProofVerifier - Node-Side ZK Proof Verification
 *
 * Purpose: Verify ZK-SNARK proofs submitted by clients for identity attestation
 *
 * Responsibilities:
 * - Load and cache verification key
 * - Verify Groth16 proofs using snarkjs
 * - Validate public signals (nullifier, merkle_root, context)
 * - Check nullifier uniqueness (prevent double-attestation)
 * - Validate Merkle root matches current tree state
 *
 * Security:
 * - Uses verification_key_merkle.json from repo (consensus-critical)
 * - Validates proof cryptographically (Groth16)
 * - Checks nullifier hasn't been used before
 * - Ensures Merkle root is current (prevents old proofs)
 */

import * as snarkjs from "snarkjs"
import { readFileSync } from "fs"
import { join } from "path"
import { DataSource, Repository } from "typeorm"
import { UsedNullifier } from "@/model/entities/GCRv2/UsedNullifier.js"
import { MerkleTreeState } from "@/model/entities/GCRv2/MerkleTreeState.js"
// REVIEW: Bun-compatible verification wrapper (avoids worker thread crashes)
import { groth16VerifyBun } from "./BunSnarkjsWrapper.js"

export interface ZKProof {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
    protocol: string
}

export interface IdentityAttestationProof {
    proof: ZKProof
    publicSignals: string[] // [nullifier, merkle_root, context]
}

export interface ProofVerificationResult {
    valid: boolean
    reason?: string
    nullifier?: string
    merkleRoot?: string
    context?: string
}

export class ProofVerifier {
    private static vKey: any
    private static vKeyPath = "src/features/zk/keys/verification_key_merkle.json"
    private dataSource: DataSource
    private nullifierRepo: Repository<UsedNullifier>
    private merkleStateRepo: Repository<MerkleTreeState>

    constructor(dataSource: DataSource) {
        this.dataSource = dataSource
        this.nullifierRepo = dataSource.getRepository(UsedNullifier)
        this.merkleStateRepo = dataSource.getRepository(MerkleTreeState)
    }

    /**
     * Initialize verification key (load from file, cache in memory)
     * Called automatically on first verification
     */
    private static async loadVerificationKey(): Promise<void> {
        if (this.vKey) {
            return // Already loaded
        }

        try {
            const vKeyPath = join(process.cwd(), this.vKeyPath)
            const vKeyJson = readFileSync(vKeyPath, "utf-8")
            this.vKey = JSON.parse(vKeyJson)
            console.log("✅ ZK verification key loaded successfully")
        } catch (error) {
            console.error("❌ Failed to load verification key:", error)
            throw new Error(
                "Verification key not found. Run 'bun run zk:setup-all' to generate keys.",
            )
        }
    }

    /**
     * Verify a ZK-SNARK proof cryptographically
     *
     * @param proof - Groth16 proof object
     * @param publicSignals - Public inputs [nullifier, merkle_root, context]
     * @returns True if proof is cryptographically valid
     */
    private static async verifyCryptographically(
        proof: ZKProof,
        publicSignals: string[],
    ): Promise<boolean> {
        try {
            await this.loadVerificationKey()
            // REVIEW: Use Bun-compatible wrapper instead of snarkjs.groth16.verify
            // snarkjs uses worker threads which crash on Bun runtime
            // groth16VerifyBun uses single-threaded mode for Bun compatibility
            const isValid = await groth16VerifyBun(this.vKey, publicSignals, proof)
            return isValid
        } catch (error) {
            console.error("❌ Cryptographic verification failed:", error)
            return false
        }
    }

    /**
     * Check if a nullifier has already been used
     *
     * @param nullifierHash - The nullifier to check
     * @returns True if nullifier is already used
     */
    private async isNullifierUsed(nullifierHash: string): Promise<boolean> {
        const existing = await this.nullifierRepo.findOne({
            where: { nullifierHash },
        })
        return existing !== null
    }

    /**
     * Verify that the Merkle root is current (matches our tree state)
     *
     * @param merkleRoot - The Merkle root from the proof
     * @returns True if root matches current tree state
     */
    private async isMerkleRootCurrent(merkleRoot: string): Promise<boolean> {
        const currentState = await this.merkleStateRepo.findOne({
            where: { treeId: "global" },
            order: { blockNumber: "DESC" },
        })

        if (!currentState) {
            console.warn("⚠️ No Merkle tree state found - tree not initialized")
            return false
        }

        return currentState.rootHash === merkleRoot
    }

    /**
     * Complete proof verification with all checks
     *
     * Performs:
     * 1. Cryptographic verification (Groth16)
     * 2. Nullifier uniqueness check (prevent double-attestation)
     * 3. Merkle root validation (ensure current tree state)
     *
     * @param attestation - The identity attestation proof
     * @returns Verification result with details
     */
    async verifyIdentityAttestation(
        attestation: IdentityAttestationProof,
    ): Promise<ProofVerificationResult> {
        const { proof, publicSignals } = attestation

        // Validate public signals format
        if (!publicSignals || publicSignals.length < 2) {
            return {
                valid: false,
                reason: "Invalid public signals format (expected [nullifier, merkle_root] or [nullifier, merkle_root, context])",
            }
        }

        const nullifier = publicSignals[0]
        const merkleRoot = publicSignals[1]
        const context = publicSignals[2] || "default" // Context is optional in some circuit versions

        // Step 1: Cryptographic verification
        const cryptoValid = await ProofVerifier.verifyCryptographically(proof, publicSignals)
        if (!cryptoValid) {
            return {
                valid: false,
                reason: "Proof failed cryptographic verification",
                nullifier,
                merkleRoot,
                context,
            }
        }

        // Step 2: Check nullifier uniqueness
        const nullifierUsed = await this.isNullifierUsed(nullifier)
        if (nullifierUsed) {
            return {
                valid: false,
                reason: "Nullifier already used (double-attestation attempt)",
                nullifier,
                merkleRoot,
                context,
            }
        }

        // Step 3: Validate Merkle root is current
        const rootIsCurrent = await this.isMerkleRootCurrent(merkleRoot)
        if (!rootIsCurrent) {
            return {
                valid: false,
                reason: "Merkle root does not match current tree state",
                nullifier,
                merkleRoot,
                context,
            }
        }

        // All checks passed!
        return {
            valid: true,
            nullifier,
            merkleRoot,
            context,
        }
    }

    /**
     * Mark a nullifier as used after successful verification
     *
     * @param nullifierHash - The nullifier to mark as used
     * @param blockNumber - Current block number
     * @param transactionHash - Transaction hash for reference
     */
    async markNullifierUsed(
        nullifierHash: string,
        blockNumber: number,
        transactionHash: string,
    ): Promise<void> {
        await this.nullifierRepo.save({
            nullifierHash,
            blockNumber,
            timestamp: Date.now(),
            transactionHash,
        })

        console.log(`✅ Nullifier marked as used: ${nullifierHash.slice(0, 10)}...`)
    }

    /**
     * Quick verification for testing (no database checks)
     * Only verifies cryptographic validity
     *
     * @param proof - Groth16 proof
     * @param publicSignals - Public inputs
     * @returns True if cryptographically valid
     */
    static async verifyProofOnly(proof: ZKProof, publicSignals: string[]): Promise<boolean> {
        return await this.verifyCryptographically(proof, publicSignals)
    }
}
