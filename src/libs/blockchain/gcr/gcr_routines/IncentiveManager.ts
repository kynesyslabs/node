import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { PointSystem } from "@/features/incentive/PointSystem"

/**
 * This class is used to manage the incentives for the user.
 * It is used to award points to the user for linking their wallet, Twitter account, and Telegram account.
 * It is also used to get the points for the user.
 */
export class IncentiveManager {
    private static pointSystem = PointSystem.getInstance()
    /**
     * Hook to be called after Web3 wallet linking
     */
    static async walletLinked(
        userId: string,
        walletAddress: string,
        chain: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardWeb3WalletPoints(
            userId,
            walletAddress,
            chain,
            referralCode,
        )
    }

    /**
     * Hook to be called after Twitter linking
     */
    static async twitterLinked(
        userId: string,
        twitterUserId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardTwitterPoints(
            userId,
            twitterUserId,
            referralCode,
        )
    }

    /**
     * Hook to be called after Web3 wallet unlinking
     */
    static async walletUnlinked(
        userId: string,
        walletAddress: string,
        chain: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.deductWeb3WalletPoints(
            userId,
            walletAddress,
            chain,
        )
    }

    /**
     * Hook to be called after Twitter unlinking
     */
    static async twitterUnlinked(userId: string): Promise<RPCResponse> {
        return await this.pointSystem.deductTwitterPoints(userId)
    }

    /**
     * Hook to be called after Telegram linking
     */
    static async telegramLinked(
        userId: string,
        telegramUserId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardTelegramPoints(
            userId,
            telegramUserId,
            referralCode,
        )
    }

    /**
     * Hook to be called after Telegram unlinking
     */
    static async telegramUnlinked(userId: string): Promise<RPCResponse> {
        return await this.pointSystem.deductTelegramPoints(userId)
    }

    /**
     * Hook to get the points for a user
     */
    static async getPoints(address: string): Promise<RPCResponse> {
        return await this.pointSystem.getUserPoints(address)
    }
}
