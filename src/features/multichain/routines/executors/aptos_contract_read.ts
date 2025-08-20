import type { IOperation } from "@kynesyslabs/demosdk/types"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk"
import axios, { AxiosError } from "axios"

/**
 * This function is used to read from a smart contract using the Aptos REST API
 * @param operation - The operation object
 * @returns The result of the read operation
 */
export async function handleAptosContractReadRest(operation: IOperation) {
    console.log("[XM Method] Aptos Contract Read")

    try {
        const providerUrl = chainProviders.aptos[operation.subchain]
        if (!providerUrl) {
            return {
                result: "error",
                error: `Unsupported Aptos network: ${operation.subchain}`,
            }
        }

        const params = operation.task.params
        console.log("parsed params: " + JSON.stringify(params))

        // Validate required parameters for Aptos contract reads
        if (!params.moduleAddress) {
            console.log("Missing moduleAddress")
            return {
                result: "error",
                error: "Missing moduleAddress",
            }
        }

        if (!params.moduleName) {
            console.log("Missing moduleName")
            return {
                result: "error",
                error: "Missing moduleName",
            }
        }

        if (!params.functionName) {
            console.log("Missing functionName")
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
                console.log("Invalid function arguments format")
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
                console.log("Invalid type arguments format")
                return {
                    result: "error",
                    error: "Invalid type arguments format. Expected array or JSON string.",
                }
            }
        }

        console.log(
            `calling Move view function: ${params.moduleAddress}::${params.moduleName}::${params.functionName}`,
        )
        console.log("calling with args: " + JSON.stringify(functionArgs))
        console.log(
            "calling with type arguments: " + JSON.stringify(typeArguments),
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

        console.log("response", response.data)

        return {
            result: response.data,
            status: "success",
        }
    } catch (error) {
        console.error("Aptos contract read error:", error)
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
    console.log("[XM Method] Aptos Contract Read")

    try {
        // Get the provider URL from our configuration
        const providerUrl = chainProviders.aptos[operation.subchain]
        if (!providerUrl) {
            return {
                result: "error",
                error: `Unsupported Aptos network: ${operation.subchain}`,
            }
        }

        console.log(
            `[XM Method] operation.chain: ${operation.chain}, operation.subchain: ${operation.subchain}`,
        )
        console.log(`[XM Method]: providerUrl: ${providerUrl}`)

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

        console.log("params: \n")
        console.log(operation.task.params)
        console.log("\n end params: \n")

        const params = operation.task.params
        console.log("parsed params: " + JSON.stringify(params))

        // Validate required parameters for Aptos contract reads
        if (!params.moduleAddress) {
            console.log("Missing moduleAddress")
            return {
                result: "error",
                error: "Missing moduleAddress",
            }
        }

        if (!params.moduleName) {
            console.log("Missing moduleName")
            return {
                result: "error",
                error: "Missing moduleName",
            }
        }

        if (!params.functionName) {
            console.log("Missing functionName")
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
                console.log("Invalid function arguments format")
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
                console.log("Invalid type arguments format")
                return {
                    result: "error",
                    error: "Invalid type arguments format. Expected array or JSON string.",
                }
            }
        }

        console.log(
            `calling Move view function: ${params.moduleAddress}::${params.moduleName}::${params.functionName}`,
        )
        console.log("calling with args: " + JSON.stringify(functionArgs))
        console.log(
            "calling with type arguments: " + JSON.stringify(typeArguments),
        )

        // Call the readFromContract method with enhanced Move support
        const result = await aptosInstance.readFromContractDirect(
            params.moduleAddress,
            params.moduleName,
            params.functionName,
            functionArgs,
            typeArguments,
        )

        console.log("result from Aptos view call received")
        console.log("result:", JSON.stringify(result))

        return {
            result: result,
            status: true,
        }
    } catch (error) {
        console.error("Aptos contract read error:", error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}
