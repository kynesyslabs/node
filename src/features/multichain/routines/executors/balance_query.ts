import type { IOperation } from "@kynesyslabs/demosdk/types"
import handleAptosBalanceQuery from "./aptos_balance_query"
import log from "@/utilities/logger"
import errorKind, { logField } from "../errorKind"

export default async function handleBalanceQuery(
    operation: IOperation,
    chainID: number,
) {
    log.debug("[XM Method] Balance Query - Chain:", logField(operation.chain))

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
        log.error(`[Balance Query] Error: ${errorKind(error)}`)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}
