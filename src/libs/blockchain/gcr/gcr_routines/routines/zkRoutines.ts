import { applyTime } from "../../applyTime"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import type { GCREntityCaches, GCRResult } from "../../handleGCR"
import { EntityManager, Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { ProofVerifier } from "@/features/zk/proof/ProofVerifier"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment"
import { MerkleTreeState } from "@/model/entities/GCRv2/MerkleTreeState"
import { GLOBAL_TREE_CAPACITY, GLOBAL_TREE_ID } from "@/features/zk/merkle/globalTree"
import {
    IdentityCommitmentPayload,
    IdentityAttestationPayload,
} from "@/features/zk/types"
import Datasource from "@/model/datasource"
import { Config } from "src/config"
import log from "@/utilities/logger"
import {
    NUL_NOT_STORABLE,
    fitsIndexKey,
    isBigintStorable,
    isTextStorable,
} from "@/libs/blockchain/validation/postgresStorable"
import {
    ATTESTATION_CONTEXT,
    ATTESTATION_CONTEXT_SIGNAL,
    BN254_FIELD_ORDER,
    parseIdentityPublicSignals,
} from "@/features/zk/proof/publicSignals"

export const PROVIDER_MAX_BYTES = 64

/**
 * Process ZK commitment addition
 * Stores user's identity commitment (to be added to Merkle tree during block commit)
 */
export async function applyZkCommitmentAdd(
    editOperation: any,
    simulate: boolean,
    /** The set being applied; a hash it already claims is refused. */
    entities?: GCREntityCaches,
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

    // The tree takes a field element, written as 64 hex digits or in
    // canonical decimal, the form the SDK writes. Any other spelling of an
    // element would be a second key for the same leaf, and digits without
    // bound would be a primary key Postgres cannot index, failing the block's
    // commit on every node.
    const hexPattern = /^(0x)?[0-9a-fA-F]{64}$/
    const isValidHex = hexPattern.test(payload.commitment_hash)
    const isValidNumber = /^(0|[1-9]\d{0,77})$/.test(payload.commitment_hash)
    let element: bigint | null = null
    if (isValidHex) element = BigInt("0x" + payload.commitment_hash.replace(/^0x/, ""))
    else if (isValidNumber) element = BigInt(payload.commitment_hash)

    if (element === null || element >= BN254_FIELD_ORDER) {
        return {
            success: false,
            message:
                "Commitment hash must be a BN254 field element: 64 hex digits or canonical decimal",
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

    // The row is inserted in the block's database transaction, where a value
    // Postgres refuses would fail the block on every node, not this one.
    if (!isTextStorable(payload.provider)) {
        return { success: false, message: `Provider ${NUL_NOT_STORABLE}` }
    }
    // Indexed. The SDK sends the provider's name ("github", "discord").
    if (!fitsIndexKey(payload.provider, PROVIDER_MAX_BYTES)) {
        return { success: false, message: `Provider is longer than ${PROVIDER_MAX_BYTES} bytes` }
    }
    if (!isBigintStorable(payload.timestamp)) {
        return { success: false, message: "Timestamp must be a whole number in the bigint range" }
    }

    // Get datasource for IdentityCommitment repository
    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()
    const commitmentRepo = dataSource.getRepository(IdentityCommitment)

    // The block commit inserts every commitment it carries into the tree, and
    // one past its capacity throws there, failing the block on every node.
    // Counted as that insert counts: the leaves the tree held when this block
    // began, plus the commitments earlier transactions of the block claimed.
    // Every zk edit of a block applies in one group, in block order, so each
    // node counts the same claims.
    const tree = await dataSource
        .getRepository(MerkleTreeState)
        .findOne({ where: { treeId: GLOBAL_TREE_ID } })
    const pending = entities?.zkCommitments?.size ?? 0
    if ((tree?.leafCount ?? 0) + pending >= GLOBAL_TREE_CAPACITY) {
        return {
            success: false,
            message: `Identity commitment tree is full (${GLOBAL_TREE_CAPACITY} leaves)`,
        }
    }

    if (simulate) {
        return {
            success: true,
            message: "ZK commitment stored (pending Merkle tree insertion)",
        }
    }

    // Refused here, not in the block's transaction, so a duplicate fails
    // this transaction alone, whether an earlier block or an earlier
    // transaction of this one stored it. The primary key still guards the
    // write.
    const claimed = entities ? (entities.zkCommitments ??= new Map()) : null
    if (claimed?.has(normalizedCommitment)) {
        return {
            success: false,
            message: "Commitment already exists in this block",
        }
    }
    const existing = await commitmentRepo.findOne({
        where: { commitmentHash: normalizedCommitment },
    })
    if (existing) {
        return {
            success: false,
            message: "Commitment already exists",
        }
    }
    claimed?.set(normalizedCommitment, true)

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
    /** The set being applied; a nullifier it already claims is refused. */
    entities?: GCREntityCaches,
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

    // Checked on the proof's own signal, before any database work: it is a
    // pure function of the signed payload, so every node, a syncing one
    // included, reaches the same verdict.
    const signals = parseIdentityPublicSignals(payload.public_signals).signals
    if (signals && signals.context !== ATTESTATION_CONTEXT_SIGNAL) {
        return {
            success: false,
            message: `ZK attestation must prove under the context "${ATTESTATION_CONTEXT}"`,
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

    // The nullifier the verifier will mark, as the proof carries it, not
    // as the payload states it. An earlier transaction of this set that
    // claimed it wins.
    const claimed = entities ? (entities.zkNullifiers ??= new Map()) : null
    const nullifier = verificationResult.nullifier
    if (claimed && nullifier) {
        if (claimed.has(nullifier)) {
            return {
                success: false,
                message: "Nullifier already used in this block",
            }
        }
        claimed.set(nullifier, true)
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
                date: applyTime().toISOString(),
                points: zkAttestationPoints,
                nullifier: payload.nullifier_hash.slice(0, 10) + "...", // Store abbreviated for reference
            }

            if (!account.points.breakdown.zkAttestation) {
                account.points.breakdown.zkAttestation = []
            }

            account.points.breakdown.zkAttestation.push(zkAttestationEntry)
            account.points.totalPoints =
                (account.points.totalPoints || 0) + zkAttestationPoints
            account.points.lastUpdated = applyTime()

            await em.save(account)

            log.info(
                `✅ ZK attestation verified and points awarded (nullifier: ${payload.nullifier_hash.slice(0, 10)}...)`,
            )
        },
    }
}
