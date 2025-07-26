import type { IOperation } from "@kynesyslabs/demosdk/types"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { Network } from "@aptos-labs/ts-sdk"

export default async function handleAptosContractWrite(
    operation: IOperation,
) {
    console.log("[XM Method] Aptos Contract Write")
    
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
            "mainnet": Network.MAINNET,
            "testnet": Network.TESTNET,
            "devnet": Network.DEVNET,
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

        // For contract writes, we can handle two modes:
        // 1. Pre-signed transaction (like EVM) - uses signedPayloads
        // 2. Contract write parameters - builds and signs transaction

        // Mode 1: Pre-signed transaction (preferred for XM consistency)
        if (operation.task.signedPayloads && operation.task.signedPayloads.length > 0) {
            console.log("Processing pre-signed transaction")
            
            // Send the pre-signed transaction using LocalSDK
            const signedTx = operation.task.signedPayloads[0]
            const txResponse = await aptosInstance.sendTransaction(signedTx)
            
            return {
                result: txResponse.result,
                hash: txResponse.hash,
                status: txResponse.result === "success",
            }
        }

        // Mode 2: Build and execute transaction from parameters
        // Validate required parameters for Aptos contract writes
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

        if (!params.privateKey) {
            console.log("Missing privateKey for transaction signing")
            return {
                result: "error",
                error: "Missing privateKey for transaction signing",
            }
        }

        // Parse function arguments (default to empty array if not provided)
        let functionArgs = []
        if (params.args) {
            try {
                functionArgs = Array.isArray(params.args) ? params.args : JSON.parse(params.args)
            } catch (error) {
                console.log("Invalid function arguments format")
                return {
                    result: "error",
                    error: "Invalid function arguments format. Expected array or JSON string.",
                }
            }
        }

        // Parse type arguments (optional for Move entry functions)
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

        console.log(`calling Move entry function: ${params.moduleAddress}::${params.moduleName}::${params.functionName}`)
        console.log("calling with args: " + JSON.stringify(functionArgs))
        console.log("calling with type arguments: " + JSON.stringify(typeArguments))

        // Connect wallet with private key
        await aptosInstance.connectWallet(params.privateKey)

        // Call the writeToContract method
        const txHash = await aptosInstance.writeToContract(
            params.moduleAddress,
            params.moduleName,
            params.functionName,
            functionArgs,
            typeArguments
        )

        console.log("Transaction submitted:", txHash)

        // Wait for transaction confirmation
        const txResponse = await aptosInstance.waitForTransaction(txHash)

        console.log("Transaction confirmed:", txResponse.success)

        return {
            result: "success",
            hash: txHash,
            status: true,
            extra: { txResponse }
        }

    } catch (error) {
        console.error("Aptos contract write error:", error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}