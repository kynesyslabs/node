import log from "@/utilities/logger"
import { Referrals } from "./referrals"
import Datasource from "../../model/datasource"
import HandleGCR from "@/libs/blockchain/gcr/handleGCR"
import { RPCResponse, Web2GCRData } from "@kynesyslabs/demosdk/types"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import ensureGCRForUser from "@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
import { Twitter } from "@/libs/identity/tools/twitter"
import { UDIdentityManager } from "@/libs/blockchain/gcr/gcr_routines/udIdentityManager"
import { SavedUdIdentity } from "@/model/entities/types/IdentityTypes"
import { UserPoints } from "@kynesyslabs/demosdk/abstraction"
import { NomisWalletIdentity } from "@/model/entities/types/IdentityTypes"

const pointValues = {
    LINK_WEB3_WALLET: 0.5,
    LINK_TWITTER: 2,
    LINK_GITHUB: 1,
    LINK_TELEGRAM: 1,
    FOLLOW_DEMOS: 1,
    LINK_DISCORD: 1,
    LINK_UD_DOMAIN_DEMOS: 3,
    LINK_UD_DOMAIN: 1,
}

export class PointSystem {
    private static instance: PointSystem

    private constructor() {}

    public static getInstance(): PointSystem {
        if (!PointSystem.instance) {
            PointSystem.instance = new PointSystem()
        }
        return PointSystem.instance
    }

    /**
     * Get user's identities directly from the GCR
     */
    private async getUserIdentitiesFromGCR(userId: string): Promise<{
        linkedWallets: string[]
        linkedSocials: { twitter?: string; github?: string; discord?: string }
        linkedUDDomains: {
            [network: string]: string[]
        }
        linkedNomis: NomisWalletIdentity[]
    }> {
        const identities = await IdentityManager.getIdentities(userId)
        const twitterIdentities = await IdentityManager.getWeb2Identities(
            userId,
            "twitter",
        )

        const githubIdentities = await IdentityManager.getWeb2Identities(
            userId,
            "github",
        )

        const discordIdentities = await IdentityManager.getWeb2Identities(
            userId,
            "discord",
        )

        const udIdentities = await IdentityManager.getUDIdentities(userId)

        const linkedWallets: string[] = []
        const linkedUDDomains: {
            [network: string]: string[]
        } = {}

        if (identities?.xm) {
            const chains = Object.keys(identities.xm)

            for (const chain of chains) {
                const subChains = identities.xm[chain]
                const subChainKeys = Object.keys(subChains)

                for (const subChain of subChainKeys) {
                    const xmIdentities = subChains[subChain]

                    if (Array.isArray(xmIdentities)) {
                        xmIdentities.forEach(xmIdentity => {
                            const walletId = `${chain}:${xmIdentity.address}`
                            linkedWallets.push(walletId)
                        })
                    }
                }
            }
        }

        const linkedNomis: NomisWalletIdentity[] = []

        if (identities?.nomis) {
            const nomisChains = Object.keys(identities.nomis)

            for (const chain of nomisChains) {
                const subChains = identities.nomis[chain]
                const subChainKeys = Object.keys(subChains)

                for (const subChain of subChainKeys) {
                    const nomisIdentities = subChains[subChain]

                    if (Array.isArray(nomisIdentities)) {
                        const mapped = nomisIdentities.map(nomisIdentity => ({
                            chain,
                            subchain: subChain,
                            ...nomisIdentity,
                        }))

                        linkedNomis.push(...mapped)
                    }
                }
            }
        }

        const linkedSocials: {
            twitter?: string
            github?: string
            discord?: string
        } = {}

        if (Array.isArray(twitterIdentities) && twitterIdentities.length > 0) {
            linkedSocials.twitter = twitterIdentities[0].username
        }

        if (Array.isArray(githubIdentities) && githubIdentities.length > 0) {
            linkedSocials.github = githubIdentities[0].username
        }

        if (Array.isArray(discordIdentities) && discordIdentities.length > 0) {
            linkedSocials.discord = discordIdentities[0].username
        }

        if (Array.isArray(udIdentities) && udIdentities.length > 0) {
            for (const udIdentity of udIdentities as SavedUdIdentity[]) {
                const { network, domain } = udIdentity

                if (!linkedUDDomains[network]) {
                    linkedUDDomains[network] = []
                }

                if (!linkedUDDomains[network]!.includes(domain)) {
                    linkedUDDomains[network]!.push(domain)
                }
            }
        }

        return { linkedWallets, linkedSocials, linkedUDDomains, linkedNomis }
    }

    /**
     * Get user's points from GCR
     */
    private async getUserPointsInternal(userId: string): Promise<UserPoints> {
        // Convert userId to hex string if it's a Buffer
        const userIdStr = Buffer.isBuffer(userId)
            ? userId.toString("hex")
            : userId

        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
        let account = await gcrMainRepository.findOneBy({ pubkey: userIdStr })

        const { linkedWallets, linkedSocials, linkedUDDomains, linkedNomis } =
            await this.getUserIdentitiesFromGCR(userIdStr)

        if (!account) {
            account = await HandleGCR.createAccount(userIdStr)
        }

        // INFO: This is a fallback for accounts that were created before the referral code was added
        if (!account.referralInfo || !account.referralInfo.referralCode) {
            account.referralInfo = {
                totalReferrals: 0,
                referralCode: Referrals.generateReferralCode(userIdStr),
                referrals: [],
                referredBy: null,
            }
            await gcrMainRepository.save(account)
        }

        // Create and return the response object
        return {
            userId: userIdStr,
            referralCode: account.referralInfo?.referralCode || "",
            totalPoints: account.points.totalPoints || 0,
            breakdown: {
                web3Wallets: account.points.breakdown?.web3Wallets || {},
                socialAccounts: {
                    twitter:
                        account.points.breakdown?.socialAccounts?.twitter ?? 0,
                    github:
                        account.points.breakdown?.socialAccounts?.github ?? 0,
                    telegram:
                        account.points.breakdown?.socialAccounts?.telegram ?? 0,
                    discord:
                        account.points.breakdown?.socialAccounts?.discord ?? 0,
                },
                udDomains: account.points.breakdown?.udDomains || {},
                nomisScores: account.points.breakdown?.nomisScores || {},
                referrals: account.points.breakdown?.referrals || 0,
                demosFollow: account.points.breakdown?.demosFollow || 0,
            },
            linkedWallets,
            linkedSocials,
            linkedUDDomains,
            linkedNomisIdentities: linkedNomis,
            lastUpdated: account.points.lastUpdated || new Date(),
            flagged: account.flagged || null,
            flaggedReason: account.flaggedReason || null,
        }
    }

    /**
     * Add points to the GCR for a user
     */
    private async addPointsToGCR(
        userId: string,
        points: number,
        type: "web3Wallets" | "socialAccounts" | "udDomains" | "nomisScores",
        platform: string,
        referralCode?: string,
        twitterUserId?: string,
    ): Promise<void> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
        const account = await ensureGCRForUser(userId)
        const isEligibleForReferral = Referrals.isEligibleForReferral(account)

        // REVIEW: Ensure breakdown structure is properly initialized before assignment
        account.points.breakdown = account.points.breakdown || {
            web3Wallets: {},
            socialAccounts: { twitter: 0, github: 0, telegram: 0, discord: 0 },
            referrals: 0,
            demosFollow: 0,
            nomisScores: {},
        }

        const oldTotal = account.points.totalPoints || 0
        account.points.totalPoints = oldTotal + points

        if (
            type === "socialAccounts" &&
            (platform === "twitter" ||
                platform === "github" ||
                platform === "telegram" ||
                platform === "discord")
        ) {
            const oldPlatformPoints =
                account.points.breakdown.socialAccounts[platform] || 0
            account.points.breakdown.socialAccounts[platform] =
                oldPlatformPoints + points
        } else if (type === "web3Wallets") {
            account.points.breakdown.web3Wallets =
                account.points.breakdown.web3Wallets || {}
            const oldChainPoints =
                account.points.breakdown.web3Wallets[platform] || 0
            account.points.breakdown.web3Wallets[platform] =
                oldChainPoints + points
        } else if (type === "udDomains") {
            // Explicitly initialize udDomains if undefined
            if (!account.points.breakdown.udDomains) {
                account.points.breakdown.udDomains = {}
            }
            const oldDomainPoints =
                account.points.breakdown.udDomains[platform] || 0
            account.points.breakdown.udDomains[platform] =
                oldDomainPoints + points
        } else if (type === "nomisScores") {
            account.points.breakdown.nomisScores =
                account.points.breakdown.nomisScores || {}
            const oldChainPoints =
                account.points.breakdown.nomisScores[platform] || 0
            account.points.breakdown.nomisScores[platform] =
                oldChainPoints + points
        }
        account.points.lastUpdated = new Date()

        // Process referral for existing account if eligible
        if (referralCode && isEligibleForReferral) {
            await Referrals.processReferral(
                account,
                referralCode,
                gcrMainRepository,
            )
        }

        const twitter = Twitter.getInstance()
        const twitterUser = (account.identities.web2["twitter"] || []).find(
            (twitterIdentity: Web2GCRData["data"]) =>
                twitterIdentity.userId === twitterUserId,
        )

        if (twitterUser && twitterUser.username) {
            const isFollowingDemos = await twitter.checkFollow(
                twitterUser.username,
            )

            if (isFollowingDemos) {
                account.points.breakdown.demosFollow = pointValues.FOLLOW_DEMOS
                account.points.totalPoints += pointValues.FOLLOW_DEMOS
            }
        }

        await gcrMainRepository.save(account)
    }

    /**
     * Get user's current points
     * @param userId The user's Demos address
     * @returns User points with identity information from GCR
     */
    async getUserPoints(userId: string): Promise<RPCResponse> {
        try {
            const userPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: userPoints,
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error getting user points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Award points for linking a Web3 wallet
     * @param userId The user's Demos address
     * @param walletAddress The wallet address
     * @param chain The chain type
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async awardWeb3WalletPoints(
        userId: string,
        walletAddress: string,
        chain: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        let walletIsAlreadyLinked = false
        let hasExistingWalletOnChain = false

        const walletIsAlreadyLinkedMessage = "This wallet is already linked"
        const hasExistingWalletOnChainMessage = `A ${chain} wallet is already linked. Please disconnect it first.`

        try {
            // Get current points and identities from GCR
            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            if (!userPointsWithIdentities.linkedSocials.twitter) {
                return {
                    result: 400,
                    response: "Twitter account not linked. Not awarding points",
                    require_reply: false,
                    extra: null,
                }
            }

            if (
                userPointsWithIdentities.linkedWallets.includes(
                    `${chain}:${walletAddress}`,
                )
            ) {
                walletIsAlreadyLinked = true
            }

            // Check if any wallet of this chain type is already linked
            const hasExistingChainWallet =
                userPointsWithIdentities.linkedWallets.some(wallet =>
                    wallet.startsWith(`${chain}:`),
                )

            if (hasExistingChainWallet) {
                hasExistingWalletOnChain = true
            }

            // Award points by updating the GCR
            await this.addPointsToGCR(
                userId,
                pointValues.LINK_WEB3_WALLET,
                "web3Wallets",
                chain,
                referralCode,
            )

            // Get updated points
            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result:
                    walletIsAlreadyLinked || hasExistingWalletOnChain
                        ? 400
                        : 200,
                response: {
                    pointsAwarded:
                        !walletIsAlreadyLinked && !hasExistingWalletOnChain
                            ? pointValues.LINK_WEB3_WALLET
                            : 0,
                    totalPoints: updatedPoints.totalPoints,
                    message: walletIsAlreadyLinked
                        ? walletIsAlreadyLinkedMessage
                        : hasExistingWalletOnChain
                          ? hasExistingWalletOnChainMessage
                          : "Points awarded for linking wallet",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error awarding points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Award points for linking a Twitter account
     * @param userId The user's Demos address
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async awardTwitterPoints(
        userId: string,
        twitterUserId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        try {
            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user already has Twitter points specifically
            if (userPointsWithIdentities.breakdown.socialAccounts.twitter > 0) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "Twitter points already awarded",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                pointValues.LINK_TWITTER,
                "socialAccounts",
                "twitter",
                referralCode,
                twitterUserId,
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValues.LINK_TWITTER,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points awarded for linking Twitter",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error awarding points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Award points for linking a GitHub account
     * @param userId The user's Demos address
     * @param githubUserId The GitHub user ID
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async awardGithubPoints(
        userId: string,
        githubUserId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        try {
            // Get user's account data from GCR to verify GitHub ownership
            const account = await ensureGCRForUser(userId)

            // Verify the GitHub account is actually linked to this user
            const githubIdentities = account.identities.web2?.github || []
            const isOwner = githubIdentities.some(
                (gh: any) => gh.userId === githubUserId,
            )

            if (!isOwner) {
                return {
                    result: 400,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: account.points.totalPoints || 0,
                        message:
                            "Error: GitHub account not linked to this user",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user already has GitHub points specifically
            if (userPointsWithIdentities.breakdown.socialAccounts.github > 0) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "GitHub points already awarded",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                pointValues.LINK_GITHUB,
                "socialAccounts",
                "github",
                referralCode,
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValues.LINK_GITHUB,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points awarded for linking GitHub",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error awarding points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Deduct points for unlinking a Web3 wallet
     * @param userId The user's Demos address
     * @param walletAddress The wallet address
     * @param chain The chain type
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async deductWeb3WalletPoints(
        userId: string,
        walletAddress: string,
        chain: string,
    ): Promise<RPCResponse> {
        try {
            // Deduct points by updating the GCR
            await this.addPointsToGCR(
                userId,
                -pointValues.LINK_WEB3_WALLET,
                "web3Wallets",
                chain,
            )

            // Get updated points
            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointValues.LINK_WEB3_WALLET,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points deducted for unlinking wallet",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error deducting points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Deduct points for unlinking a Twitter account
     * @param userId The user's Demos address
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async deductTwitterPoints(userId: string): Promise<RPCResponse> {
        try {
            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user has Twitter points to deduct
            const currentTwitter =
                userPointsWithIdentities.breakdown.socialAccounts?.twitter ?? 0
            if (currentTwitter <= 0) {
                return {
                    result: 200,
                    response: {
                        pointsDeducted: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "No Twitter points to deduct",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                -pointValues.LINK_TWITTER,
                "socialAccounts",
                "twitter",
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointValues.LINK_TWITTER,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points deducted for unlinking Twitter",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error deducting points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Deduct points for unlinking a GitHub account
     * @param userId The user's Demos address
     * @param githubUserId The GitHub user ID to verify ownership
     * @returns RPCResponse
     */
    async deductGithubPoints(
        userId: string,
        githubUserId: string,
    ): Promise<RPCResponse> {
        try {
            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user has GitHub points to deduct
            const currentGithub =
                userPointsWithIdentities.breakdown.socialAccounts?.github ?? 0
            if (currentGithub <= 0) {
                return {
                    result: 200,
                    response: {
                        pointsDeducted: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "No GitHub points to deduct",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                -pointValues.LINK_GITHUB,
                "socialAccounts",
                "github",
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointValues.LINK_GITHUB,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points deducted for unlinking GitHub",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error deducting points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Award points for linking a Telegram account
     * @param userId The user's Demos address
     * @param telegramUserId The Telegram user ID
     * @param referralCode Optional referral code
     * @param attestation Optional TelegramSignedAttestation with group_membership field
     * @returns RPCResponse
     */
    async awardTelegramPoints(
        userId: string,
        telegramUserId: string,
        referralCode?: string,
        attestation?: any, // TelegramSignedAttestation from SDK
    ): Promise<RPCResponse> {
        try {
            // Get user's account data from GCR to verify Telegram ownership
            const account = await ensureGCRForUser(userId)

            // Verify the Telegram account is actually linked to this user
            const telegramIdentities = account.identities.web2?.telegram || []
            const isOwner = telegramIdentities.some(
                (tg: any) => tg.userId === telegramUserId,
            )

            if (!isOwner) {
                return {
                    result: 400,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: account.points.totalPoints || 0,
                        message:
                            "Error: Telegram account not linked to this user",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user already has Telegram points specifically
            if (
                userPointsWithIdentities.breakdown.socialAccounts.telegram > 0
            ) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "Telegram points already awarded",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            // REVIEW: Check group membership from attestation (SDK v2.4.18+)
            // Award points ONLY if user is member of required Telegram group
            const isGroupMember =
                attestation?.payload?.group_membership === true

            if (!isGroupMember) {
                log.info(
                    `Telegram linked but user not in required group: ${telegramUserId}`,
                )
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message:
                            "Telegram linked successfully, but you must join the required group to earn points",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                pointValues.LINK_TELEGRAM,
                "socialAccounts",
                "telegram",
                referralCode,
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValues.LINK_TELEGRAM,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points awarded for linking Telegram",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error awarding points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Deduct points for unlinking a Telegram account
     * @param userId The user's Demos address
     * @param telegramUserId The Telegram user ID to verify ownership
     * @returns RPCResponse
     */
    async deductTelegramPoints(userId: string): Promise<RPCResponse> {
        try {
            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user has Telegram points to deduct
            const currentTelegram =
                userPointsWithIdentities.breakdown.socialAccounts?.telegram ?? 0
            if (currentTelegram <= 0) {
                return {
                    result: 200,
                    response: {
                        pointsDeducted: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "No Telegram points to deduct",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                -pointValues.LINK_TELEGRAM,
                "socialAccounts",
                "telegram",
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointValues.LINK_TELEGRAM,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points deducted for unlinking Telegram",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error deducting points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Award points for linking a Discord account
     * @param userId The user's Demos address
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async awardDiscordPoints(
        userId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        try {
            // Verify the Discord account is actually linked to this user
            const account = await ensureGCRForUser(userId)
            const discordIdentities = account.identities.web2?.discord || []

            const hasDiscord =
                Array.isArray(discordIdentities) && discordIdentities.length > 0
            if (!hasDiscord) {
                return {
                    result: 400,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: account.points.totalPoints || 0,
                        message:
                            "Error: Discord account not linked to this user",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user already has Discord points specifically
            if (userPointsWithIdentities.breakdown.socialAccounts.discord > 0) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "Discord points already awarded",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                pointValues.LINK_DISCORD,
                "socialAccounts",
                "discord",
                referralCode,
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValues.LINK_DISCORD,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points awarded for linking Discord",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error awarding points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Deduct points for unlinking a Discord account
     * @param userId The user's Demos address
     * @returns RPCResponse
     */
    async deductDiscordPoints(userId: string): Promise<RPCResponse> {
        try {
            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if user has Discord points to deduct
            if (
                userPointsWithIdentities.breakdown.socialAccounts.discord <= 0
            ) {
                return {
                    result: 200,
                    response: {
                        pointsDeducted: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "No Discord points to deduct",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                -pointValues.LINK_DISCORD,
                "socialAccounts",
                "discord",
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointValues.LINK_DISCORD,
                    totalPoints: updatedPoints.totalPoints,
                    message: "Points deducted for unlinking Discord",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error deducting points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Award points for linking an Unstoppable Domain
     * @param userId The user's Demos address
     * @param domain The UD domain (e.g., "john.crypto", "alice.demos")
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async awardUdDomainPoints(
        userId: string,
        domain: string,
        signingAddress: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        try {
            // Normalize domain to lowercase for case-insensitive comparison
            // SECURITY: Prevents point farming by linking same domain with different cases
            const normalizedDomain = domain.toLowerCase()

            // Determine point value based on TLD
            const isDemosDomain = normalizedDomain.endsWith(".demos")
            const pointValue = isDemosDomain
                ? pointValues.LINK_UD_DOMAIN_DEMOS
                : pointValues.LINK_UD_DOMAIN

            // Get current points and check for duplicate domain linking
            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            // Check if this specific domain is already linked
            const account = await ensureGCRForUser(userId)
            const udDomains = account.points.breakdown?.udDomains || {}
            const domainAlreadyLinked = normalizedDomain in udDomains

            if (domainAlreadyLinked) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "UD domain points already awarded",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            // SECURITY: Verify domain exists in GCR identities to prevent race conditions
            // This prevents concurrent transactions from awarding points before domain is removed
            const domainInIdentities = account.identities.ud?.some(
                (id: SavedUdIdentity) =>
                    id.domain.toLowerCase() === normalizedDomain,
            )
            if (!domainInIdentities) {
                return {
                    result: 400,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: `Cannot award points: domain ${normalizedDomain} not found in GCR identities`,
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            const isOwner = await UDIdentityManager.checkOwnerLinkedWallets(
                userId,
                normalizedDomain,
                signingAddress,
                null,
                account.identities.xm,
            )

            if (!isOwner) {
                return {
                    result: 400,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: `Cannot award points: domain ${normalizedDomain} is not owned by any of your linked wallets`,
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            // Award points by updating the GCR
            await this.addPointsToGCR(
                userId,
                pointValue,
                "udDomains",
                normalizedDomain,
                referralCode,
            )

            // Get updated points
            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValue,
                    totalPoints: updatedPoints.totalPoints,
                    message: `Points awarded for linking ${
                        isDemosDomain ? ".demos" : "UD"
                    } domain`,
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error awarding UD domain points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Deduct points for unlinking an Unstoppable Domain
     * @param userId The user's Demos address
     * @param domain The UD domain (e.g., "john.crypto", "alice.demos")
     * @returns RPCResponse
     */
    async deductUdDomainPoints(
        userId: string,
        domain: string,
    ): Promise<RPCResponse> {
        try {
            // Normalize domain to lowercase for case-insensitive comparison
            // SECURITY: Ensures consistent lookup regardless of input case
            const normalizedDomain = domain.toLowerCase()

            // Determine point value based on TLD
            const isDemosDomain = normalizedDomain.endsWith(".demos")
            const pointValue = isDemosDomain
                ? pointValues.LINK_UD_DOMAIN_DEMOS
                : pointValues.LINK_UD_DOMAIN

            // PERFORMANCE OPTIMIZATION: Skip ownership verification on unlinking
            // Domain removal from GCR identities already requires ownership proof
            // via signature verification in GCRIdentityRoutines, making this redundant.
            // This saves ~200-500ms per unlink operation (blockchain resolution time).

            // Check if user has points for this domain to deduct
            const account = await ensureGCRForUser(userId)
            const udDomains = account.points.breakdown?.udDomains || {}
            const hasDomainPoints =
                normalizedDomain in udDomains && udDomains[normalizedDomain] > 0

            if (!hasDomainPoints) {
                const userPointsWithIdentities =
                    await this.getUserPointsInternal(userId)
                return {
                    result: 200,
                    response: {
                        pointsDeducted: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "No UD domain points to deduct",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            // Deduct points by updating the GCR
            await this.addPointsToGCR(
                userId,
                -pointValue,
                "udDomains",
                normalizedDomain,
            )

            // Get updated points
            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointValue,
                    totalPoints: updatedPoints.totalPoints,
                    message: `Points deducted for unlinking ${
                        isDemosDomain ? ".demos" : "UD"
                    } domain`,
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error deducting UD domain points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Award points for linking a Nomis score
     * @param userId The user's Demos address
     * @param chain The Nomis score chain type: "evm" | "solana"
     * @param referralCode Optional referral code
     * @returns RPCResponse
     */
    async awardNomisScorePoints(
        userId: string,
        chain: string,
        nomisScore: number,
        referralCode?: string,
    ): Promise<RPCResponse> {
        const invalidChainMessage =
            "Invalid Nomis chain. Allowed values are 'evm' and 'solana'."
        const nomisScoreAlreadyLinkedMessage = `A Nomis score for ${chain} is already linked.`
        const validChains = ["evm", "solana"]

        try {
            if (!validChains.includes(chain)) {
                return {
                    result: 400,
                    response: invalidChainMessage,
                    require_reply: false,
                    extra: null,
                }
            }

            const userPointsWithIdentities =
                await this.getUserPointsInternal(userId)

            if (!userPointsWithIdentities.linkedSocials.twitter) {
                return {
                    result: 400,
                    response: "Twitter account not linked. Not awarding points",
                    require_reply: false,
                    extra: null,
                }
            }

            if (chain === "evm") {
                const hasEvmWallet =
                    userPointsWithIdentities.linkedWallets.some(w =>
                        w.startsWith("evm:"),
                    )

                if (!hasEvmWallet) {
                    return {
                        result: 400,
                        response:
                            "EVM wallet not linked. Cannot award crosschain Nomis points",
                        require_reply: false,
                        extra: null,
                    }
                }
            }

            if (chain === "solana") {
                const hasSolWallet =
                    userPointsWithIdentities.linkedWallets.some(w =>
                        w.startsWith("solana:"),
                    )

                if (!hasSolWallet) {
                    return {
                        result: 400,
                        response:
                            "Solana wallet not linked. Cannot award Solana Nomis points",
                        require_reply: false,
                        extra: null,
                    }
                }
            }

            const existingNomisScoreOnChain =
                userPointsWithIdentities.breakdown.nomisScores?.[chain]

            if (existingNomisScoreOnChain != null) {
                const updatedPoints = await this.getUserPointsInternal(userId)

                return {
                    result: 400,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: updatedPoints.totalPoints,
                        message: nomisScoreAlreadyLinkedMessage,
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            const pointsToAward = this.getNomisPointsByScore(nomisScore)

            await this.addPointsToGCR(
                userId,
                pointsToAward,
                "nomisScores",
                chain,
                referralCode,
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointsToAward,
                    totalPoints: updatedPoints.totalPoints,
                    message: `Points awarded for linking Nomis score on ${chain}`,
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error awarding Nomis score points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    /**
     * Deduct points for unlinking a Nomis score
     * @param userId The user's Demos address
     * @param chain The Nomis score chain type: "evm" | "solana"
     * @param nomisScore The Nomis score used to compute points
     * @returns RPCResponse
     */
    async deductNomisScorePoints(
        userId: string,
        chain: string,
        nomisScore: number,
    ): Promise<RPCResponse> {
        const validChains = ["evm", "solana"]
        const invalidChainMessage =
            "Invalid Nomis chain. Allowed values are 'evm' and 'solana'."

        try {
            if (!validChains.includes(chain)) {
                return {
                    result: 400,
                    response: invalidChainMessage,
                    require_reply: false,
                    extra: null,
                }
            }

            const account = await ensureGCRForUser(userId)
            const currentNomisForChain =
                account.points.breakdown?.nomisScores?.[chain] ?? 0

            if (currentNomisForChain <= 0) {
                const userPointsWithIdentities =
                    await this.getUserPointsInternal(userId)
                return {
                    result: 200,
                    response: {
                        pointsDeducted: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: `No Nomis points to deduct for ${chain}`,
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            const pointsToDeduct = this.getNomisPointsByScore(nomisScore)

            await this.addPointsToGCR(
                userId,
                -pointsToDeduct,
                "nomisScores",
                chain,
            )

            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointsToDeduct,
                    totalPoints: updatedPoints.totalPoints,
                    message: `Points deducted for unlinking Nomis score on ${chain}`,
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            return {
                result: 500,
                response: "Error deducting Nomis score points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    private getNomisPointsByScore(score: number): number {
        const formattedScore = Number((score * 100).toFixed(0))
        if (formattedScore >= 80) return 5
        if (formattedScore >= 60) return 4
        if (formattedScore >= 40) return 3
        if (formattedScore >= 20) return 2
        return 1
    }
}
