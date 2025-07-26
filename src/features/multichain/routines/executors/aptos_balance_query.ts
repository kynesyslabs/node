import type { IOperation } from "@kynesyslabs/demosdk/types"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { Network } from "@aptos-labs/ts-sdk"

export default async function handleAptosBalanceQuery(
    operation: IOperation,
) {
    console.log("[XM Method] Aptos Balance Query")
    
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

        // Validate required parameters for Aptos balance queries
        if (!params.address) {
            console.log("Missing address")
            return {
                result: "error",
                error: "Missing address",
            }
        }

        if (!params.coinType) {
            console.log("Missing coinType")
            return {
                result: "error",
                error: "Missing coinType",
            }
        }

        console.log(`querying balance for address: ${params.address}`)
        console.log(`coin type: ${params.coinType}`)

        // Query balance using the appropriate method
        let balance: string
        
        if (params.coinType === "0x1::aptos_coin::AptosCoin") {
            // Use APT-specific method for efficiency
            balance = await aptosInstance.getAPTBalanceDirect(params.address)
        } else {
            // Use generic coin balance method
            balance = await aptosInstance.getCoinBalanceDirect(params.coinType, params.address)
        }

        console.log("balance query result:", balance)

        return {
            result: balance,
            status: true,
        }

    } catch (error) {
        console.error("Aptos balance query error:", error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}