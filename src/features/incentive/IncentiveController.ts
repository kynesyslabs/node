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
        console.log(`[IncentiveController] With sender: ${sender}`)
        console.log(`[IncentiveController] With params:`, params)

        try {
            switch (method) {
                case "getPoints": {
                    console.log(
                        `[IncentiveController] Getting points for user: ${sender}`,
                    )
                    const userPoints = await this.pointSystem.getUserPoints(
                        sender,
                    )
                    return {
                        result: 200,
                        response: userPoints,
                        require_reply: false,
                        extra: {},
                    }
                }

                case "walletLinked":
                    if (params.length < 2) {
                        console.error(
                            `[IncentiveController] Invalid params for walletLinked. Expected 2, got ${params.length}`,
                        )
                        return {
                            result: 400,
                            response: "Missing parameters for wallet linking",
                            require_reply: false,
                            extra: {
                                expected: 2,
                                received: params.length,
                            },
                        }
                    }

                    console.log(
                        `[IncentiveController] Linking wallet for user: ${sender}, wallet: ${params[0]}, chain: ${params[1]}`,
                    )
                    return await this.pointSystem.awardWeb3WalletPoints(
                        sender,
                        params[0], // walletAddress
                        params[1], // chain
                    )

                case "twitterLinked":
                    console.log(
                        `[IncentiveController] Linking Twitter for user: ${sender}, handle: ${params[0]}`,
                    )
                    return await this.pointSystem.awardTwitterPoints(
                        sender,
                        params[0], // twitterHandle
                    )

                default:
                    console.warn(
                        `[IncentiveController] Unknown method: ${method}`,
                    )
                    return {
                        result: 400,
                        response: "Unknown method",
                        require_reply: false,
                        extra: {
                            message: `Method ${method} not supported`,
                        },
                    }
            }
        } catch (error) {
            console.error(
                `[IncentiveController] Error handling method ${method}:`,
                error,
            )
            return {
                result: 500,
                response: "Internal server error",
                require_reply: false,
                extra: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            }
        }
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
