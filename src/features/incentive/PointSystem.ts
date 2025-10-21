import log from "@/utilities/logger"
import { Referrals } from "./referrals"
import Datasource from "../../model/datasource"
import HandleGCR from "@/libs/blockchain/gcr/handleGCR"
import { RPCResponse, Web2GCRData } from "@kynesyslabs/demosdk/types"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import ensureGCRForUser from "@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
import { Twitter } from "@/libs/identity/tools/twitter"

// Local UserPoints interface matching GCR entity structure
interface UserPoints {
    userId: string
    referralCode: string
    totalPoints: number
    breakdown: {
        web3Wallets: { [chain: string]: number }
        socialAccounts: {
            twitter: number
            github: number
            discord: number
            telegram: number
        }
        udDomains: { [domain: string]: number }
        referrals: number
        demosFollow: number
    }
    linkedWallets: string[]
    linkedSocials: { twitter?: string }
    lastUpdated: Date
    flagged: boolean | null
    flaggedReason: string | null
}

const pointValues = {
    LINK_WEB3_WALLET: 0.5,
    LINK_TWITTER: 2,
    LINK_GITHUB: 1,
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
        linkedSocials: { twitter?: string; discord?: string }
    }> {
        const xmIdentities = await IdentityManager.getIdentities(userId)
        const twitterIdentities = await IdentityManager.getWeb2Identities(
            userId,
            "twitter",
        )
        const discordIdentities = await IdentityManager.getWeb2Identities(
            userId,
            "discord",
        )

        const linkedWallets: string[] = []

        if (xmIdentities?.xm) {
            const chains = Object.keys(xmIdentities.xm)

            for (const chain of chains) {
                const subChains = xmIdentities.xm[chain]
                const subChainKeys = Object.keys(subChains)

                for (const subChain of subChainKeys) {
                    const identities = subChains[subChain]

                    if (Array.isArray(identities)) {
                        identities.forEach(identity => {
                            const walletId = `${chain}:${identity.address}`
                            linkedWallets.push(walletId)
                        })
                    }
                }
            }
        }

        const linkedSocials: { twitter?: string; discord?: string } = {}

        if (Array.isArray(twitterIdentities) && twitterIdentities.length > 0) {
            linkedSocials.twitter = twitterIdentities[0].username
        }

        if (Array.isArray(discordIdentities) && discordIdentities.length > 0) {
            linkedSocials.discord = discordIdentities[0].username
        }

        return { linkedWallets, linkedSocials }
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

        const { linkedWallets, linkedSocials } =
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
                socialAccounts: account.points.breakdown?.socialAccounts || {
                    twitter: 0,
                    github: 0,
                    discord: 0,
                    telegram: 0,
                },
                udDomains: account.points.breakdown?.udDomains || {},
                referrals: account.points.breakdown?.referrals || 0,
                demosFollow: account.points.breakdown?.demosFollow || 0,
            },
            linkedWallets,
            linkedSocials,
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
        type: "web3Wallets" | "socialAccounts" | "udDomains",
        platform: string,
        referralCode?: string,
        twitterUserId?: string,
    ): Promise<void> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
        const account = await ensureGCRForUser(userId)

        // const account = await gcrMainRepository.findOneBy({ pubkey: userId })
        // if (!account) {
        //     const newAccount = await HandleGCR.createAccount(userId)
        //     newAccount.points.totalPoints = points

        //     if (
        //         type === "socialAccounts" &&
        //         (platform === "twitter" ||
        //             platform === "github" ||
        //             platform === "discord")
        //     ) {
        //         newAccount.points.breakdown = {
        //             web3Wallets: {},
        //             socialAccounts: {
        //                 twitter: platform === "twitter" ? points : 0,
        //                 github: platform === "github" ? points : 0,
        //                 discord: platform === "discord" ? points : 0,
        //             },
        //             referrals: 0,
        //         }
        //     } else {
        //         newAccount.points.breakdown = {
        //             web3Wallets: {},
        //             socialAccounts: {
        //                 twitter: 0,
        //                 github: 0,
        //                 discord: 0,
        //             },
        //             referrals: 0,
        //         }
        //     }
        //     newAccount.points.lastUpdated = new Date()

        //     // Process referral for new account
        //     if (referralCode) {
        //         await Referrals.processReferral(
        //             newAccount,
        //             referralCode,
        //             gcrMainRepository,
        //         )
        //     }

        //     await gcrMainRepository.save(newAccount)
        // } else {
        const isEligibleForReferral = Referrals.isEligibleForReferral(account)

        const oldTotal = account.points.totalPoints || 0
        account.points.totalPoints = oldTotal + points

        if (
            type === "socialAccounts" &&
            (platform === "twitter" ||
                platform === "github" ||
                platform === "discord")
        ) {
            const oldPlatformPoints =
                account.points.breakdown?.socialAccounts?.[platform] || 0
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
            account.points.breakdown.udDomains =
                account.points.breakdown.udDomains || {}
            const oldDomainPoints =
                account.points.breakdown.udDomains[platform] || 0
            account.points.breakdown.udDomains[platform] =
                oldDomainPoints + points
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
            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

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
            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

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

            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

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
            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

            // Check if user has Twitter points to deduct
            if (
                userPointsWithIdentities.breakdown.socialAccounts.twitter <= 0
            ) {
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
                        pointsDeducted: 0,
                        totalPoints: account.points.totalPoints || 0,
                        message:
                            "Error: GitHub account not linked to this user",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

            // Check if user has GitHub points to deduct
            if (userPointsWithIdentities.breakdown.socialAccounts.github <= 0) {
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

            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

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
            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

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
        referralCode?: string,
    ): Promise<RPCResponse> {
        try {
            // Determine point value based on TLD
            const isDemosDomain = domain.toLowerCase().endsWith(".demos")
            const pointValue = isDemosDomain
                ? pointValues.LINK_UD_DOMAIN_DEMOS
                : pointValues.LINK_UD_DOMAIN

            // Get current points and check for duplicate domain linking
            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

            // Check if this specific domain is already linked
            const account = await ensureGCRForUser(userId)
            const udDomains = account.points.breakdown?.udDomains || {}
            const domainAlreadyLinked = domain in udDomains

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

            // Award points by updating the GCR
            await this.addPointsToGCR(
                userId,
                pointValue,
                "udDomains",
                domain,
                referralCode,
            )

            // Get updated points
            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValue,
                    totalPoints: updatedPoints.totalPoints,
                    message: `Points awarded for linking ${isDemosDomain ? ".demos" : "UD"} domain`,
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
            // Determine point value based on TLD
            const isDemosDomain = domain.toLowerCase().endsWith(".demos")
            const pointValue = isDemosDomain
                ? pointValues.LINK_UD_DOMAIN_DEMOS
                : pointValues.LINK_UD_DOMAIN

            // Check if user has points for this domain to deduct
            const account = await ensureGCRForUser(userId)
            const udDomains = account.points.breakdown?.udDomains || {}
            const hasDomainPoints = domain in udDomains && udDomains[domain] > 0

            if (!hasDomainPoints) {
                const userPointsWithIdentities = await this.getUserPointsInternal(
                    userId,
                )
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
            await this.addPointsToGCR(userId, -pointValue, "udDomains", domain)

            // Get updated points
            const updatedPoints = await this.getUserPointsInternal(userId)

            return {
                result: 200,
                response: {
                    pointsDeducted: pointValue,
                    totalPoints: updatedPoints.totalPoints,
                    message: `Points deducted for unlinking ${isDemosDomain ? ".demos" : "UD"} domain`,
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
}
