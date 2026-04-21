import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { PointSystem } from "@/features/incentive/PointSystem"

/**
 * This class is used to manage the incentives for the user.
 * It is used to award points to the user for linking their wallet, X account, GitHub account, Discord, and UD domains.
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
     * Hook to be called after X linking
     */
    static async xLinked(
        userId: string,
        xUserId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardXPoints(
            userId,
            xUserId,
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
     * Hook to be called after X unlinking
     */
    static async xUnlinked(userId: string): Promise<RPCResponse> {
        return await this.pointSystem.deductXPoints(userId)
    }

    /**
     * Hook to be called after GitHub linking
     */
    static async githubLinked(
        userId: string,
        githubUserId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardGithubPoints(
            userId,
            githubUserId,
            referralCode,
        )
    }

    /**
     * Hook to be called after GitHub unlinking
     */
    static async githubUnlinked(
        userId: string,
        githubUserId: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.deductGithubPoints(userId, githubUserId)
    }

    /**
     * Hook to be called after Telegram linking
     */
    static async telegramLinked(
        userId: string,
        telegramUserId: string,
        referralCode?: string,
        attestation?: any, // TelegramSignedAttestation from SDK
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardTelegramPoints(
            userId,
            telegramUserId,
            referralCode,
            attestation,
        )
    }

    /**
     * Hook to be called after TLSN Telegram linking
     */
    static async telegramTLSNLinked(
        userId: string,
        telegramUserId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardTelegramTLSNPoints(
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

    /**
     * Hook to be called after Discord linking
     */
    static async discordLinked(
        userId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardDiscordPoints(userId, referralCode)
    }

    /**
     * Hook to be called after Discord unlinking
     */
    static async discordUnlinked(userId: string): Promise<RPCResponse> {
        return await this.pointSystem.deductDiscordPoints(userId)
    }

    /**
     * Hook to be called after UD domain linking
     */
    static async udDomainLinked(
        userId: string,
        domain: string,
        signingAddress: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardUdDomainPoints(
            userId,
            domain,
            signingAddress,
            referralCode,
        )
    }

    /**
     * Hook to be called after UD domain unlinking
     */
    static async udDomainUnlinked(
        userId: string,
        domain: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.deductUdDomainPoints(userId, domain)
    }

    /**
     * Hook to be called after Nomis score linking
     */
    static async nomisLinked(
        userId: string,
        chain: string,
        nomisScore: number,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardNomisScorePoints(
            userId,
            chain,
            nomisScore,
            referralCode,
        )
    }

    /**
     * Hook to be called after Nomis score unlinking
     */
    static async nomisUnlinked(
        userId: string,
        chain: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.deductNomisScorePoints(
            userId,
            chain,
        )
    }

    /**
     * Hook to be called after Human Passport linking
     */
    static async humanPassportLinked(
        userId: string,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardHumanPassportPoints(
            userId,
            referralCode,
        )
    }

    /**
     * Hook to be called after Human Passport unlinking
     */
    static async humanPassportUnlinked(
        userId: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.deductHumanPassportPoints(userId)
    }

    /**
     * Hook to be called after Ethos score linking
     */
    static async ethosLinked(
        userId: string,
        chain: string,
        ethosScore: number,
        referralCode?: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardEthosScorePoints(
            userId,
            chain,
            ethosScore,
            referralCode,
        )
    }

    /**
     * Hook to be called after Ethos score unlinking
     */
    static async ethosUnlinked(
        userId: string,
        chain: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.deductEthosScorePoints(
            userId,
            chain,
        )
    }
}
