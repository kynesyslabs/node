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
     * Hook to be called after Web3 wallet linking
     */
    async onWalletLinked(
        userId: string,
        walletAddress: string,
        chain: string,
    ): Promise<RPCResponse> {
        return await this.pointSystem.awardWeb3WalletPoints(
            userId,
            walletAddress,
            chain,
        )
    }

    /**
     * Hook to be called after Twitter linking
     */
    async onTwitterLinked(userId: string): Promise<RPCResponse> {
        return await this.pointSystem.awardTwitterPoints(userId)
    }

    async onGetPoints(userId: string): Promise<RPCResponse> {
        return await this.pointSystem.getUserPoints(userId)
    }
}
