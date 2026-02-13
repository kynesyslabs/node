/**
 * ProofVerifier Test Suite
 *
 * Tests for ZK-SNARK proof verification on node-side
 *
 * NOTE: These are integration tests requiring:
 * - PostgreSQL database running
 * - Valid verification key at src/features/zk/keys/verification_key_merkle.json
 * - Test proofs generated with matching circuit
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { ProofVerifier } from "../proof/ProofVerifier.js"
import type { IdentityAttestationProof, ZKProof } from "../proof/ProofVerifier.js"
import { Datasource } from "@/model/datasource.js"
import type { DataSource } from "typeorm"
import { In } from "typeorm"
import { UsedNullifier } from "@/model/entities/GCRv2/UsedNullifier.js"
import { MerkleTreeState } from "@/model/entities/GCRv2/MerkleTreeState.js"

describe("ProofVerifier", () => {
    let dataSource: DataSource
    let verifier: ProofVerifier

    beforeAll(async () => {
        // Initialize database connection
        const db = await Datasource.getInstance()
        dataSource = db.getDataSource()
        verifier = new ProofVerifier(dataSource)

        // Setup test data: Create a Merkle tree state
        const merkleStateRepo = dataSource.getRepository(MerkleTreeState)
        await merkleStateRepo.save({
            treeId: "global",
            rootHash:
                "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
            blockNumber: 1,
            leafCount: 1,
            treeSnapshot: {},
        })
    })

    afterAll(async () => {
        // Cleanup test data
        const nullifierRepo = dataSource.getRepository(UsedNullifier)
        const merkleStateRepo = dataSource.getRepository(MerkleTreeState)

        // Only delete nullifiers created in this test suite
        await nullifierRepo.delete({
            nullifierHash: In(["test_nullifier_already_used", "test_nullifier_mark"]),
        })
        await merkleStateRepo.delete({ treeId: "global" })
    })

    describe("verifyIdentityAttestation", () => {
        it("should reject proof with invalid public signals format", async () => {
            const invalidAttestation: IdentityAttestationProof = {
                proof: {
                    pi_a: [],
                    pi_b: [],
                    pi_c: [],
                    protocol: "groth16",
                },
                publicSignals: ["only_one"], // Invalid: requires exactly 3 elements (nullifier, merkle_root, context)
            }

            const result = await verifier.verifyIdentityAttestation(invalidAttestation)

            expect(result.valid).toBe(false)
            expect(result.reason).toContain("Invalid public signals format")
        })

        it("should reject proof with invalid cryptographic proof", async () => {
            const invalidProof: IdentityAttestationProof = {
                proof: {
                    pi_a: ["1", "2", "1"],
                    pi_b: [
                        ["1", "2"],
                        ["3", "4"],
                        ["1", "0"],
                    ],
                    pi_c: ["1", "2", "1"],
                    protocol: "groth16",
                },
                publicSignals: [
                    "12345", // nullifier
                    "12345678901234567890123456789012345678901234567890123456789012345678901234567890", // merkle_root (matches our test state)
                    "67890", // context
                ],
            }

            const result = await verifier.verifyIdentityAttestation(invalidProof)

            expect(result.valid).toBe(false)
            expect(result.reason).toContain("Proof failed cryptographic verification")
        })

        it("should reject proof with already used nullifier", async () => {
            // First, mark a nullifier as used
            const testNullifier = "test_nullifier_already_used"
            await verifier.markNullifierUsed(testNullifier, 1, "test_tx_hash")

            // Create attestation with the used nullifier
            const attestation: IdentityAttestationProof = {
                proof: {
                    pi_a: ["1", "2", "1"],
                    pi_b: [
                        ["1", "2"],
                        ["3", "4"],
                        ["1", "0"],
                    ],
                    pi_c: ["1", "2", "1"],
                    protocol: "groth16",
                },
                publicSignals: [
                    testNullifier, // Already used
                    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                    "67890",
                ],
            }

            // Mock the cryptographic verification to pass (we're testing nullifier check)
            const originalVerify = ProofVerifier.verifyProofOnly
            // @ts-expect-error - Mocking static method for test
            ProofVerifier.verifyProofOnly = async () => true

            try {
                const result = await verifier.verifyIdentityAttestation(attestation)
                expect(result.valid).toBe(false)
                expect(result.reason).toContain("Nullifier already used")
            } finally {
                // Restore original method
                // @ts-expect-error - Restoring mocked static method
                ProofVerifier.verifyProofOnly = originalVerify
            }
        })

        it("should reject proof with non-current Merkle root", async () => {
            const attestation: IdentityAttestationProof = {
                proof: {
                    pi_a: ["1", "2", "1"],
                    pi_b: [
                        ["1", "2"],
                        ["3", "4"],
                        ["1", "0"],
                    ],
                    pi_c: ["1", "2", "1"],
                    protocol: "groth16",
                },
                publicSignals: [
                    "test_nullifier_wrong_root",
                    "99999999999999999999999999999999999999999999999999999999999999999999999999999999", // Wrong root
                    "67890",
                ],
            }

            // Mock the cryptographic verification to pass (we're testing Merkle root check)
            const originalVerify = ProofVerifier.verifyProofOnly
            // @ts-expect-error - Mocking static method for test
            ProofVerifier.verifyProofOnly = async () => true

            try {
                const result = await verifier.verifyIdentityAttestation(attestation)
                expect(result.valid).toBe(false)
                expect(result.reason).toContain("Merkle root does not match current tree state")
            } finally {
                // Restore original method
                // @ts-expect-error - Restoring mocked static method
                ProofVerifier.verifyProofOnly = originalVerify
            }
        })
    })

    describe("markNullifierUsed", () => {
        it("should successfully mark a nullifier as used", async () => {
            const nullifierHash = "test_nullifier_mark"
            const blockNumber = 100
            const txHash = "test_tx_hash_123"

            await verifier.markNullifierUsed(nullifierHash, blockNumber, txHash)

            // Verify it was saved
            const nullifierRepo = dataSource.getRepository(UsedNullifier)
            const saved = await nullifierRepo.findOne({
                where: { nullifierHash },
            })

            expect(saved).toBeDefined()
            expect(saved?.nullifierHash).toBe(nullifierHash)
            expect(saved?.blockNumber).toBe(blockNumber)
            expect(saved?.transactionHash).toBe(txHash)
        })
    })

    describe("verifyProofOnly", () => {
        it("should load verification key and attempt cryptographic verification", async () => {
            // This will fail with invalid proof but should not throw
            const invalidProof: ZKProof = {
                pi_a: ["1", "2", "1"],
                pi_b: [
                    ["1", "2"],
                    ["3", "4"],
                    ["1", "0"],
                ],
                pi_c: ["1", "2", "1"],
                protocol: "groth16",
            }

            const result = await ProofVerifier.verifyProofOnly(invalidProof, ["1", "2", "3"])

            // Should return false for invalid proof, not throw error
            expect(result).toBe(false)
        })
    })
})

/**
 * NOTE: For full E2E testing with real proofs:
 *
 * 1. Generate a valid proof using the circuit:
 *    - Use identity_with_merkle.circom
 *    - Create real commitment in Merkle tree
 *    - Generate proof with valid witness
 *
 * 2. Test the complete verification flow:
 *    - Verify cryptographically passes
 *    - Nullifier is unique
 *    - Merkle root matches current state
 *    - All checks pass → proof accepted
 *
 * 3. Integration with transaction processing:
 *    - Test as part of transaction validation
 *    - Verify nullifier gets marked as used
 *    - Verify points are awarded after successful verification
 */
