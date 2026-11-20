import type { IOperation } from "@kynesyslabs/demosdk/types"
import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
// import handleAptosContractRead from "./aptos_contract_read"
import { handleAptosContractReadRest } from "./aptos_contract_read"
import log from "@/utilities/logger"
import { logField } from "../errorKind"

/**
 * Reads a contract. An EVM read uses only the node's configured RPC for the
 * chain, on a connection of its own: the SDK's per-chain instance, which pay
 * and contract_write broadcast through, is never created or replaced here.
 */
export default async function handleContractRead(
    operation: IOperation,
    chainID: number,
) {
    log.debug(
        `[XM Method] Read contract on ${logField(operation.chain)}.${logField(operation.subchain)}`,
    )
    // Mainly EVM but let's let it open for weird chains
    // Workflow: loading the provider url in our configuration, creating an instance, parsing the request
    // and sending back the chain response as it is
    if (operation.is_evm) {
        // NOTE Own keys only: a chain or subchain such as "constructor" or
        // "__proto__" must not resolve to an inherited property
        const subchains = Object.hasOwn(evmProviders, operation.chain)
            ? evmProviders[operation.chain]
            : {}
        const providerUrl = Object.hasOwn(subchains, operation.subchain)
            ? subchains[operation.subchain]
            : undefined
        if (typeof providerUrl !== "string" || providerUrl === "") {
            return {
                result: "error",
                error: `RPC URL not found for ${operation.chain}.${operation.subchain}`,
            }
        }
        const params = operation.task.params // REVIEW Error handling
        if (!params.address) {
            log.debug("Missing address")
            return {
                result: "error",
                error: "Missing contract address",
            }
        }
        if (!params.abi) {
            log.debug("Missing ABI")
            return {
                result: "error",
                error: "Missing contract ABI",
            }
        }
        if (!params.method) {
            log.debug("Missing contract method")
            return {
                result: "error",
                error: "Missing contract method",
            }
        }
        const evmInstance = new EVM(providerUrl, chainID)
        try {
            await evmInstance.connect()
            // Getting a contract instance using the evm library
            const contractInstance = await evmInstance.getContractInstance(
                params.address,
                params.abi,
            )
            const methodParams = JSON.parse(params.params)
            // Convert the object values into an array
            const argsArray = Object.values(methodParams)
            // Only a function of the given ABI is called
            const result = await contractInstance.getFunction(params.method)(
                ...argsArray,
            )
            log.debug("result from EVM read call received")
            return {
                result: result,
                status: true,
            }
        } finally {
            evmInstance.provider?.destroy?.()
        }
    } else if (operation.chain === "aptos") {
        // Handle Aptos contract reads using dedicated handler
        return await handleAptosContractReadRest(operation)
    } else {
        return {
            result: "error",
            error: `Not implemented yet: contract_read on ${operation.chain} chain`,
        }
    }
}
