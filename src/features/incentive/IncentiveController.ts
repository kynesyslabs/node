import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { PointSystem } from "./PointSystem"

export class IncentiveController {
    private static instance: IncentiveController
    private pointSystem: PointSystem

    private constructor() {
        this.pointSystem = PointSystem.getInstance()
    }

    public static getInstance(): IncentiveController {
        if (!IncentiveController.instance) {
            IncentiveController.instance = new IncentiveController()
        }
        return IncentiveController.instance
    }

    /**
     * Handle incentive-related RPC requests
     */
    async handleIncentiveRequest(
        sender: string,
        method: string,
        params: any[],
    ): Promise<RPCResponse> {
        console.log(`[IncentiveController] Handling method: ${method}`)

        switch (method) {
            case "getPoints": {
                const userPoints = await this.pointSystem.getUserPoints(sender)
                return {
                    result: 200,
                    response: userPoints,
                    require_reply: false,
                    extra: {},
                }
            }

            case "identityCreated":
                return await this.pointSystem.awardIdentityCreationPoints(
                    sender,
                )

            case "walletLinked":
                return await this.pointSystem.awardWeb3WalletPoints(
                    sender,
                    params[0], // walletAddress
                    params[1], // chain
                )

            case "twitterLinked":
                return await this.pointSystem.awardTwitterPoints(
                    sender,
                    params[0], // twitterHandle
                )

            default:
                return {
                    result: 400,
                    response: "Unknown method",
                    require_reply: false,
                    extra: {
                        message: `Method ${method} not supported`,
                    },
                }
        }
    }

    /**
     * Hook to be called after identity creation
     */
    async onIdentityCreated(userId: string): Promise<void> {
        await this.pointSystem.awardIdentityCreationPoints(userId)
    }

    /**
     * Hook to be called after Web3 wallet linking
     */
    async onWalletLinked(
        userId: string,
        walletAddress: string,
        chain: string,
    ): Promise<void> {
        await this.pointSystem.awardWeb3WalletPoints(
            userId,
            walletAddress,
            chain,
        )
    }

    /**
     * Hook to be called after Twitter linking
     */
    async onTwitterLinked(
        userId: string,
        twitterHandle: string,
    ): Promise<void> {
        await this.pointSystem.awardTwitterPoints(userId, twitterHandle)
    }
}
