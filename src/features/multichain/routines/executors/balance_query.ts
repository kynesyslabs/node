import type { IOperation } from "@kynesyslabs/demosdk/types"
import handleAptosBalanceQuery from "./aptos_balance_query"

export default async function handleBalanceQuery(
    operation: IOperation,
    chainID: number,
) {
    console.log("[XM Method] Balance Query - Chain:", operation.chain)
    
    try {
        switch (operation.chain) {
            case "aptos":
                return await handleAptosBalanceQuery(operation)
            
            // TODO: Add other chains as needed
            // case "evm":
            //     return await handleEvmBalanceQuery(operation)
            // case "solana":
            //     return await handleSolanaBalanceQuery(operation)
            
            default:
                return {
                    result: "error",
                    error: `Balance query not supported for chain: ${operation.chain}`,
                }
        }
    } catch (error) {
        console.error("[Balance Query] Error:", error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}