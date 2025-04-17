import Datasource from "../../model/datasource"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { UserPointsEntity } from "../../model/entities/UserPoints"

// Define point values for different actions
const pointValues = {
    LINK_WEB3_WALLET: 2, // per wallet
    LINK_TWITTER: 5,
}

export interface UserPoints {
    userId: string
    totalPoints: number
    breakdown: {
        web3Wallets: number
        socialAccounts: number
    }
    linkedWallets: string[]
    linkedSocials: {
        twitter?: string
    }
    lastUpdated: Date
}

// Define a type for successful responses containing UserPoints
type UserPointsResponse = {
    result: 200
    response: UserPoints
    require_reply: boolean
    extra: Record<string, unknown>
}

// Define a type for error responses
type ErrorResponse = {
    result: 400 | 500
    response: string
    require_reply: boolean
    extra: {
        error: string
    }
}

// Combine the response types
type PointSystemResponse = UserPointsResponse | ErrorResponse

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
     * Get user's current points
     */
    private async getUserPointsInternal(userId: string): Promise<UserPoints> {
        const db = await Datasource.getInstance()
        const userPointsRepository = db
            .getDataSource()
            .getRepository(UserPointsEntity)

        // Get or create user points record
        let userPointsEntity = await userPointsRepository.findOneBy({ userId })
        if (!userPointsEntity) {
            userPointsEntity = new UserPointsEntity()
            userPointsEntity.userId = userId
            userPointsEntity.totalPoints = 0
            userPointsEntity.breakdown = {
                web3Wallets: 0,
                socialAccounts: 0,
            }
            userPointsEntity.linkedWallets = []
            userPointsEntity.linkedSocials = {}
            await userPointsRepository.save(userPointsEntity)
        }

        // Convert entity to UserPoints interface
        return {
            userId: userPointsEntity.userId,
            totalPoints: userPointsEntity.totalPoints,
            breakdown: {
                web3Wallets: userPointsEntity.breakdown?.web3Wallets || 0,
                socialAccounts: userPointsEntity.breakdown?.socialAccounts || 0,
            },
            linkedWallets: userPointsEntity.linkedWallets || [],
            linkedSocials: {
                twitter: userPointsEntity.linkedSocials?.twitter,
            },
            lastUpdated: userPointsEntity.updatedAt,
        }
    }

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
            console.error("Error getting user points:", error)
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
     */
    async awardWeb3WalletPoints(
        userId: string,
        walletAddress: string,
        chain: string,
    ): Promise<RPCResponse> {
        try {
            const userPoints = await this.getUserPointsInternal(userId)

            // Check if any wallet of this chain type is already linked
            const hasExistingChainWallet = userPoints.linkedWallets.some(
                wallet => wallet.startsWith(`${chain}:`),
            )

            if (hasExistingChainWallet) {
                return {
                    result: 400,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPoints.totalPoints,
                        message: `A ${chain} wallet is already linked. Please disconnect it first.`,
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            // Check if this exact wallet is already linked
            if (
                userPoints.linkedWallets.includes(`${chain}:${walletAddress}`)
            ) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPoints.totalPoints,
                        message: "This wallet is already linked",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            // Award points for the new wallet
            userPoints.linkedWallets.push(`${chain}:${walletAddress}`)
            userPoints.breakdown.web3Wallets += pointValues.LINK_WEB3_WALLET
            userPoints.totalPoints += pointValues.LINK_WEB3_WALLET

            await this.saveUserPoints(userPoints)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValues.LINK_WEB3_WALLET,
                    totalPoints: userPoints.totalPoints,
                    message: "Points awarded for linking Web3 wallet",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            console.error("Error awarding wallet points:", error)
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
     */
    async awardTwitterPoints(
        userId: string,
        twitterHandle: string,
    ): Promise<RPCResponse> {
        try {
            const userPoints = await this.getUserPointsInternal(userId)

            // Check if Twitter is already linked
            if (userPoints.linkedSocials.twitter) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPoints.totalPoints,
                        message:
                            "Twitter already linked, no new points awarded",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            // Award points for linking Twitter
            userPoints.linkedSocials.twitter = twitterHandle
            userPoints.breakdown.socialAccounts += pointValues.LINK_TWITTER
            userPoints.totalPoints += pointValues.LINK_TWITTER

            await this.saveUserPoints(userPoints)

            return {
                result: 200,
                response: {
                    pointsAwarded: pointValues.LINK_TWITTER,
                    totalPoints: userPoints.totalPoints,
                    message: "Points awarded for linking Twitter",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            console.error("Error awarding Twitter points:", error)
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
     * Save user points to database
     */
    private async saveUserPoints(userPoints: UserPoints): Promise<void> {
        try {
            // Get database connection
            const datasource = await Datasource.getInstance()
            const connection = datasource.getDataSource()

            // Use a transaction for database operations
            await connection.transaction(async transactionalEntityManager => {
                const userPointsRepo =
                    transactionalEntityManager.getRepository(UserPointsEntity)

                // Check if user already has a record
                let userPointsEntity = await userPointsRepo.findOne({
                    where: { userId: userPoints.userId },
                })

                if (!userPointsEntity) {
                    // Create new entity if it doesn't exist
                    userPointsEntity = new UserPointsEntity()
                    userPointsEntity.userId = userPoints.userId
                }

                // Update entity with new values
                userPointsEntity.totalPoints = userPoints.totalPoints
                userPointsEntity.breakdown = {
                    web3Wallets: userPoints.breakdown.web3Wallets,
                    socialAccounts: userPoints.breakdown.socialAccounts,
                }
                userPointsEntity.linkedWallets = userPoints.linkedWallets
                userPointsEntity.linkedSocials = {
                    twitter: userPoints.linkedSocials.twitter,
                }

                // Save to database within transaction
                await userPointsRepo.save(userPointsEntity)
            })
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : String(error)
            console.error(
                `[PointSystem] Error saving user points: ${errorMessage}`,
                error,
            )
            throw error
        }
    }

    async addPoints(
        userId: string,
        points: number,
        type: "web3Wallets" | "socialAccounts",
    ): Promise<PointSystemResponse> {
        try {
            const db = await Datasource.getInstance()
            const userPointsRepository = db
                .getDataSource()
                .getRepository(UserPointsEntity)

            // Get or create user points record
            let userPointsEntity = await userPointsRepository.findOneBy({
                userId,
            })
            if (!userPointsEntity) {
                userPointsEntity = new UserPointsEntity()
                userPointsEntity.userId = userId
                userPointsEntity.totalPoints = 0
                userPointsEntity.breakdown = {
                    web3Wallets: 0,
                    socialAccounts: 0,
                }
                userPointsEntity.linkedWallets = []
                userPointsEntity.linkedSocials = {}
            }

            // Update points
            userPointsEntity.totalPoints += points
            if (!userPointsEntity.breakdown) {
                userPointsEntity.breakdown = {
                    web3Wallets: 0,
                    socialAccounts: 0,
                }
            }
            userPointsEntity.breakdown[type] += points

            await userPointsRepository.save(userPointsEntity)

            // Convert to UserPoints for response
            const userPoints: UserPoints = {
                userId: userPointsEntity.userId,
                totalPoints: userPointsEntity.totalPoints,
                breakdown: {
                    web3Wallets: userPointsEntity.breakdown?.web3Wallets || 0,
                    socialAccounts:
                        userPointsEntity.breakdown?.socialAccounts || 0,
                },
                linkedWallets: userPointsEntity.linkedWallets || [],
                linkedSocials: {
                    twitter: userPointsEntity.linkedSocials?.twitter,
                },
                lastUpdated: userPointsEntity.updatedAt,
            }

            return {
                result: 200,
                response: userPoints,
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            console.error("Error adding points:", error)
            return {
                result: 500,
                response: "Error adding points",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    async linkWallet(
        userId: string,
        walletAddress: string,
    ): Promise<PointSystemResponse> {
        try {
            const db = await Datasource.getInstance()
            const userPointsRepository = db
                .getDataSource()
                .getRepository(UserPointsEntity)

            // Get or create user points record
            let userPointsEntity = await userPointsRepository.findOneBy({
                userId,
            })
            if (!userPointsEntity) {
                userPointsEntity = new UserPointsEntity()
                userPointsEntity.userId = userId
                userPointsEntity.totalPoints = 0
                userPointsEntity.breakdown = {
                    web3Wallets: 0,
                    socialAccounts: 0,
                }
                userPointsEntity.linkedWallets = []
                userPointsEntity.linkedSocials = {}
            }

            // Add wallet if not already linked
            if (!userPointsEntity.linkedWallets.includes(walletAddress)) {
                userPointsEntity.linkedWallets.push(walletAddress)
                await userPointsRepository.save(userPointsEntity)
            }

            // Convert to UserPoints for response
            const userPoints: UserPoints = {
                userId: userPointsEntity.userId,
                totalPoints: userPointsEntity.totalPoints,
                breakdown: {
                    web3Wallets: userPointsEntity.breakdown?.web3Wallets || 0,
                    socialAccounts:
                        userPointsEntity.breakdown?.socialAccounts || 0,
                },
                linkedWallets: userPointsEntity.linkedWallets || [],
                linkedSocials: {
                    twitter: userPointsEntity.linkedSocials?.twitter,
                },
                lastUpdated: userPointsEntity.updatedAt,
            }

            return {
                result: 200,
                response: userPoints,
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            console.error("Error linking wallet:", error)
            return {
                result: 500,
                response: "Error linking wallet",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }

    async linkSocialAccount(
        userId: string,
        platform: "twitter",
        accountId: string,
    ): Promise<PointSystemResponse> {
        try {
            const db = await Datasource.getInstance()
            const userPointsRepository = db
                .getDataSource()
                .getRepository(UserPointsEntity)

            // Get or create user points record
            let userPointsEntity = await userPointsRepository.findOneBy({
                userId,
            })
            if (!userPointsEntity) {
                userPointsEntity = new UserPointsEntity()
                userPointsEntity.userId = userId
                userPointsEntity.totalPoints = 0
                userPointsEntity.breakdown = {
                    web3Wallets: 0,
                    socialAccounts: 0,
                }
                userPointsEntity.linkedWallets = []
                userPointsEntity.linkedSocials = {}
            }

            // Update social account
            if (!userPointsEntity.linkedSocials) {
                userPointsEntity.linkedSocials = {}
            }
            userPointsEntity.linkedSocials[platform] = accountId

            await userPointsRepository.save(userPointsEntity)

            // Convert to UserPoints for response
            const userPoints: UserPoints = {
                userId: userPointsEntity.userId,
                totalPoints: userPointsEntity.totalPoints,
                breakdown: {
                    web3Wallets: userPointsEntity.breakdown?.web3Wallets || 0,
                    socialAccounts:
                        userPointsEntity.breakdown?.socialAccounts || 0,
                },
                linkedWallets: userPointsEntity.linkedWallets || [],
                linkedSocials: {
                    twitter: userPointsEntity.linkedSocials?.twitter,
                },
                lastUpdated: userPointsEntity.updatedAt,
            }

            return {
                result: 200,
                response: userPoints,
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            console.error("Error linking social account:", error)
            return {
                result: 500,
                response: "Error linking social account",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
    }
}
