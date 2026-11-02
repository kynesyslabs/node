import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { EntityManager, Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { ProofVerifier } from "@/features/zk/proof/ProofVerifier"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment"
import {
    IdentityCommitmentPayload,
    IdentityAttestationPayload,
} from "@/features/zk/types"
import Datasource from "@/model/datasource"
import { Config } from "src/config"
import log from "@/utilities/logger"

/**
 * Process ZK commitment addition
 * Stores user's identity commitment (to be added to Merkle tree during block commit)
 */
export async function applyZkCommitmentAdd(
    editOperation: any,
    simulate: boolean,
): Promise<GCRResult> {
    const payload = Array.isArray(editOperation.data)
        ? (editOperation.data[0] as IdentityCommitmentPayload | undefined)
        : (editOperation.data as IdentityCommitmentPayload | undefined)

    // REVIEW: HIGH FIX - Strengthen commitment hash format validation
    // Validate commitment format (should be 64-char hex or large number string)
    if (
        !payload.commitment_hash ||
        typeof payload.commitment_hash !== "string" ||
        payload.commitment_hash.length === 0
    ) {
        return {
            success: false,
            message: "Invalid commitment hash format",
        }
    }

    // Validate format: either 64-char hex (with optional 0x prefix) or numeric string
    const hexPattern = /^(0x)?[0-9a-fA-F]{64}$/
    const isValidHex = hexPattern.test(payload.commitment_hash)
    const isValidNumber =
        /^\d+$/.test(payload.commitment_hash) && payload.commitment_hash.length > 0

    if (!isValidHex && !isValidNumber) {
        return {
            success: false,
            message: "Commitment hash must be 64-char hex or numeric string",
        }
    }

    // REVIEW: CRITICAL FIX - Normalize commitment hash to prevent duplicates
    // Remove 0x prefix and convert hex to lowercase for consistent storage
    // This prevents "0x1234..." and "1234..." from being stored as separate records
    const normalizedCommitment = isValidHex
        ? payload.commitment_hash.toLowerCase().replace(/^0x/, "")
        : payload.commitment_hash

    // REVIEW: MEDIUM FIX - Add provider field validation
    if (
        !payload.provider ||
        typeof payload.provider !== "string" ||
        payload.provider.trim().length === 0
    ) {
        return {
            success: false,
            message: "Invalid or missing provider field",
        }
    }

    // REVIEW: MEDIUM FIX - Add timestamp validation
    if (!payload.timestamp || typeof payload.timestamp !== "number") {
        return {
            success: false,
            message: "Invalid or missing timestamp",
        }
    }

    // Get datasource for IdentityCommitment repository
    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()
    const commitmentRepo = dataSource.getRepository(IdentityCommitment)

    if (simulate) {
        return {
            success: true,
            message: "ZK commitment stored (pending Merkle tree insertion)",
        }
    }

    // Refused here, not in the block's transaction, so a duplicate fails
    // this transaction alone. The primary key still guards the write.
    const existing = await commitmentRepo.findOne({
        where: { commitmentHash: normalizedCommitment },
    })
    if (existing) {
        return {
            success: false,
            message: "Commitment already exists",
        }
    }

    const row = {
        commitmentHash: normalizedCommitment,
        leafIndex: -1, // Placeholder, will be updated during Merkle tree insertion
        provider: payload.provider,
        blockNumber: 0, // Will be updated during block commit
        timestamp: payload.timestamp.toString(),
        transactionHash: editOperation.txhash || "",
    }

    return {
        success: true,
        message: "ZK commitment stored (pending Merkle tree insertion)",
        // Stored with the block that carries the transaction
        deferredWrite: async (em: EntityManager) => {
            await em.getRepository(IdentityCommitment).insert(row)
            log.info(
                `✅ ZK commitment stored: ${normalizedCommitment.slice(0, 10)}... (provider: ${payload.provider})`,
            )
        },
    }
}

/**
 * Process ZK attestation (anonymous identity proof)
 * Verifies ZK-SNARK proof and awards points if valid
 */
export async function applyZkAttestationAdd(
    editOperation: any,
    simulate: boolean,
): Promise<GCRResult> {
    const payload = Array.isArray(editOperation.data)
        ? (editOperation.data[0] as IdentityAttestationPayload | undefined)
        : (editOperation.data as IdentityAttestationPayload | undefined)

    // REVIEW: MEDIUM FIX - Validate payload structure with type and format checks
    if (
        !payload.nullifier_hash ||
        typeof payload.nullifier_hash !== "string" ||
        payload.nullifier_hash.length === 0 ||
        !payload.merkle_root ||
        typeof payload.merkle_root !== "string" ||
        payload.merkle_root.length === 0 ||
        !payload.proof ||
        typeof payload.proof !== "object" ||
        !payload.public_signals ||
        !Array.isArray(payload.public_signals)
    ) {
        return {
            success: false,
            message: "Invalid ZK attestation payload",
        }
    }

    // REVIEW: MEDIUM FIX - Validate nullifier hash format (should match commitment format)
    const hexPattern = /^(0x)?[0-9a-fA-F]{64}$/
    const isValidNullifier =
        hexPattern.test(payload.nullifier_hash) ||
        (/^\d+$/.test(payload.nullifier_hash) && payload.nullifier_hash.length > 0)

    if (!isValidNullifier) {
        return {
            success: false,
            message: "Invalid nullifier hash format",
        }
    }

    // Get datasource for verification
    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()
    const verifier = new ProofVerifier(dataSource)

    // REVIEW: HIGH FIX - Validate env configuration BEFORE transaction to avoid wasting resources
    // Get configurable points from config (default: 10)
    const zkAttestationPoints = Config.getInstance().identity.zkAttestationPoints

    // Validate configuration before starting transaction
    if (isNaN(zkAttestationPoints) || zkAttestationPoints < 0) {
        log.error(
            `Invalid ZK_ATTESTATION_POINTS configuration: ${zkAttestationPoints}`,
        )
        return {
            success: false,
            message: "System configuration error: invalid attestation points",
        }
    }

    // Checked now, without marking the nullifier, so an invalid proof fails
    // this transaction alone. The nullifier is marked and the points awarded
    // in the block's transaction, where the proof is verified once more
    // under a lock on the nullifier.
    const verificationResult = await verifier.checkIdentityAttestation({
        proof: payload.proof,
        publicSignals: payload.public_signals,
    })

    if (!verificationResult.valid) {
        log.warn(
            `❌ ZK attestation verification failed${simulate ? " (simulate)" : ""}: ${verificationResult.reason}`,
        )
        return {
            success: false,
            message: `ZK proof verification failed: ${verificationResult.reason}`,
        }
    }

    if (simulate) {
        log.info(
            "✅ ZK attestation verified (simulate mode - no points awarded)",
        )
        return {
            success: true,
            message: "ZK attestation verified (simulation)",
        }
    }

    const submitter = editOperation.account as string
    const transactionHash = editOperation.txhash || ""

    return {
        success: true,
        message: "ZK attestation verified and points awarded",
        deferredWrite: async (em: EntityManager) => {
            // Pessimistic lock on the nullifier, then marked with the real values
            const locked = await verifier.verifyIdentityAttestation(
                {
                    proof: payload.proof,
                    publicSignals: payload.public_signals,
                },
                em,
                {
                    blockNumber: 0, // Will be updated during block commit
                    transactionHash,
                },
            )
            if (!locked.valid) {
                throw new Error(
                    `ZK proof verification failed at commit: ${locked.reason}`,
                )
            }

            // Design Note: ZK Privacy vs Points
            // - The ZK proof preserves identity privacy (we don't know WHICH identity proved ownership)
            // - The transaction submitter (editOperation.account) receives points
            // - The submitter may or may not be the identity holder (could be a relayer)
            // - This is intentional: points reward the transaction submission, not identity disclosure
            // - For fully private identities, users can choose not to submit attestation transactions
            //
            // Read through the manager: the block's balance and nonce edits for
            // this account are already written in this transaction.
            const account = await ensureGCRForUser(submitter, em)

            const zkAttestationEntry = {
                date: new Date().toISOString(),
                points: zkAttestationPoints,
                nullifier: payload.nullifier_hash.slice(0, 10) + "...", // Store abbreviated for reference
            }

            if (!account.points.breakdown.zkAttestation) {
                account.points.breakdown.zkAttestation = []
            }

            account.points.breakdown.zkAttestation.push(zkAttestationEntry)
            account.points.totalPoints =
                (account.points.totalPoints || 0) + zkAttestationPoints
            account.points.lastUpdated = new Date()

            await em.save(account)

            log.info(
                `✅ ZK attestation verified and points awarded (nullifier: ${payload.nullifier_hash.slice(0, 10)}...)`,
            )
        },
    }
}
