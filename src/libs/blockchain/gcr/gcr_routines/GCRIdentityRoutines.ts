// TODO GCREditIdentity but typed as any due to union type constraints <- we have a lot of editOperations marked as any. Why is that? Should we standardize the identity operation types?

import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import {
    GCREdit,
    UDIdentityAssignPayload,
    Web2GCRData,
} from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import ensureGCRForUser from "./ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import {
    NomisWalletIdentity,
    PqcIdentityEdit,
    SavedHumanPassportIdentity,
    SavedNomisIdentity,
    SavedXmIdentity,
    SavedUdIdentity,
} from "@/model/entities/types/IdentityTypes"
import log from "@/utilities/logger"
import { IncentiveManager } from "./IncentiveManager"
import HumanPassportProvider from "@/libs/identity/tools/humanpassport"
import {
    verifyTLSNProof,
    type TLSNIdentityPayload,
    type TLSNProofRanges,
    type TLSNotaryPresentation,
} from "@/libs/tlsnotary"
import { ProofVerifier } from "@/features/zk/proof/ProofVerifier"
import { IdentityCommitment } from "@/model/entities/GCRv2/IdentityCommitment"
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
            displayAddress,
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

        const addressToStore = displayAddress || targetAddress
        const normalizedAddress = isEVM
            ? addressToStore.toLowerCase()
            : addressToStore

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

    // SECTION UD Identity Routines
    static async applyUdIdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const payload = editOperation.data as UDIdentityAssignPayload["payload"]

        // REVIEW: Validate required fields presence
        if (
            !payload.domain ||
            !payload.signingAddress ||
            !payload.signatureType ||
            !payload.signature ||
            !payload.publicKey ||
            !payload.timestamp ||
            !payload.signedData ||
            !payload.network ||
            !payload.registryType
        ) {
            return {
                success: false,
                message: "Invalid edit operation data: missing required fields",
            }
        }

        // Validate enum fields have allowed values
        const validNetworks = ["polygon", "base", "sonic", "ethereum", "solana"]
        const validRegistryTypes = ["UNS", "CNS"]

        if (!validNetworks.includes(payload.network)) {
            return {
                success: false,
                message: `Invalid network: ${
                    payload.network
                }. Must be one of: ${validNetworks.join(", ")}`,
            }
        }
        if (!validRegistryTypes.includes(payload.registryType)) {
            return {
                success: false,
                message: `Invalid registryType: ${payload.registryType}. Must be "UNS" or "CNS"`,
            }
        }

        // Validate timestamp is a valid positive number
        if (
            typeof payload.timestamp !== "number" ||
            isNaN(payload.timestamp) ||
            payload.timestamp <= 0
        ) {
            return {
                success: false,
                message: `Invalid timestamp: ${payload.timestamp}. Must be a positive number (epoch milliseconds)`,
            }
        }

        const accountGCR = await ensureGCRForUser(editOperation.account)
        accountGCR.identities.ud = accountGCR.identities.ud || []

        // Check if domain already exists for this account
        const domainExists = accountGCR.identities.ud.some(
            (id: SavedUdIdentity) =>
                id.domain.toLowerCase() === payload.domain.toLowerCase(),
        )

        if (domainExists) {
            return {
                success: false,
                message: "Domain already linked to this account",
            }
        }

        accountGCR.identities.ud.push(payload)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Check if this is the first connection for this domain
             */
            const isFirst = await this.isFirstConnection(
                "ud",
                { domain: payload.domain },
                gcrMainRepository,
                editOperation.account,
            )

            /**
             * Award incentive points for UD domain linking
             */
            if (isFirst) {
                await IncentiveManager.udDomainLinked(
                    accountGCR.pubkey,
                    payload.domain,
                    payload.signingAddress,
                    editOperation.referralCode,
                )
            }
        }

        return { success: true, message: "UD identity added" }
    }

    static async applyUdIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { domain } = editOperation.data

        if (!domain) {
            return { success: false, message: "Invalid edit operation data" }
        }

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        if (!accountGCR.identities || !accountGCR.identities.ud) {
            return {
                success: false,
                message: "No UD identities found",
            }
        }

        const domainExists = accountGCR.identities.ud.some(
            (id: SavedUdIdentity) =>
                id.domain.toLowerCase() === domain.toLowerCase(),
        )

        if (!domainExists) {
            return { success: false, message: "Domain not found" }
        }

        accountGCR.identities.ud = accountGCR.identities.ud.filter(
            (id: SavedUdIdentity) =>
                id.domain.toLowerCase() !== domain.toLowerCase(),
        )

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            /**
             * Deduct incentive points for UD domain unlinking
             */
            await IncentiveManager.udDomainUnlinked(accountGCR.pubkey, domain)
        }

        return { success: true, message: "UD identity removed" }
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

        // REVIEW: Removed check-then-insert TOCTOU race condition
        // Primary key constraint on commitmentHash prevents duplicates at DB level
        if (!simulate) {
            try {
                await commitmentRepo.save({
                    commitmentHash: normalizedCommitment,
                    leafIndex: -1, // Placeholder, will be updated during Merkle tree insertion
                    provider: payload.provider,
                    blockNumber: 0, // Will be updated during block commit
                    timestamp: payload.timestamp.toString(),
                    transactionHash: editOperation.txhash || "",
                })

                log.info(
                    `✅ ZK commitment stored: ${normalizedCommitment.slice(0, 10)}... (provider: ${payload.provider})`,
                )
            } catch (error: any) {
                // Handle primary key constraint violation (commitment already exists)
                // REVIEW: Use startsWith for SQLite constraint codes (handles all variants)
                if (error.code === "23505" || error.code?.startsWith("SQLITE_CONSTRAINT")) {
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
        // Get configurable points from environment (default: 10)
        const zkAttestationPoints = parseInt(
            process.env.ZK_ATTESTATION_POINTS || "10",
            10,
        )

        // Validate environment variable before starting transaction
        if (isNaN(zkAttestationPoints) || zkAttestationPoints < 0) {
            log.error(
                `Invalid ZK_ATTESTATION_POINTS configuration: ${process.env.ZK_ATTESTATION_POINTS}`,
            )
            return {
                success: false,
                message: "System configuration error: invalid attestation points",
            }
        }

        // REVIEW: CRITICAL FIX - Perform verification and points awarding atomically within transaction
        // This ensures nullifier marking uses correct values and prevents dirty data
        if (!simulate) {
            const queryRunner = dataSource.createQueryRunner()
            await queryRunner.connect()
            await queryRunner.startTransaction()

            try {
                // REVIEW: CRITICAL FIX - Verify ZK proof WITH transactional manager for pessimistic locking
                // Pass manager and metadata to ensure nullifier is marked with correct values only after verification
                const verificationResult = await verifier.verifyIdentityAttestation(
                    {
                        proof: payload.proof,
                        publicSignals: payload.public_signals,
                    },
                    queryRunner.manager,
                    {
                        blockNumber: 0, // Will be updated during block commit
                        transactionHash: editOperation.txhash || "",
                    },
                )

                if (!verificationResult.valid) {
                    await queryRunner.rollbackTransaction()
                    log.warn(
                        `❌ ZK attestation verification failed: ${verificationResult.reason}`,
                    )
                    return {
                        success: false,
                        message: `ZK proof verification failed: ${verificationResult.reason}`,
                    }
                }

                // REVIEW: Award points for ZK attestation atomically with nullifier update
                // REVIEW: Phase 10.1 - Configurable ZK attestation points
                //
                // Design Note: ZK Privacy vs Points
                // - The ZK proof preserves identity privacy (we don't know WHICH identity proved ownership)
                // - The transaction submitter (editOperation.account) receives points
                // - The submitter may or may not be the identity holder (could be a relayer)
                // - This is intentional: points reward the transaction submission, not identity disclosure
                // - For fully private identities, users can choose not to submit attestation transactions
                const account = await ensureGCRForUser(editOperation.account)

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

                // Save account with transaction manager for atomicity
                await queryRunner.manager.save(account)

                // Commit transaction - both nullifier update and points awarding succeed together
                await queryRunner.commitTransaction()

                log.info(
                    `✅ ZK attestation verified and points awarded (nullifier: ${payload.nullifier_hash.slice(0, 10)}...)`,
                )
            } catch (error) {
                await queryRunner.rollbackTransaction()
                throw error
            } finally {
                await queryRunner.release()
            }
        } else {
            // REVIEW: CRITICAL FIX - Simulate path: verify without transaction
            const verificationResult = await verifier.verifyIdentityAttestation({
                proof: payload.proof,
                publicSignals: payload.public_signals,
            })

            if (!verificationResult.valid) {
                log.warn(
                    `❌ ZK attestation verification failed (simulate): ${verificationResult.reason}`,
                )
                return {
                    success: false,
                    message: `ZK proof verification failed: ${verificationResult.reason}`,
                }
            }

            log.info(
                "✅ ZK attestation verified (simulate mode - no points awarded)",
            )
        }

        return {
            success: true,
            message: simulate
                ? "ZK attestation verified (simulation)"
                : "ZK attestation verified and points awarded",
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
            case "udadd":
                result = await this.applyUdIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "udremove":
                result = await this.applyUdIdentityRemove(
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
            case "nomisadd":
                result = await this.applyNomisIdentityUpsert(
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
            case "nomisremove":
                result = await this.applyNomisIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "humanpassportadd":
                result = await this.applyHumanPassportIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "tlsnadd":
                result = await this.applyTLSNIdentityAdd(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "humanpassportremove":
                result = await this.applyHumanPassportIdentityRemove(
                    identityEdit,
                    gcrMainRepository,
                    simulate,
                )
                break
            case "tlsnremove":
                result = await this.applyTLSNIdentityRemove(
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
        type:
            | "twitter"
            | "github"
            | "web3"
            | "telegram"
            | "discord"
            | "ud"
            | "nomis"
            | "humanpassport",
        data: {
            userId?: string // for twitter/github/discord
            chain?: string // for web3
            subchain?: string // for web3
            address?: string // for web3/humanpassport
            domain?: string // for ud
        },
        gcrMainRepository: Repository<GCRMain>,
        currentAccount?: string,
    ): Promise<boolean> {
        if (type === "humanpassport") {
            const result = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(
                    "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'humanpassport', '[]'::jsonb)) AS hp WHERE LOWER(hp->>'address') = LOWER(:address))",
                    { address: data.address },
                )
                .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
                .getOne()

            return !result
        }

        if (type !== "web3" && type !== "ud" && type !== "nomis") {
            // Handle web2 identity types: twitter, github, telegram, discord
            const queryTemplate = `
            EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'web2'->'${type}', '[]'::jsonb)) as ${type}_id WHERE ${type}_id->>'userId' = :userId)
        `

            const result = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(queryTemplate, { userId: data.userId })
                .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
                .getOne()

            /**
             * Return true if no account has this userId
             */
            return !result
        } else if (type === "ud") {
            /**
             * Check if this UD domain exists anywhere
             */
            const result = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(
                    "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'ud', '[]'::jsonb)) AS ud_id WHERE LOWER(ud_id->>'domain') = LOWER(:domain))",
                    { domain: data.domain },
                )
                .andWhere("gcr.pubkey != :currentAccount", { currentAccount })
                .getOne()

            /**
             * Return true if no account has this domain
             */
            return !result
        } else {
            /**
             * For web3 wallets, check if this address exists in any account for this chain/subchain
             */
            const addressToCheck =
                data.chain === "evm" ? data.address.toLowerCase() : data.address

            const rootKey = type === "web3" ? "xm" : "nomis"

            const result = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(
                    `
                EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                        COALESCE(gcr.identities->:rootKey->:chain->:subchain, '[]'::jsonb)
                    ) AS item
                    WHERE item->>'address' = :address
                )
                `,
                    {
                        rootKey,
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
        }
    }

    private static normalizeNomisAddress(
        chain: string,
        address: string,
    ): string {
        if (chain === "evm") {
            return address.trim().toLowerCase()
        }

        return address.trim()
    }

    static async applyNomisIdentityUpsert(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const {
            chain,
            subchain,
            address,
            score,
            scoreType,
            mintedScore,
            metadata,
            lastSyncedAt,
        } = editOperation.data

        if (!chain || !subchain || !address || !score) {
            return { success: false, message: "Invalid Nomis identity payload" }
        }

        const normalizedAddress = this.normalizeNomisAddress(chain, address)

        const isFirst = await this.isFirstConnection(
            "nomis",
            {
                chain: chain,
                subchain: subchain,
                address: normalizedAddress,
            },
            gcrMainRepository,
            editOperation.account,
        )

        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.nomis = accountGCR.identities.nomis || {}
        accountGCR.identities.nomis[chain] =
            accountGCR.identities.nomis[chain] || {}
        accountGCR.identities.nomis[chain][subchain] =
            accountGCR.identities.nomis[chain][subchain] || []

        const chainBucket = accountGCR.identities.nomis[chain][subchain]

        const filtered = chainBucket.filter(existing => {
            const existingAddress = this.normalizeNomisAddress(
                chain,
                existing.address,
            )
            return existingAddress !== normalizedAddress
        })

        const record: SavedNomisIdentity = {
            address: normalizedAddress,
            score,
            scoreType,
            mintedScore: mintedScore ?? null,
            lastSyncedAt: lastSyncedAt || new Date().toISOString(),
            metadata,
        }

        filtered.push(record)
        accountGCR.identities.nomis[chain][subchain] = filtered

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            if (isFirst) {
                await IncentiveManager.nomisLinked(
                    accountGCR.pubkey,
                    chain,
                    score,
                    editOperation.referralCode,
                )
            }
        }

        return { success: true, message: "Nomis identity upserted" }
    }

    static async applyNomisIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const identity = editOperation.data as NomisWalletIdentity

        if (!identity?.chain || !identity?.subchain || !identity?.address) {
            return { success: false, message: "Invalid Nomis identity payload" }
        }

        const normalizedAddress = this.normalizeNomisAddress(
            identity.chain,
            identity.address,
        )

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        const chainBucket =
            accountGCR.identities?.nomis?.[identity.chain]?.[identity.subchain]

        if (!Array.isArray(chainBucket)) {
            return { success: false, message: "Nomis identity not found" }
        }

        const exists = chainBucket.some(existing => {
            const existingAddress = this.normalizeNomisAddress(
                identity.chain,
                existing.address,
            )
            return existingAddress === normalizedAddress
        })

        if (!exists) {
            return { success: false, message: "Nomis identity not found" }
        }

        accountGCR.identities.nomis[identity.chain][identity.subchain] =
            chainBucket.filter(existing => {
                const existingAddress = this.normalizeNomisAddress(
                    identity.chain,
                    existing.address,
                )
                return existingAddress !== normalizedAddress
            })

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            await IncentiveManager.nomisUnlinked(
                accountGCR.pubkey,
                identity.chain,
            )
        }

        return { success: true, message: "Nomis identity removed" }
    }

    // SECTION Human Passport Identity Routines

    private static async applyHumanPassportIdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        try {
            const clientData = editOperation.data as { address: string; verificationMethod: "api" | "onchain" }
            const normalizedAddress = clientData.address.toLowerCase()

            // Fetch verified score from Human Passport API (uses cache from earlier verification)
            const provider = HumanPassportProvider.getInstance()
            const verification = await provider.verifyAddress(normalizedAddress)

            // REVIEW: Guard against score degradation between tx submission and block application
            if (!verification.passingScore) {
                return {
                    success: false,
                    message: `Human Passport score ${verification.score} no longer meets the required threshold (${verification.threshold})`,
                }
            }

            const savedIdentity: SavedHumanPassportIdentity = {
                address: verification.address,
                score: verification.score,
                passingScore: verification.passingScore,
                threshold: verification.threshold,
                stamps: verification.stamps,
                verificationMethod: clientData.verificationMethod,
                verifiedAt: verification.verifiedAt,
                expiresAt: verification.expirationTimestamp
                    ? new Date(verification.expirationTimestamp).getTime()
                    : null,
            }

            const accountGCR = await ensureGCRForUser(editOperation.account)

            // Initialize humanpassport array if needed
            if (!accountGCR.identities.humanpassport) {
                accountGCR.identities.humanpassport = []
            }

            // Global uniqueness check across all accounts
            const isFirst = await this.isFirstConnection(
                "humanpassport",
                { address: normalizedAddress },
                gcrMainRepository,
                editOperation.account,
            )

            // Upsert: remove existing then add new
            accountGCR.identities.humanpassport =
                accountGCR.identities.humanpassport.filter(
                    (hp: SavedHumanPassportIdentity) =>
                        hp.address.toLowerCase() !== normalizedAddress,
                )
            accountGCR.identities.humanpassport.push(savedIdentity)

            if (!simulate) {
                await gcrMainRepository.save(accountGCR)

                if (isFirst) {
                    await IncentiveManager.humanPassportLinked(
                        accountGCR.pubkey,
                        editOperation.referralCode,
                    )
                }
            }

            return { success: true, message: "Human Passport identity added" }
        } catch (error: any) {
            log.error(`[GCRIdentityRoutines] Failed to add Human Passport identity: ${error.message}`)
            return { success: false, message: error.message || "Failed to add Human Passport identity" }
        }
    }

    private static async applyHumanPassportIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const data = editOperation.data as { address: string }
        const normalizedAddress = data.address.toLowerCase()

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        if (!accountGCR.identities.humanpassport || accountGCR.identities.humanpassport.length === 0) {
            return { success: false, message: "No Human Passport identities found" }
        }

        const addressExists = accountGCR.identities.humanpassport.some(
            (hp: SavedHumanPassportIdentity) =>
                hp.address.toLowerCase() === normalizedAddress,
        )

        if (!addressExists) {
            return { success: false, message: "Identity not found" }
        }

        accountGCR.identities.humanpassport =
            accountGCR.identities.humanpassport.filter(
                (hp: SavedHumanPassportIdentity) =>
                    hp.address.toLowerCase() !== normalizedAddress,
            )

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            await IncentiveManager.humanPassportUnlinked(accountGCR.pubkey)
        }

        return { success: true, message: "Human Passport identity removed" }
    }

    // SECTION TLSNotary Identity Routines

    /**
     * Expected API endpoints for TLSN verification per context
     */
    private static TLSN_EXPECTED_ENDPOINTS: Record<
        string,
        { server: string; pathPrefix: string }
    > = {
        github: { server: "api.github.com", pathPrefix: "/user" },
        discord: { server: "discord.com", pathPrefix: "/api/users/@me" },
        telegram: {
            server: "telegram-backend",
            pathPrefix: "/api/telegram/user",
        },
    }

    /**
     * Add an identity via TLSNotary proof verification.
     */
    static async applyTLSNIdentityAdd(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        // Extract context from editOperation.data (top level)
        const { context } = editOperation.data
        // Extract nested data fields (proof, username, userId are inside data.data)
        const {
            proof: proofString,
            recvHash,
            proofRanges,
            revealedRecv,
            username,
            userId,
        } = editOperation.data.data || {}
        // referralCode is at the editOperation level
        const referralCode = editOperation.referralCode

        if (!context) {
            return {
                success: false,
                message: "Missing TLSN context",
            }
        }

        if (!username) {
            return {
                success: false,
                message: "Missing TLSN username",
            }
        }

        if (userId === undefined || userId === null) {
            return {
                success: false,
                message: "Missing TLSN userId",
            }
        }

        if (proofString === undefined || proofString === null) {
            return {
                success: false,
                message: "Missing TLSN proof",
            }
        }

        if (!recvHash) {
            return {
                success: false,
                message: "Missing TLSN recvHash",
            }
        }

        if (!proofRanges) {
            return {
                success: false,
                message: "Missing TLSN proofRanges",
            }
        }

        if (revealedRecv === undefined || revealedRecv === null) {
            return {
                success: false,
                message: "Missing TLSN revealedRecv",
            }
        }

        // Parse the proof JSON string back to object
        let proof: any
        try {
            proof =
                typeof proofString === "string"
                    ? JSON.parse(proofString)
                    : proofString
        } catch (e) {
            return {
                success: false,
                message: "Invalid proof: failed to parse proof JSON string",
            }
        }

        // 1. Validate context is supported
        if (!this.TLSN_EXPECTED_ENDPOINTS[context]) {
            return {
                success: false,
                message: `Unsupported TLSN context: ${context}`,
            }
        }

        // 2. Validate proof structure
        if (!proof || typeof proof !== "object") {
            return {
                success: false,
                message:
                    "Invalid proof: expected TLSNotary presentation object",
            }
        }

        if (!proof.data || !proof.version) {
            return {
                success: false,
                message: "Invalid proof structure: missing data or version",
            }
        }

        // 3. Verify proof and validate recvHash/proofRanges-derived identity claims
        const verification = await verifyTLSNProof({
            context,
            proof: proof as TLSNotaryPresentation,
            recvHash,
            proofRanges: proofRanges as TLSNProofRanges,
            revealedRecv,
            username: String(username),
            userId: String(userId),
            referralCode,
        } as TLSNIdentityPayload)

        if (!verification.success) {
            log.warn(
                `[TLSN Identity] Proof verification failed: ${verification.message}`,
            )
            return {
                success: false,
                message: verification.message,
            }
        }

        // 8. Get/create GCR and check for duplicates
        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        // Check if identity already exists (by userId to prevent duplicate registrations)
        const exists = accountGCR.identities.web2[context].some(
            (id: Web2GCRData["data"]) => id.userId === String(userId),
        )

        if (exists) {
            return { success: false, message: "Identity already exists" }
        }

        // 9. Prepare data for storage
        const proofHash = Hashing.sha256(JSON.stringify(proof))
        const data = {
            userId: String(userId),
            username: username,
            proof: proof,
            proofHash: proofHash,
            proofType: "tlsn", // Mark as TLSNotary-verified
            timestamp: Date.now(),
        }

        accountGCR.identities.web2[context].push(data)

        // 10. Save and award incentives
        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            if (context === "github") {
                const isFirst = await this.isFirstConnection(
                    "github",
                    { userId: String(userId) },
                    gcrMainRepository,
                    editOperation.account,
                )

                if (isFirst) {
                    await IncentiveManager.githubLinked(
                        editOperation.account,
                        String(userId),
                        referralCode,
                    )
                }
            } else if (context === "discord") {
                const isFirst = await this.isFirstConnection(
                    "discord",
                    { userId: String(userId) },
                    gcrMainRepository,
                    editOperation.account,
                )

                if (isFirst) {
                    await IncentiveManager.discordLinked(
                        editOperation.account,
                        referralCode,
                    )
                }
            } else if (context === "telegram") {
                const isFirst = await this.isFirstConnection(
                    "telegram",
                    { userId: String(userId) },
                    gcrMainRepository,
                    editOperation.account,
                )

                if (isFirst) {
                    await IncentiveManager.telegramTLSNLinked(
                        editOperation.account,
                        String(userId),
                        referralCode,
                    )
                }
            }
        }

        return { success: true, message: "TLSN identity added successfully" }
    }

    /**
     * Remove an identity that was added via TLSNotary.
     *
     * Removes only TLSN-proven identities (proofType === "tlsn") from web2 storage.
     */
    static async applyTLSNIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, username } = editOperation.data as {
            context?: string
            username?: string
        }

        if (!context || !username) {
            return {
                success: false,
                message: "Invalid payload: missing context or username",
            }
        }

        if (!this.TLSN_EXPECTED_ENDPOINTS[context]) {
            return {
                success: false,
                message: `Unsupported TLSN context: ${context}`,
            }
        }

        const accountGCR = await gcrMainRepository.findOneBy({
            pubkey: editOperation.account,
        })

        if (!accountGCR) {
            return { success: false, message: "Account not found" }
        }

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        const isMatch = (id: Web2GCRData["data"] & { proofType?: string }) => {
            // TLSN remove must never affect legacy/non-TLSN web2 identities.
            if (id.proofType !== "tlsn") {
                return false
            }
            return id.username === username
        }

        // Find the TLSN identity to remove
        const identity = accountGCR.identities.web2[context].find(
            (id: Web2GCRData["data"]) => isMatch(id as Web2GCRData["data"] & { proofType?: string }),
        )

        if (!identity) {
            return { success: false, message: "TLSN identity not found" }
        }

        // Filter out only the matching TLSN identity
        accountGCR.identities.web2[context] = accountGCR.identities.web2[
            context
        ].filter(
            (id: Web2GCRData["data"]) =>
                !isMatch(id as Web2GCRData["data"] & { proofType?: string }),
        )

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            // Trigger TLSN incentive rollback only for confirmed TLSN provenance.
            if (context === "github" && identity.userId) {
                await IncentiveManager.githubUnlinked(
                    editOperation.account,
                    identity.userId,
                )
            } else if (context === "discord") {
                await IncentiveManager.discordUnlinked(editOperation.account)
            } else if (context === "telegram") {
                await IncentiveManager.telegramUnlinked(editOperation.account)
            }
        }

        return { success: true, message: "TLSN identity removed successfully" }
    }
}
