import type { IOperation } from "@kynesyslabs/demosdk/types"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk"
import axios, { AxiosError } from "axios"
import log from "@/utilities/logger"
import errorKind from "../errorKind"

// NOTE args may parse to a non-array (e.g. "null"): a log line must not throw
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0)

/**
 * This function is used to read from a smart contract using the Aptos REST API
 * @param operation - The operation object
 * @returns The result of the read operation
 */
export async function handleAptosContractReadRest(operation: IOperation) {
    log.debug("[XM Method] Aptos Contract Read")

    try {
        const providerUrl = chainProviders.aptos[operation.subchain]
        if (!providerUrl) {
            return {
                result: "error",
                error: `Unsupported Aptos network: ${operation.subchain}`,
            }
        }

        // NOTE Params, call arguments, results and full errors are not logged
        const params = operation.task.params

        // Validate required parameters for Aptos contract reads
        if (!params.moduleAddress) {
            log.debug("Missing moduleAddress")
            return {
                result: "error",
                error: "Missing moduleAddress",
            }
        }

        if (!params.moduleName) {
            log.debug("Missing moduleName")
            return {
                result: "error",
                error: "Missing moduleName",
            }
        }

        if (!params.functionName) {
            log.debug("Missing functionName")
            return {
                result: "error",
                error: "Missing functionName",
            }
        }

        let functionArgs = []
        if (params.args) {
            try {
                functionArgs = Array.isArray(params.args)
                    ? params.args
                    : JSON.parse(params.args)
            } catch (error) {
                log.debug("Invalid function arguments format")
                return {
                    result: "error",
                    error: "Invalid function arguments format. Expected array or JSON string.",
                }
            }
        }

        let typeArguments = []
        if (params.typeArguments) {
            try {
                typeArguments = Array.isArray(params.typeArguments)
                    ? params.typeArguments
                    : JSON.parse(params.typeArguments)
            } catch (error) {
                log.debug("Invalid type arguments format")
                return {
                    result: "error",
                    error: "Invalid type arguments format. Expected array or JSON string.",
                }
            }
        }

        log.debug(
            `calling Move view function with ${count(functionArgs)} argument(s) and ${count(typeArguments)} type argument(s)`,
        )

        const functionInfo =
            params.moduleAddress +
            "::" +
            params.moduleName +
            "::" +
            params.functionName

        const response = await axios.post(providerUrl + "/view", {
            function: functionInfo,
            type_arguments: params.typeArguments || [],
            arguments: params.args || [],
        })

        log.debug("response from Aptos view call received")

        return {
            result: response.data,
            status: "success",
        }
    } catch (error) {
        log.error(`Aptos contract read error: ${errorKind(error)}`)
        if (error instanceof AxiosError) {
            return {
                status: "failed",
                error: error.response.data,
            }
        }
        return {
            result: "Failed to read from contract",
            error: error.toString(),
        }
    }
}

export default async function handleAptosContractRead(operation: IOperation) {
    log.debug("[XM Method] Aptos Contract Read")

    try {
        // Get the provider URL from our configuration
        const providerUrl = chainProviders.aptos[operation.subchain]
        if (!providerUrl) {
            return {
                result: "error",
                error: `Unsupported Aptos network: ${operation.subchain}`,
            }
        }

        log.debug(
            `[XM Method] operation.chain: ${operation.chain}, operation.subchain: ${operation.subchain}`,
        )
        log.debug(`[XM Method]: providerUrl: ${providerUrl}`)

        // Map subchain to Network enum
        const networkMap = {
            mainnet: Network.MAINNET,
            testnet: Network.TESTNET,
            devnet: Network.DEVNET,
        }

        const network = networkMap[operation.subchain]
        if (!network) {
            return {
                result: "error",
                error: `Invalid Aptos network: ${operation.subchain}. Supported: mainnet, testnet, devnet`,
            }
        }

        // Create Aptos instance using the localsdk
        const aptosInstance = new multichain.APTOS(providerUrl, network)
        await aptosInstance.connect()

        // NOTE Params, call arguments, results and full errors are not logged
        const params = operation.task.params

        // Validate required parameters for Aptos contract reads
        if (!params.moduleAddress) {
            log.debug("Missing moduleAddress")
            return {
                result: "error",
                error: "Missing moduleAddress",
            }
        }

        if (!params.moduleName) {
            log.debug("Missing moduleName")
            return {
                result: "error",
                error: "Missing moduleName",
            }
        }

        if (!params.functionName) {
            log.debug("Missing functionName")
            return {
                result: "error",
                error: "Missing functionName",
            }
        }

        // Parse function arguments (default to empty array if not provided)
        let functionArgs = []
        if (params.args) {
            try {
                functionArgs = Array.isArray(params.args)
                    ? params.args
                    : JSON.parse(params.args)
            } catch (error) {
                log.debug("Invalid function arguments format")
                return {
                    result: "error",
                    error: "Invalid function arguments format. Expected array or JSON string.",
                }
            }
        }

        // Parse type arguments (optional for Move view functions)
        let typeArguments = []
        if (params.typeArguments) {
            try {
                typeArguments = Array.isArray(params.typeArguments)
                    ? params.typeArguments
                    : JSON.parse(params.typeArguments)
            } catch (error) {
                log.debug("Invalid type arguments format")
                return {
                    result: "error",
                    error: "Invalid type arguments format. Expected array or JSON string.",
                }
            }
        }

        log.debug(
            `calling Move view function with ${count(functionArgs)} argument(s) and ${count(typeArguments)} type argument(s)`,
        )

        // Call the readFromContract method with enhanced Move support
        const result = await aptosInstance.readFromContractDirect(
            params.moduleAddress,
            params.moduleName,
            params.functionName,
            functionArgs,
            typeArguments,
        )

        log.debug("result from Aptos view call received")

        return {
            result: result,
            status: true,
        }
    } catch (error) {
        log.error(`Aptos contract read error: ${errorKind(error)}`)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}
