import type { IOperation } from "@kynesyslabs/demosdk/types"
import { EVM, MULTIVERSX, SOLANA } from "@kynesyslabs/demosdk/xm-localsdk"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import log from "@/utilities/logger"
import handleAptosContractWrite from "./aptos_contract_write"
import { genericJsonRpcPay } from "./pay"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"

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

async function handleSolanaContractWrite(operation: IOperation) {
    // The operation contains the signed transaction - reuse genericJsonRpcPay
    return await genericJsonRpcPay(
        SOLANA,
        chainProviders.solana[operation.subchain],
        operation,
    )
}

async function handleMultiversxContractWrite(operation: IOperation) {
    // Signed payload is an IPlainTransactionObject; the localSDK's MULTIVERSX.sendTransaction
    // POSTs it to the MultiversX REST API at /transaction/send.
    return await genericJsonRpcPay(
        MULTIVERSX,
        chainProviders.egld[operation.subchain],
        operation,
    )
}

export default async function handleContractWrite(
    operation: IOperation,
    chainID: number,
) {
    if (operation.is_evm) {
        return await handleEVMContractWrite(operation, chainID)
    }

    switch (operation.chain) {
        case "aptos":
            return await handleAptosContractWrite(operation)
        case "solana":
            return await handleSolanaContractWrite(operation)
        case "egld":
            return await handleMultiversxContractWrite(operation)
        default:
            return {
                result: "error",
                error: `Chain: ${operation.chain} not supported`,
            }
    }
}
