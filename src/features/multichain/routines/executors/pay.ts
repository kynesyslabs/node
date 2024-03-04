import { IOperation } from "../XMParser"
import { multichain } from "sdk/localsdk"
import { TransactionResponse } from "sdk/localsdk/multichain/types/multichain"

import checkSignedPayloads from "src/utilities/checkSignedPayloads"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"

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
    const rpc_url = chainProviders[operation.chain][operation.subchain]
    switch (operation.chain) {
        case "xrpl":
            result = await handleXRPLPay(rpc_url, operation)
            break

        case "egld":
            result = await handleEGLDPay(rpc_url, operation)
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
        evmInstance = multichain.EVM.createInstance(
            chainID,
            evmProviders[operation.chain][operation.subchain],
        )
        await evmInstance.connect(
            evmProviders[operation.chain][operation.subchain],
        )
    }

    return await multichain.EVM.getInstance(chainID).sendSignedTransaction(
        operation.task.signedPayloads[0],
    )
}

/**
 * Executes a Ripple Pay operation and returns the result
 */
async function handleXRPLPay(
    rpc_url: string,
    operation: IOperation,
): Promise<TransactionResponse> {
    console.log(
        `[XMScript Parser] Ripple Pay: ${operation.chain} on ${operation.subchain}`,
    )
    console.log(
        `[XMScript Parser] Ripple Pay: we will use ${rpc_url} to connect to ${operation.chain} on ${operation.subchain}`,
    )
    console.log(
        "[XMScript Parser] Ripple Pay: trying to send the payload as a signed transaction...",
    ) // REVIEW Simulations?
    let xrplInstance = new multichain.XRPL(rpc_url)
    const connected = await xrplInstance.connect(rpc_url)
    console.log("CONNECT RETURNED: ", connected)

    if (!connected) {
        return {
            result: "error",
            error: `Failed to connect to the XRP network. RPC URL: "${rpc_url}" on ${operation.chain}.${operation.subchain} is not reachable`,
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
        console.log("[XMScript Parser]: debugging operation")
        console.log(operation.task)
        console.log(JSON.stringify(operation.task))
        const result = await xrplInstance.sendTransaction(
            operation.task.signedPayloads[0],
        )
        console.log("[XMScript Parser] Ripple Pay: result: ")
        console.log(result)

        return result
    } catch (error) {
        console.log("[XMScript Parser] Ripple Pay: error: ")
        console.log(error)
        return {
            result: "error",
            error: error,
        }
    }
}

/**
 * Executes an EGLD Pay operation and returns the result
 */
async function handleEGLDPay(
    rpc_url: string,
    operation: IOperation,
): Promise<TransactionResponse> {
    console.log(
        `[XMScript Parser] EGLD Pay: ${operation.chain} on ${operation.subchain}`,
    )
    // INFO: Create a new chain instance
    const mxInstance = new multichain.MULTIVERSX(rpc_url)

    try {
        // INFO: Connect and wait for the connection to be verified
        await mxInstance.connect()
    } catch (error) {
        return {
            result: "error",
            error: error.toString(),
        }
    }

    try {
        const signedTx = operation.task.signedPayloads[0]

        // INFO: Send payload and return the result
        const result = await mxInstance.sendTransaction(signedTx)
        console.log("[XMScript Parser] EGLD Pay: result: ")
        console.log(result)

        return result
    } catch (error) {
        console.log("[XMScript Parser] EGLD Pay: error: ")
        console.log(error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}
