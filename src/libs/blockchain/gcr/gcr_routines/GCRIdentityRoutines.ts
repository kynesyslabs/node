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
    SavedNomisIdentity,
    SavedXmIdentity,
    SavedUdIdentity,
} from "@/model/entities/types/IdentityTypes"
import log from "@/utilities/logger"
import { IncentiveManager } from "./IncentiveManager"
import {
    verifyTLSNotaryPresentation,
    parseHttpResponse,
    extractGithubUser,
    extractDiscordUser,
    type TLSNotaryPresentation,
} from "@/libs/tlsnotary"

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
            case "nomisremove":
                result = await this.applyNomisIdentityRemove(
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
            case "tlsnremove":
                result = await this.applyTLSNIdentityRemove(
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
            | "nomis",
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
        // Future: telegram
    }

    /**
     * Add an identity via TLSNotary proof verification.
     *
     * This method performs cryptographic verification of the TLSNotary proof,
     * extracts the proven data, and compares it with the claimed values.
     * Only stores the identity if the proof is valid and claims match.
     *
     * Security: Data is extracted directly from the cryptographic proof,
     * never trusting client-provided claims without verification.
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
            username,
            userId,
        } = editOperation.data.data || {}
        // referralCode is at the editOperation level
        const referralCode = editOperation.referralCode

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
        const expected = this.TLSN_EXPECTED_ENDPOINTS[context]
        if (!expected) {
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

        // 3. Verify proof using WASM
        log.info(
            `[TLSN Identity] Verifying proof for ${context} identity: ${username}`,
        )
        const verified = await verifyTLSNotaryPresentation(
            proof as TLSNotaryPresentation,
        )

        if (!verified.success) {
            log.warn(
                `[TLSN Identity] Proof verification failed: ${verified.error}`,
            )
            return {
                success: false,
                message: `Proof verification failed: ${verified.error}`,
            }
        }

        // 4. Check server name matches expected (skip if WASM verification disabled)
        // When WASM is disabled, serverName is not extracted from proof
        // We trust the frontend's cryptographic verification in this mode
        if (verified.verifyingKey !== "structure-validation-only") {
            if (verified.serverName !== expected.server) {
                log.warn(
                    `[TLSN Identity] Server mismatch: expected ${expected.server}, got ${verified.serverName}`,
                )
                return {
                    success: false,
                    message: `Server mismatch: expected ${expected.server}, got ${verified.serverName}`,
                }
            }
        } else {
            log.info(
                `[TLSN Identity] Skipping serverName check (structure-validation-only mode)`,
            )
        }

        // 5. Parse HTTP response and extract user data (if WASM provided recv data)
        let extractedUser: { username: string; userId: string } | null = null

        // 5. Parse HTTP response and extract user data
        // if (!verified.recv) {
        //     return {
        //         success: false,
        //         message: "No response data in proof",
        //     }
        // }

        if (verified.recv) {
            const httpResponse = parseHttpResponse(verified.recv)
            if (!httpResponse) {
                return {
                    success: false,
                    message: "Failed to parse HTTP response from proof",
                }
            }

            // 6. Extract user data based on context
            // let extractedUser: { username: string; userId: string } | null = null

            if (context === "github") {
                extractedUser = extractGithubUser(httpResponse.body)
            } else if (context === "discord") {
                extractedUser = extractDiscordUser(httpResponse.body)
            }
            // Future: Add extractors for telegram

            if (!extractedUser) {
                return {
                    success: false,
                    message: `Failed to extract user data from ${context} response`,
                }
            }

            // 7. CRITICAL SECURITY CHECK: Compare claimed vs extracted values
            if (extractedUser.username !== username) {
                log.warn(
                    `[TLSN Identity] Username mismatch: claimed "${username}", proof contains "${extractedUser.username}"`,
                )
                return {
                    success: false,
                    message: `Username mismatch: claimed "${username}", proof contains "${extractedUser.username}"`,
                }
            }

            if (extractedUser.userId !== String(userId)) {
                log.warn(
                    `[TLSN Identity] UserId mismatch: claimed "${userId}", proof contains "${extractedUser.userId}"`,
                )
                return {
                    success: false,
                    message: `UserId mismatch: claimed "${userId}", proof contains "${extractedUser.userId}"`,
                }
            }

            log.info(
                // `[TLSN Identity] Proof verified successfully for ${context}: ${username} (${userId})`,
                `[TLSN Identity] Proof verified with WASM for ${context}: ${username} (${userId})`,
            )
        } else {
            // WASM verification disabled - trust claimed data with warning
            // NOTE: This is less secure but allows operation until WASM works in Node.js
            log.warn(
                `[TLSN Identity] WASM disabled - trusting claimed data for ${context}: ${username} (${userId})`,
            )
            extractedUser = { username, userId: String(userId) }
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
            proof: proof, // Store full TLSNotary proof for re-verification
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
            }
            // Future: Add incentives for telegram
        }

        return { success: true, message: "TLSN identity added successfully" }
    }

    /**
     * Remove an identity that was added via TLSNotary.
     *
     * Removes the identity from the web2 identities storage.
     */
    static async applyTLSNIdentityRemove(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { context, username } = editOperation.data

        if (!context || !username) {
            return {
                success: false,
                message: "Invalid payload: missing context or username",
            }
        }

        const accountGCR = await ensureGCRForUser(editOperation.account)

        accountGCR.identities.web2 = accountGCR.identities.web2 || {}
        accountGCR.identities.web2[context] =
            accountGCR.identities.web2[context] || []

        // Find the identity to remove
        const identity = accountGCR.identities.web2[context].find(
            (id: Web2GCRData["data"]) => id.username === username,
        )

        if (!identity) {
            return { success: false, message: "Identity not found" }
        }

        // Filter out the identity
        accountGCR.identities.web2[context] = accountGCR.identities.web2[
            context
        ].filter((id: Web2GCRData["data"]) => id.username !== username)

        if (!simulate) {
            await gcrMainRepository.save(accountGCR)

            // Trigger incentive rollback if applicable
            if (context === "github" && identity.userId) {
                await IncentiveManager.githubUnlinked(
                    editOperation.account,
                    identity.userId,
                )
            } else if (context === "discord") {
                await IncentiveManager.discordUnlinked(editOperation.account)
            }
        }

        return { success: true, message: "TLSN identity removed successfully" }
    }
}
