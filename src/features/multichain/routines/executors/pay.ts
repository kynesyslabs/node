import { IOperation } from "@kynesyslabs/demosdk/types"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"

import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import { TransactionResponse } from "sdk/localsdk/multichain/types/multichain"
import checkSignedPayloads from "src/utilities/checkSignedPayloads"
import validateIfUint8Array from "@/utilities/validateUint8Array"
import handleAptosPayRest from "./aptos_pay_rest"

/**
 * Executes a XM pay operation and returns
 * @param operation The XM operation to be executed
 * @param chainID The chain ID for the EVM pay operation
 * @returns A promise to an object with the status and the result of the operation
 */
export default async function handlePayOperation(
    operation: IOperation,
    chainID: number,
) {
    let result: TransactionResponse

    console.log("[XMScript Parser] Pay task. Examining payloads (require 1)...")
    // NOTE For the following tasks we need to check the signed payloads against checkSignedPayloads()

    // NOTE Generic sanity check on payloads
    if (!checkSignedPayloads(1, operation.task.signedPayloads)) {
        console.log(
            "[XMScript Parser] Pay task failed: Invalid payloads (require 1 has 0)",
        )
        return {
            result: "error",
            error: "Invalid signedPayloads length",
        }
    }
    console.log(
        "[XMScript Parser] Pay task payloads are ok: Valid payloads (require 1 has 1)",
    )
    // ANCHOR EVM (which is quite simple: send a signed transaction. Done.)
    if (operation.is_evm) {
        // If is EVM, send tx and return the result
        return await handleEVMPay(chainID, operation)
    }

    // SECTION: Non EVM Section has more complexity
    console.log("[XMScript Parser] Non-EVM PAY")

    // ANCHOR Ripple
    const rpcUrl =
        operation.rpc || chainProviders[operation.chain][operation.subchain]
    if (!rpcUrl) {
        return {
            result: "error",
            error: `RPC URL not found for ${operation.chain}.${operation.subchain}`,
        }
    }

    switch (operation.chain) {
        case "xrpl":
            result = await handleXRPLPay(rpcUrl, operation)
            break

        case "egld":
            result = await genericJsonRpcPay(
                multichain.MULTIVERSX,
                rpcUrl,
                operation,
            )
            break

        case "ibc":
            result = await genericJsonRpcPay(multichain.IBC, rpcUrl, operation)
            break

        case "solana":
            result = await genericJsonRpcPay(
                multichain.SOLANA,
                rpcUrl,
                operation,
            )
            break

        case "ton":
            result = await genericJsonRpcPay(multichain.TON, rpcUrl, operation)
            break

        case "btc":
            result = await genericJsonRpcPay(multichain.BTC, rpcUrl, operation)
            break

        case "aptos":
            // result = await genericJsonRpcPay(multichain.APTOS, rpcUrl, operation)
            result = await handleAptosPayRest(operation)
            break

        default:
            result = {
                result: "error",
                error: `Chain: ${operation.chain} not supported`,
            }
    }

    console.log("[XMScript Parser] Non-EVM PAY: result")
    console.log(result)

    // REVIEW is this ok here?
    return result
}

/**
 * Executes a JSON RPC Pay operation for a JSON RPC sdk and returns the result
 * @param rpc_url The RPC URL for the chain
 * @param operation The operation to be executed
 */
export async function genericJsonRpcPay(
    sdk: any,
    rpcUrl: string,
    operation: IOperation,
) {
    console.log([
        `[XMScript Parser] Generic JSON RPC Pay on: ${operation.chain}.${operation.subchain}`,
    ])
    let instance: multichain.IBC

    try {
        instance = await sdk.create(rpcUrl)
    } catch (error) {
        return {
            result: "error",
            error: error.toString(),
        }
    }

    try {
        let signedTx = operation.task.signedPayloads[0]
        signedTx = validateIfUint8Array(signedTx)

        // INFO: Send payload and return the result
        const result = await instance.sendTransaction(signedTx)
        console.log("[XMScript Parser] Generic JSON RPC Pay: result: ")
        console.log(result)

        return result
    } catch (error) {
        console.log("[XMScript Parser] Generic JSON RPC Pay: error: ")
        console.log(error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}

/**
 * Executes an EVM Pay operation and returns the result
 */
async function handleEVMPay(chainID: number, operation: IOperation) {
    console.log(
        "[XMScript Parser] EVM Pay: trying to send the payload as a signed transaction...",
    ) // REVIEW Simulations?
    console.log(chainID)

    console.log(operation.task.signedPayloads)

    console.log(operation.task.signedPayloads[0])

    let evmInstance = multichain.EVM.getInstance(chainID)

    if (!evmInstance) {
        const rpcUrl =
            operation.rpc || evmProviders[operation.chain][operation.subchain]

        evmInstance = multichain.EVM.createInstance(chainID, rpcUrl)
        await evmInstance.connect()
    }

    return await multichain.EVM.getInstance(chainID).sendSignedTransaction(
        operation.task.signedPayloads[0],
    )
}

/**
 * Executes a Ripple Pay operation and returns the result
 */
async function handleXRPLPay(
    rpcUrl: string,
    operation: IOperation,
): Promise<TransactionResponse> {
    console.log(
        `[XMScript Parser] Ripple Pay: ${operation.chain} on ${operation.subchain}`,
    )
    console.log(
        `[XMScript Parser] Ripple Pay: we will use ${rpcUrl} to connect to ${operation.chain} on ${operation.subchain}`,
    )
    console.log(
        "[XMScript Parser] Ripple Pay: trying to send the payload as a signed transaction...",
    ) // REVIEW Simulations?
    const xrplInstance = new multichain.XRPL(rpcUrl)
    const connected = await xrplInstance.connect()
    console.log("CONNECT RETURNED: ", connected)

    if (!connected) {
        return {
            result: "error",
            error: `Failed to connect to the XRP network. RPC URL: "${rpcUrl}" on ${operation.chain}.${operation.subchain} is not reachable`,
        }
    }

    // REVIEW 10 seconds timeout for connection
    let timer = 0
    while (!xrplInstance.connected) {
        await new Promise(resolve => setTimeout(resolve, 300))
        timer += 300
        if (timer > 10000) {
            console.log("[XMScript Parser] Ripple Pay: timeout")
            return {
                result: "error",
                error: "Timeout in connecting to the XRP network",
            }
        }
    }
    console.log("[XMScript Parser] Ripple Pay: connected to the XRP network")

    try {
        const signedTx = operation.task.signedPayloads[0]

        // Submit transaction and wait for validation
        const res = await xrplInstance.provider.submitAndWait(signedTx.tx_blob)

        const txResult = res.result.meta?.TransactionResult || res.result.engine_result
        const txHash = res.result.hash

        // Handle successful transactions
        if (txResult === 'tesSUCCESS') {
            return {
                result: "success",
                hash: txHash,
            }
        }

        // Handle already submitted or queued transactions
        if (txResult === 'temREDUNDANT' || txResult === 'terQUEUED') {
            return {
                result: "success",
                hash: signedTx.hash || txHash,
            }
        }

        // Handle applied transactions (tec codes indicate transaction was applied but claimed a fee)
        if (txResult?.startsWith('tec')) {
            return {
                result: "success",
                hash: txHash,
            }
        }

        // Transaction failed
        return {
            result: "error",
            error: `${txResult}: ${res.result.engine_result_message || 'Unknown error'}`,
            hash: txHash,
        }
    } catch (error) {
        console.log("[XMScript Parser] Ripple Pay: error:", error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}
