import Datasource from "../../model/datasource"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { UserPoints } from "@kynesyslabs/demosdk/abstraction"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import HandleGCR from "@/libs/blockchain/gcr/handleGCR"

const pointValues = {
    LINK_WEB3_WALLET: 2,
    LINK_TWITTER: 5,
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
        linkedSocials: { twitter?: string }
    }> {
        const xmIdentities = await IdentityManager.getIdentities(userId)
        const web2Identities = await IdentityManager.getWeb2Identities(
            userId,
            "github",
        )

        const linkedWallets: string[] = []

        if (xmIdentities) {
            const chains = Object.keys(xmIdentities)

            for (const chain of chains) {
                const subChains = xmIdentities[chain]
                const subChainKeys = Object.keys(subChains)

                for (const subChain of subChainKeys) {
                    const addresses = subChains[subChain]

                    if (Array.isArray(addresses)) {
                        addresses.forEach(address => {
                            const walletId = `${chain}:${address}`
                            linkedWallets.push(walletId)
                        })
                    }
                }
            }
        }

        const linkedSocials: { twitter?: string } = {}

        if (
            web2Identities &&
            typeof web2Identities === "object" &&
            "twitter" in web2Identities &&
            Array.isArray(web2Identities.twitter) &&
            web2Identities.twitter.length > 0
        ) {
            const twitterProof = web2Identities.twitter[0]
            linkedSocials.twitter =
                typeof twitterProof === "string"
                    ? twitterProof
                    : twitterProof.username || ""
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
            account.points.totalPoints = 0
            account.points.breakdown = {
                web3Wallets: 0,
                socialAccounts: 0,
            }
            account.points.lastUpdated = new Date()

            await gcrMainRepository.save(account)
        }

        // Create and return the response object
        return {
            userId: userIdStr,
            totalPoints: account.points.totalPoints || 0,
            breakdown: {
                web3Wallets: account.points.breakdown?.web3Wallets || 0,
                socialAccounts: account.points.breakdown?.socialAccounts || 0,
            },
            linkedWallets,
            linkedSocials,
            lastUpdated: account.points.lastUpdated || new Date(),
        }
    }

    /**
     * Add points to the GCR for a user
     */
    private async addPointsToGCR(
        userId: string,
        points: number,
        type: "web3Wallets" | "socialAccounts",
    ): Promise<void> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
        const account = await gcrMainRepository.findOneBy({ pubkey: userId })

        if (!account) {
            const newAccount = await HandleGCR.createAccount(userId)
            newAccount.points.totalPoints = points
            newAccount.points.breakdown[type] = points
            newAccount.points.lastUpdated = new Date()

            await gcrMainRepository.save(newAccount)
        } else {
            const oldTotal = account.points.totalPoints || 0
            account.points.totalPoints = oldTotal + points

            const oldCategoryPoints = account.points.breakdown[type] || 0
            account.points.breakdown[type] = oldCategoryPoints + points
            account.points.lastUpdated = new Date()

            await gcrMainRepository.save(account)
        }
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
                response: {
                    userId: userPoints.userId,
                    totalPoints: userPoints.totalPoints,
                    breakdown: userPoints.breakdown,
                    linkedWallets: userPoints.linkedWallets,
                    linkedSocials: userPoints.linkedSocials,
                    lastUpdated: userPoints.lastUpdated,
                },
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
     * @returns RPCResponse
     */
    async awardWeb3WalletPoints(
        userId: string,
        walletAddress: string,
        chain: string,
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
     * @param twitterHandle The user's Twitter handle
     * @returns RPCResponse
     */
    async awardTwitterPoints(
        userId: string,
        twitterHandle: string,
    ): Promise<RPCResponse> {
        try {
            const userPointsWithIdentities = await this.getUserPointsInternal(
                userId,
            )

            if (userPointsWithIdentities.linkedSocials.twitter) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPointsWithIdentities.totalPoints,
                        message: "Twitter is already linked",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            await this.addPointsToGCR(
                userId,
                pointValues.LINK_TWITTER,
                "socialAccounts",
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
}
