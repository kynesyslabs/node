import type { IOperation } from "@kynesyslabs/demosdk/types"
import { EVM, SOLANA, TON } from "@kynesyslabs/demosdk/xm-localsdk"
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

async function handleTonContractWrite(operation: IOperation) {
    // Signed payload is a hex-encoded BoC of the wallet's external message; the localSDK's
    // TON.sendTransaction parses it and broadcasts via TonCenter.
    return await genericJsonRpcPay(
        TON,
        chainProviders.ton[operation.subchain],
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
        case "ton":
            return await handleTonContractWrite(operation)
        default:
            return {
                result: "error",
                error: `Chain: ${operation.chain} not supported`,
            }
    }
}
