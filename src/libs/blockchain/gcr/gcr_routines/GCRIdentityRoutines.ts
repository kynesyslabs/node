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
    PqcIdentityEdit,
    SavedXmIdentity,
    SavedUdIdentity,
} from "@/model/entities/types/IdentityTypes"
import log from "@/utilities/logger"
import { IncentiveManager } from "./IncentiveManager"

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
            default:
                result = {
                    success: false,
                    message: "Unsupported identity operation",
                }
        }

        return result
    }

    private static async isFirstConnection(
        type: "twitter" | "github" | "web3" | "telegram" | "discord" | "ud",
        data: {
            userId?: string // for twitter/github/discord
            chain?: string // for web3
            subchain?: string // for web3
            address?: string // for web3
            domain?: string // for ud
        },
        gcrMainRepository: Repository<GCRMain>,
        currentAccount?: string,
    ): Promise<boolean> {
        if (type !== "web3" && type !== "ud") {
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
        }
    }
}
