// TODO GCREditIdentity but typed as any due to union type constraints <- we have a lot of editOperations marked as any. Why is that? Should we standardize the identity operation types?

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import { GCREdit, Web2GCRData } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import ensureGCRForUser from "./ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import {
    PqcIdentityEdit,
    SavedXmIdentity,
} from "@/model/entities/types/IdentityTypes"
import log from "@/utilities/logger"
import { IncentiveManager } from "./IncentiveManager"
import { ProofVerifier } from "@/features/zk/proof/ProofVerifier"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment"
import { UsedNullifier } from "@/model/entities/GCRv2/UsedNullifier"
import {
    IdentityCommitmentPayload,
    IdentityAttestationPayload,
} from "@/features/zk/types"
import Datasource from "@/model/datasource"

export default class GCRIdentityRoutines {
    // SECTION XM Identity Routines
    static async applyXmIdentityAdd(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const {
            chain,
            isEVM,
            subchain,
            targetAddress,
            signature,
            timestamp,
            signedData,
        } = editOperation.data

        // REVIEW: Is there a better way to check this?
        if (
            !chain ||
            !subchain ||
            typeof isEVM !== "boolean" ||
            !targetAddress ||
            !signature ||
            !timestamp ||
            !signedData
        ) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const normalizedAddress = isEVM
            ? targetAddress.toLowerCase()
            : targetAddress

        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.xm[chain] = accountGCR.identities.xm[chain] || {}
        accountGCR.identities.xm[chain][subchain] =
            accountGCR.identities.xm[chain][subchain] || []

        const addressExists = accountGCR.identities.xm[chain][subchain].some(
            (id: SavedXmIdentity) =>
                isEVM
                    ? id.address.toLowerCase() === normalizedAddress
                    : id.address === normalizedAddress,
        )

        if (addressExists) {
            return { success: false, message: "Identity already exists" }
        }

        const data = {
            address: normalizedAddress,
            signature: editOperation.data.signature,
            publicKey: editOperation.data.publicKey || "",
            timestamp: editOperation.data.timestamp,
            signedData: editOperation.data.signedData,
        }

        accountGCR.identities.xm[chain][subchain].push(data)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Check if this is the first connection
             */
            const isFirst = await this.isFirstConnection(
                "web3",
                {
                    chain,
                    subchain,
                    address: normalizedAddress,
                },
                gcrMainRepository,
                editOperation.account,
            )

            /**
             * Award incentive points for wallet linking
             */
            if (isFirst) {
                await IncentiveManager.walletLinked(
                    accountGCR.pubkey,
                    normalizedAddress,
                    chain,
                    editOperation.referralCode,
                )
            }
        }

        return { success: true, message: "Identity applied" }
    }

    static async applyXmIdentityRemove(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { chain, isEVM, subchain, targetAddress } = editOperation.data

        if (!chain || !subchain || !targetAddress) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const normalizedAddress = isEVM
            ? targetAddress.toLowerCase()
            : targetAddress

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        if (
            !accountGCR.identities ||
            !accountGCR.identities.xm ||
            !accountGCR.identities.xm[chain] ||
            !Array.isArray(accountGCR.identities.xm[chain][subchain])
        ) {
            return {
                success: false,
                message: "No identities found for the specified chain/subchain",
            }
        }

        const addressExists = accountGCR.identities.xm[chain][subchain].some(
            (addr: SavedXmIdentity) =>
                isEVM
                    ? addr.address.toLowerCase() === normalizedAddress
                    : addr.address === normalizedAddress,
        )

        if (!addressExists) {
            return { success: false, message: "Identity not found" }
        }

        accountGCR.identities.xm[chain][subchain] = accountGCR.identities.xm[
            chain
        ][subchain].filter((id: SavedXmIdentity) =>
            isEVM
                ? id.address.toLowerCase() !== normalizedAddress
                : id.address !== normalizedAddress,
        )

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Deduct incentive points for wallet unlinking
             */
            await IncentiveManager.walletUnlinked(
                accountGCR.pubkey,
                normalizedAddress,
                chain,
            )
        }

        return { success: true, message: "Identity removed" }
    }

    // SECTION Web2 Identity Routines
    static async applyWeb2IdentityAdd(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, data } = editOperation.data as Web2GCRData
        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        const exists = accountGCR.identities.web2[context].some(
            (id: Web2GCRData["data"]) => id.userId === data.userId,
        )

        if (exists) {
            return { success: false, message: "Identity already exists" }
        }

        /**
         * Verify the proof
         */
        let proofOk = false

        if (context === "telegram") {
            // Telegram uses dual signature validation (user + bot signatures)
            // The proof is a TelegramSignedAttestation object, not a URL
            try {
                // Import verifyWeb2Proof which handles telegram verification
                const { verifyWeb2Proof } = await import("@/libs/abstraction")

                const verificationResult = await verifyWeb2Proof(
                    {
                        context: "telegram",
                        username: data.username,
                        userId: data.userId,
                        proof: data.proof,
                    },
                    accountGCR.pubkey, // sender's ed25519 address
                )

                proofOk = verificationResult.success

                if (!proofOk) {
                    log.error(
                        `Telegram verification failed: ${verificationResult.message}`,
                    )
                    return {
                        success: false,
                        message: verificationResult.message,
                    }
                }

                log.info(
                    `Telegram identity verified: ${data.username} (${data.userId})`,
                )
            } catch (error) {
                log.error(`Telegram proof verification failed: ${error}`)
                proofOk = false
            }
        } else {
            // Standard SHA256 proof validation for other platforms
            proofOk = Hashing.sha256(data.proof) === data.proofHash
        }

        if (!proofOk) {
            return {
                success: false,
                message:
                    context === "telegram"
                        ? "Telegram attestation validation failed"
                        : "Sha256 proof mismatch: Expected " +
                          data.proofHash +
                          " but got " +
                          Hashing.sha256(data.proof),
            }
        }

        accountGCR.identities.web2[context].push(data)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Only award points if this is the first time this identity is being connected
             */
            if (context === "twitter") {
                const isFirst = await this.isFirstConnection(
                    "twitter",
                    { userId: data.userId },
                    gcrMainRepository,
                    editOperation.account,
                )
                if (isFirst) {
                    await IncentiveManager.twitterLinked(
                        editOperation.account,
                        data.userId,
                        editOperation.referralCode,
                    )
                }
            } else if (context === "github") {
                const isFirst = await this.isFirstConnection(
                    "github",
                    { userId: data.userId },
                    gcrMainRepository,
                    editOperation.account,
                )
                if (isFirst) {
                    await IncentiveManager.githubLinked(
                        editOperation.account,
                        data.userId,
                        editOperation.referralCode,
                    )
                }
            } else if (context === "telegram") {
                const isFirst = await this.isFirstConnection(
                    "telegram",
                    { userId: data.userId },
                    gcrMainRepository,
                    editOperation.account,
                )
                if (isFirst) {
                    // REVIEW: Pass attestation to check group membership for conditional points
                    await IncentiveManager.telegramLinked(
                        editOperation.account,
                        data.userId,
                        editOperation.referralCode,
                        data.proof, // TelegramSignedAttestation with group_membership field
                    )
                }
            } else if (context === "discord") {
                const isFirst = await this.isFirstConnection(
                    "discord",
                    { userId: data.userId },
                    gcrMainRepository,
                    editOperation.account,
                )
                if (isFirst) {
                    await IncentiveManager.discordLinked(
                        editOperation.account,
                        editOperation.referralCode,
                    )
                }
            } else {
                log.info(`Web2 identity linked: ${context}/${data.username}`)
            }
        }

        return { success: true, message: "Web2 identity added" }
    }

    static async applyWeb2IdentityRemove(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, username } = editOperation.data as {
            context: string
            username: string
        }
        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        const exists = accountGCR.identities.web2[context].some(
            (id: Web2GCRData["data"]) => id.username === username,
        )

        if (!exists) {
            return { success: false, message: "Identity not found" }
        }

        // Store the identity being removed for GitHub and Telegram unlinking (need userId)
        let removedIdentity: Web2GCRData["data"] | null = null
        if (context === "github" || context === "telegram") {
            removedIdentity =
                accountGCR.identities.web2[context].find(
                    (id: Web2GCRData["data"]) => id.username === username,
                ) || null
        }

        accountGCR.identities.web2[context] = accountGCR.identities.web2[
            context
        ].filter((id: Web2GCRData["data"]) => id.username !== username)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Deduct incentive points for Twitter unlinking
             */
            if (context === "twitter") {
                await IncentiveManager.twitterUnlinked(editOperation.account)
            } else if (
                context === "github" &&
                removedIdentity &&
                removedIdentity.userId
            ) {
                await IncentiveManager.githubUnlinked(
                    editOperation.account,
                    removedIdentity.userId,
                )
            } else if (
                context === "telegram" &&
                removedIdentity &&
                removedIdentity.userId
            ) {
                await IncentiveManager.telegramUnlinked(editOperation.account)
            } else if (context === "discord") {
                await IncentiveManager.discordUnlinked(editOperation.account)
            }
        }

        return { success: true, message: "Web2 identity removed" }
    }

    // SECTION PQC Identity Routines
    static async applyPqcIdentityAdd(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const identities: PqcIdentityEdit[] = editOperation.data

        if (!Array.isArray(identities)) {
            return {
                success: false,
                message: "Invalid edit operation data: expected array",
            }
        }

        const accountGCR = await ensureGCRForUser(editOperation.account)
        accountGCR.identities.pqc = accountGCR.identities.pqc || {}

        for (const identity of identities) {
            const { algorithm, address, signature, timestamp } = identity

            if (!algorithm || !address || !signature || !timestamp) {
                return {
                    success: false,
                    message:
                        "Invalid identity data: missing algorithm, address or signature",
                }
            }

            accountGCR.identities.pqc[algorithm] =
                accountGCR.identities.pqc[algorithm] || []

            const keyExists = accountGCR.identities.pqc[algorithm].some(
                (key: { address: string; signature: string }) =>
                    key.address === address,
            )

            if (keyExists) {
                return {
                    success: false,
                    message: `Identity already exists for algorithm ${algorithm}`,
                }
            }

            accountGCR.identities.pqc[algorithm].push({
                address,
                signature,
                timestamp,
            })
        }

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "PQC identities added" }
    }

    static async applyPqcIdentityRemove(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const identities = editOperation.data

        if (!Array.isArray(identities)) {
            return {
                success: false,
                message: "Invalid edit operation data: expected array",
            }
        }

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        if (!accountGCR.identities || !accountGCR.identities.pqc) {
            return {
                success: false,
                message: "No PQC identities found",
            }
        }

        for (const identity of identities) {
            const { algorithm, address } = identity

            if (!algorithm || !address) {
                return {
                    success: false,
                    message:
                        "Invalid identity data: missing algorithm or address",
                }
            }

            if (
                !accountGCR.identities.pqc[algorithm] ||
                !Array.isArray(accountGCR.identities.pqc[algorithm])
            ) {
                return {
                    success: false,
                    message: `No PQC identities found for algorithm ${algorithm}`,
                }
            }

            const keyExists = accountGCR.identities.pqc[algorithm].some(
                (key: { address: string; signature: string }) =>
                    key.address === address,
            )

            if (!keyExists) {
                return {
                    success: false,
                    message: `Identity not found for algorithm ${algorithm}`,
                }
            }

            accountGCR.identities.pqc[algorithm] = accountGCR.identities.pqc[
                algorithm
            ].filter(
                (key: { address: string; signature: string }) =>
                    key.address !== address,
            )
        }

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)
        }

        return { success: true, message: "PQC identities removed" }
    }

    static async applyAwardPoints(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { account: address, amount, date } = editOperation
        const account = await ensureGCRForUser(address)

        const challengeEntry = {
            date,
            points: amount,
        }

        if (!account.points.breakdown.weeklyChallenge) {
            account.points.breakdown.weeklyChallenge = []
        }

        account.points.breakdown.weeklyChallenge.push(challengeEntry)
        account.points.totalPoints = (account.points.totalPoints || 0) + amount
        account.points.lastUpdated = new Date()

        if (!simulate) {
            await gcrMainRepository.save(account)
        }

        return { success: true, message: "Points awarded" }
    }

    static async applyAwardPointsRollback(
        editOperation: any, // GCREditIdentity but typed as any due to union type constraints
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { account: address, amount, date } = editOperation
        const account = await ensureGCRForUser(address)

        if (!account.points.breakdown.weeklyChallenge) {
            account.points.breakdown.weeklyChallenge = []
        }

        account.points.breakdown.weeklyChallenge =
            account.points.breakdown.weeklyChallenge.filter(
                (entry: { date: string }) => entry.date !== date,
            )

        account.points.totalPoints =
            (account.points.totalPoints || 0) - amount < 0
                ? 0
                : account.points.totalPoints - amount

        if (!simulate) {
            await gcrMainRepository.save(account)
        }

        return { success: true, message: "Points deducted" }
    }

    // SECTION ZK Identity Routines

    /**
     * Process ZK commitment addition
     * Stores user's identity commitment (to be added to Merkle tree during block commit)
     */
    static async applyZkCommitmentAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const payload = editOperation.data as IdentityCommitmentPayload

        // Validate commitment format (should be 64-char hex or large number string)
        if (!payload.commitment_hash || typeof payload.commitment_hash !== "string") {
            return {
                success: false,
                message: "Invalid commitment hash format",
            }
        }

        // Get datasource for IdentityCommitment repository
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()
        const commitmentRepo = dataSource.getRepository(IdentityCommitment)

        // REVIEW: Removed check-then-insert TOCTOU race condition
        // Primary key constraint on commitmentHash prevents duplicates at DB level
        if (!simulate) {
            try {
                await commitmentRepo.save({
                    commitmentHash: payload.commitment_hash,
                    leafIndex: -1, // Placeholder, will be updated during Merkle tree insertion
                    provider: payload.provider,
                    blockNumber: 0, // Will be updated during block commit
                    timestamp: payload.timestamp.toString(),
                    transactionHash: editOperation.txhash || "",
                })

                log.info(
                    `✅ ZK commitment stored: ${payload.commitment_hash.slice(0, 10)}... (provider: ${payload.provider})`,
                )
            } catch (error: any) {
                // Handle primary key constraint violation (commitment already exists)
                if (error.code === "23505" || error.code === "SQLITE_CONSTRAINT") {
                    return {
                        success: false,
                        message: "Commitment already exists",
                    }
                }
                // Re-throw other errors
                throw error
            }
        }

        return {
            success: true,
            message: "ZK commitment stored (pending Merkle tree insertion)",
        }
    }

    /**
     * Process ZK attestation (anonymous identity proof)
     * Verifies ZK-SNARK proof and awards points if valid
     */
    static async applyZkAttestationAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const payload = editOperation.data as IdentityAttestationPayload

        // Validate payload structure
        if (
            !payload.nullifier_hash ||
            !payload.merkle_root ||
            !payload.proof ||
            !payload.public_signals
        ) {
            return {
                success: false,
                message: "Invalid ZK attestation payload",
            }
        }

        // Get datasource for verification
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()
        const verifier = new ProofVerifier(dataSource)

        // Verify the ZK proof (3-step verification: crypto + nullifier + root)
        const verificationResult = await verifier.verifyIdentityAttestation({
            proof: payload.proof,
            publicSignals: payload.public_signals,
        })

        if (!verificationResult.valid) {
            log.warn(
                `❌ ZK attestation verification failed: ${verificationResult.reason}`,
            )
            return {
                success: false,
                message: `ZK proof verification failed: ${verificationResult.reason}`,
            }
        }

        // Mark nullifier as used (prevent double-attestation)
        if (!simulate) {
            await verifier.markNullifierUsed(
                payload.nullifier_hash,
                0, // Block number will be updated during block commit
                editOperation.txhash || "",
            )

            // REVIEW: Award points for ZK attestation
            // REVIEW: Phase 10.1 - Configurable ZK attestation points
            // Note: We don't know which specific account this is (that's the point of ZK!)
            // But we can still award points based on the nullifier uniqueness
            // The user who submitted this transaction gets the points
            const account = await ensureGCRForUser(editOperation.account)

            // Get configurable points from environment (default: 10)
            const zkAttestationPoints = parseInt(
                process.env.ZK_ATTESTATION_POINTS || "10",
                10,
            )

            // Validate environment variable
            if (isNaN(zkAttestationPoints) || zkAttestationPoints < 0) {
                log.error(
                    `Invalid ZK_ATTESTATION_POINTS configuration: ${process.env.ZK_ATTESTATION_POINTS}`,
                )
                return {
                    success: false,
                    message: "System configuration error: invalid attestation points",
                }
            }

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

            await gcrMainRepository.save(account)

            log.info(
                `✅ ZK attestation verified and points awarded (nullifier: ${payload.nullifier_hash.slice(0, 10)}...)`,
            )
        }

        return {
            success: true,
            message: "ZK attestation verified and points awarded",
        }
    }

    static async apply(
        editOperation: GCREdit,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        if (
            editOperation.type !== "identity" ||
            !("context" in editOperation)
        ) {
            return {
                success: false,
                message: "Invalid edit operation for identity routine",
            }
        }

        const identityEdit = structuredClone(editOperation)

        let operation = identityEdit.operation
        if (identityEdit.isRollback) {
            operation = operation === "add" ? "remove" : "add"
        }

        let result: GCRResult

        // CONVERT operation.account to hex
        identityEdit.account =
            typeof identityEdit.account === "string"
                ? identityEdit.account
                : forgeToHex(identityEdit.account)

        switch (identityEdit.context + operation) {
            case "xmadd":
                result = await this.applyXmIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "xmremove":
                result = await this.applyXmIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2add":
                result = await this.applyWeb2IdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "web2remove":
                result = await this.applyWeb2IdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pqcadd":
                result = await this.applyPqcIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pqcremove":
                result = await this.applyPqcIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pointsadd":
                result = await this.applyAwardPoints(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "pointsremove":
                result = await this.applyAwardPointsRollback(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "zk_commitmentadd":
                result = await this.applyZkCommitmentAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "zk_attestationadd":
                result = await this.applyZkAttestationAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            default:
                result = {
                    success: false,
                    message: "Unsupported identity operation",
                }
        }

        return result
    }

    private static async isFirstConnection(
        type: "twitter" | "github" | "web3" | "telegram" | "discord",
        data: {
            userId?: string // for twitter/github/discord
            chain?: string // for web3
            subchain?: string // for web3
            address?: string // for web3
        },
        gcrMainRepository: Repository<GCRMain>,
        currentAccount?: string,
    ): Promise<boolean> {
        if (type !== "web3") {
            const queryTemplate = `
            EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'web2'->'${type}', '[]'::jsonb)) as ${type}_id WHERE ${type}_id->>'userId' = :userId)
        `

            const result = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(queryTemplate, { userId: data.userId })
                .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
                .getOne()

            return !result
        }

        // if (type === "twitter") {
        //     /**
        //      * Check if this Twitter userId exists anywhere
        //      */
        //     const result = await gcrMainRepository
        //         .createQueryBuilder("gcr")
        //         .where(
        //             "EXISTS (SELECT 1 FROM jsonb_array_elements(gcr.identities->'web2'->'twitter') as twitter_id WHERE twitter_id->>'userId' = :userId)",
        //             {
        //                 userId: data.userId,
        //             },
        //         )
        //         .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
        //         .getOne()

        //     /**
        //      * Return true if no account has this userId
        //      */
        //     return !result
        // } else if (type === "github") {
        //     /**
        //      * Check if this GitHub userId exists anywhere
        //      */
        //     const result = await gcrMainRepository
        //         .createQueryBuilder("gcr")
        //         .where(
        //             "EXISTS (SELECT 1 FROM jsonb_array_elements(gcr.identities->'web2'->'github') as github_id WHERE github_id->>'userId' = :userId)",
        //             {
        //                 userId: data.userId,
        //             },
        //         )
        //         .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
        //         .getOne()

        //     /**
        //      * Return true if no account has this userId
        //      */
        //     return !result
        // } else if (type === "discord") {
        //     /**
        //      * Check if this Discord userId exists anywhere
        //      */
        //     const result = await gcrMainRepository
        //         .createQueryBuilder("gcr")
        //         .where(
        //             "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'web2'->'discord', '[]'::jsonb)) AS discord_id WHERE discord_id->>'userId' = :userId)",
        //             { userId: data.userId },
        //         )
        //         .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
        //         .getOne()

        //     /**
        //      * Return true if no account has this userId
        //      */
        //     return !result
        // } else {
        /**
         * For web3 wallets, check if this address exists in any account for this chain/subchain
         */
        const addressToCheck =
            data.chain === "evm" ? data.address.toLowerCase() : data.address

        const result = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where(
                "EXISTS (SELECT 1 FROM jsonb_array_elements(gcr.identities->'xm'->:chain->:subchain) as xm_id WHERE xm_id->>'address' = :address)",
                {
                    chain: data.chain,
                    subchain: data.subchain,
                    address: addressToCheck,
                },
            )
            .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
            .getOne()

        /**
         * Return true if this is the first connection
         */
        return !result
        // }
    }
}
