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
     * Award points for linking a Web3 wallet
     */
    async awardWeb3WalletPoints(
        userId: string,
        walletAddress: string,
        chain: string,
    ): Promise<RPCResponse> {
        try {
            // Get user points record
            const userPoints = await this.getUserPoints(userId)

            // Check if this wallet is already linked
            if (
                userPoints.linkedWallets.includes(`${chain}:${walletAddress}`)
            ) {
                return {
                    result: 200,
                    response: {
                        pointsAwarded: 0,
                        totalPoints: userPoints.totalPoints,
                        message: "Wallet already linked, no new points awarded",
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
            // Get user points record
            const userPoints = await this.getUserPoints(userId)

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
     * Get user's current points
     */
    async getUserPoints(userId: string): Promise<UserPoints> {
        try {
            // Get database connection
            const datasource = await Datasource.getInstance()
            const connection = datasource.getDataSource()
            const userPointsRepo = connection.getRepository(UserPointsEntity)

            // Try to find existing user points
            const userPointsEntity = await userPointsRepo.findOne({
                where: { userId },
            })

            if (userPointsEntity) {
                // Convert entity to UserPoints interface
                const userPoints: UserPoints = {
                    userId: userPointsEntity.userId,
                    totalPoints: userPointsEntity.totalPoints,
                    breakdown: {
                        web3Wallets:
                            userPointsEntity.breakdown.web3Wallets || 0,
                        socialAccounts:
                            userPointsEntity.breakdown.socialAccounts || 0,
                    },
                    linkedWallets: userPointsEntity.linkedWallets,
                    linkedSocials: {
                        twitter: userPointsEntity.linkedSocials.twitter,
                    },
                    lastUpdated: userPointsEntity.updatedAt,
                }
                return userPoints
            }

            // If no record exists, create a default one
            const defaultPoints: UserPoints = {
                userId,
                totalPoints: 0,
                breakdown: {
                    web3Wallets: 0,
                    socialAccounts: 0,
                },
                linkedWallets: [],
                linkedSocials: {},
                lastUpdated: new Date(),
            }

            return defaultPoints
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : String(error)
            console.error(
                `[PointSystem] Error getting user points: ${errorMessage}`,
                error,
            )

            // Return default points in case of error
            return {
                userId,
                totalPoints: 0,
                breakdown: {
                    web3Wallets: 0,
                    socialAccounts: 0,
                },
                linkedWallets: [],
                linkedSocials: {},
                lastUpdated: new Date(),
            }
        }
    }

    /**
     * Save user points to database
     */
    private async saveUserPoints(userPoints: UserPoints): Promise<void> {
        try {
            // Update the last updated timestamp
            userPoints.lastUpdated = new Date()

            // Get database connection
            const datasource = await Datasource.getInstance()
            const connection = datasource.getDataSource()
            const userPointsRepo = connection.getRepository(UserPointsEntity)

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

            // Save to database
            await userPointsRepo.save(userPointsEntity)

            console.log(
                `[PointSystem] Saved points for user ${userPoints.userId}: ${userPoints.totalPoints} points`,
            )
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
}
