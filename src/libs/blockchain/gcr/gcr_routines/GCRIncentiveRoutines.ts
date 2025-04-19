import { GCRResult } from "../handleGCR"
import { GCREdit, GCREditIncentive } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { IncentiveController } from "@/features/incentive/IncentiveController"
import log from "@/utilities/logger"

export default class GCRIncentiveRoutines {
    /**
     * Process wallet linking incentive
     */
    static async applyWalletLinkedIncentive(
        editOperation: GCREditIncentive,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { walletAddress, chain } = editOperation.data

        if (!walletAddress || !chain) {
            return {
                success: false,
                message: "Invalid wallet linked incentive data",
            }
        }

        // Only actually award points if not simulating
        if (!simulate) {
            try {
                const incentiveController = IncentiveController.getInstance()
                await incentiveController.onWalletLinked(
                    editOperation.account,
                    walletAddress,
                    chain,
                )
                log.info(
                    `Awarded wallet linking points to ${editOperation.account} for ${chain}:${walletAddress}`,
                )
                return {
                    success: true,
                    message: "Wallet linking points awarded",
                }
            } catch (error: any) {
                log.error(`Failed to award wallet linking points: ${error}`)
                return {
                    success: false,
                    message: `Failed to award wallet linking points: ${
                        error.message || String(error)
                    }`,
                }
            }
        }

        // When simulating, just return success
        return {
            success: true,
            message: "Wallet linking points would be awarded (simulation)",
        }
    }

    /**
     * Process social media linking incentive
     */
    static async applySocialLinkedIncentive(
        editOperation: GCREditIncentive,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { username, platform } = editOperation.data

        if (!username || !platform) {
            return {
                success: false,
                message: "Invalid social linked incentive data",
            }
        }

        // Only actually award points if not simulating
        if (!simulate) {
            try {
                const incentiveController = IncentiveController.getInstance()

                // Currently only Twitter is supported
                if (platform.toLowerCase() === "twitter") {
                    const response = await incentiveController.onTwitterLinked(
                        editOperation.account,
                        username,
                    )
                    log.info(
                        `Awarded Twitter linking points to ${editOperation.account} for ${username}`,
                    )
                    return {
                        success: response.result === 200 ? true : false,
                        message: response.response.message,
                    }
                } else {
                    // For future expansion to other platforms
                    return {
                        success: false,
                        message: `Unsupported social platform: ${platform}`,
                    }
                }
            } catch (error: any) {
                log.error(`Failed to award social linking points: ${error}`)
                return {
                    success: false,
                    message: `Failed to award social linking points: ${
                        error.message || String(error)
                    }`,
                }
            }
        }

        // When simulating, just return success
        return {
            success: true,
            message: "Social linking points would be awarded (simulation)",
        }
    }

    /**
     * Process get points request
     */
    static async applyGetPointsIncentive(
        editOperation: GCREditIncentive,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { account } = editOperation

        if (!account) {
            return {
                success: false,
                message: "Invalid account for get points request",
            }
        }

        // Only actually get points if not simulating
        if (!simulate) {
            try {
                const incentiveController = IncentiveController.getInstance()
                const response = await incentiveController.onGetPoints(account)
                log.info(
                    `Retrieved points for ${account}: ${JSON.stringify(
                        response,
                    )}`,
                )
                return {
                    success: true,
                    message: "Points retrieved successfully",
                    response: response,
                }
            } catch (error: any) {
                log.error(`Failed to get points: ${error}`)
                return {
                    success: false,
                    message: `Failed to get points: ${
                        error.message || String(error)
                    }`,
                }
            }
        }

        // When simulating, return a mock response
        return {
            success: true,
            message: "Points would be retrieved (simulation)",
            response: {
                /* Empty points object for simulation */ userId: account,
                totalPoints: 0,
                breakdown: { web3Wallets: 0, socialAccounts: 0 },
                linkedWallets: [],
                linkedSocials: {},
                lastUpdated: new Date(),
            },
        }
    }

    /**
     * Main apply method - handles all incentive operations
     */
    static async apply(
        editOperation: GCREdit,
        simulate: boolean,
    ): Promise<GCRResult> {
        if (editOperation.type !== "incentive") {
            return {
                success: false,
                message: "Invalid edit operation for incentive routine",
            }
        }

        const incentiveEdit = editOperation as GCREditIncentive

        // Convert account to hex if needed
        incentiveEdit.account =
            typeof incentiveEdit.account === "string"
                ? incentiveEdit.account
                : forgeToHex(incentiveEdit.account)

        // Handle rollbacks for incentives
        if (incentiveEdit.isRollback) {
            // For most incentives, there's no need to rollback points
            // Points are not typically removed once awarded
            return {
                success: true,
                message:
                    "Incentive rollbacks are not required - points remain awarded",
            }
        }

        // Process based on incentive type
        switch (incentiveEdit.incentiveType) {
            case "wallet_linked":
                return await this.applyWalletLinkedIncentive(
                    incentiveEdit,
                    simulate,
                )

            case "social_linked":
                return await this.applySocialLinkedIncentive(
                    incentiveEdit,
                    simulate,
                )

            case "get_points":
                return await this.applyGetPointsIncentive(
                    incentiveEdit,
                    simulate,
                )

            default:
                return {
                    success: false,
                    message: `Unsupported incentive type: ${incentiveEdit.incentiveType}`,
                }
        }
    }
}
