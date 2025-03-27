import Datasource from "../../model/datasource"
import { RPCResponse } from "@kynesyslabs/demosdk/types"

// Define point values for different actions
const pointValues = {
    CREATE_IDENTITY: 100,
    LINK_WEB3_WALLET: 50, // per wallet
    LINK_TWITTER: 75,
    LINK_GITHUB: 75,
    LINK_DISCORD: 75, // TODO: Implement Discord integration
}

// Define reputation levels
const reputationLevels = [
    { name: "Newcomer", minPoints: 0 },
    { name: "Explorer", minPoints: 100 },
    { name: "Contributor", minPoints: 250 },
    { name: "Builder", minPoints: 500 },
    { name: "Pioneer", minPoints: 1000 },
]

export interface UserPoints {
    userId: string
    totalPoints: number
    breakdown: {
        identityCreation: number
        web3Wallets: number
        socialAccounts: number
    }
    linkedWallets: string[]
    linkedSocials: {
        twitter?: string
        github?: string
        discord?: string
    }
    reputationLevel: string
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
     * Award points for creating a Demos identity
     */
    async awardIdentityCreationPoints(userId: string): Promise<RPCResponse> {
        try {
            // Get or create user points record
            const userPoints = await this.getUserPoints(userId)

            // Only award points if not already awarded
            if (userPoints.breakdown.identityCreation === 0) {
                userPoints.breakdown.identityCreation =
                    pointValues.CREATE_IDENTITY
                userPoints.totalPoints += pointValues.CREATE_IDENTITY

                await this.saveUserPoints(userPoints)

                return {
                    result: 200,
                    response: {
                        pointsAwarded: pointValues.CREATE_IDENTITY,
                        totalPoints: userPoints.totalPoints,
                        message: "Points awarded for identity creation",
                    },
                    require_reply: false,
                    extra: {},
                }
            }

            return {
                result: 200,
                response: {
                    pointsAwarded: 0,
                    totalPoints: userPoints.totalPoints,
                    message: "Points already awarded for identity creation",
                },
                require_reply: false,
                extra: {},
            }
        } catch (error) {
            console.error("Error awarding identity points:", error)
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
     * Get user's current points and reputation
     */
    async getUserPoints(userId: string): Promise<UserPoints> {
        // TODO: Implement database storage for points
        // For now, we'll create a new record if none exists

        // In a real implementation, this would fetch from the database
        const defaultPoints: UserPoints = {
            userId,
            totalPoints: 0,
            breakdown: {
                identityCreation: 0,
                web3Wallets: 0,
                socialAccounts: 0,
            },
            linkedWallets: [],
            linkedSocials: {},
            reputationLevel: reputationLevels[0].name,
            lastUpdated: new Date(),
        }

        // Calculate reputation level
        const reputationLevel = this.calculateReputationLevel(
            defaultPoints.totalPoints,
        )
        defaultPoints.reputationLevel = reputationLevel

        return defaultPoints
    }

    /**
     * Calculate reputation level based on points
     */
    private calculateReputationLevel(points: number): string {
        let level = reputationLevels[0].name

        for (const repLevel of reputationLevels) {
            if (points >= repLevel.minPoints) {
                level = repLevel.name
            } else {
                break
            }
        }

        return level
    }

    /**
     * Save user points to database
     */
    private async saveUserPoints(userPoints: UserPoints): Promise<void> {
        // TODO: Implement database storage
        // For now, we'll just update the reputation level and timestamp
        userPoints.reputationLevel = this.calculateReputationLevel(
            userPoints.totalPoints,
        )
        userPoints.lastUpdated = new Date()

        console.log(
            `[PointSystem] Updated points for user ${userPoints.userId}: ${userPoints.totalPoints} points`,
        )
    }

    /**
     * Check if a user has bot-like behavior
     * This is a placeholder for more sophisticated bot detection
     */
    async checkForBotBehavior(userId: string): Promise<boolean> {
        // TODO: Implement actual bot detection
        // For now, we'll just return false (not a bot)

        // In a real implementation, this would check:
        // 1. Account age
        // 2. Activity patterns
        // 3. Social account verification status
        // 4. Reputation on linked platforms

        return false
    }
}
