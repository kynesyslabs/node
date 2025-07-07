import type { IOperation } from "@kynesyslabs/demosdk/types"
import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import log from "@/utilities/logger"

async function handleEVMContractWrite(operation: IOperation, chainID: number) {
    // NOTE: Logic is similar to handleEVMPay
    let evmInstance = EVM.getInstance(chainID)

    if (!evmInstance) {
        const rpcUrl =
            operation.rpc || evmProviders[operation.chain][operation.subchain]

        evmInstance = EVM.createInstance(chainID, rpcUrl)
        await evmInstance.connect()
    }

    return await evmInstance.sendSignedTransaction(
        operation.task.signedPayloads[0],
    )
}

export default async function handleContractWrite(
    operation: IOperation,
    chainID: number,
) {
    switch (operation.chain) {
        case "eth":
            return await handleEVMContractWrite(operation, chainID)
        default:
            return {
                result: "error",
                error: `Chain: ${operation.chain} not supported`,
            }
    }
}
