import type { IOperation } from "@kynesyslabs/demosdk/types"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { Network } from "@aptos-labs/ts-sdk"
import log from "@/utilities/logger"
import errorKind from "../errorKind"

export default async function handleAptosBalanceQuery(operation: IOperation) {
    log.debug("[XM Method] Aptos Balance Query")

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

        // NOTE Params, results and full errors are not logged
        const params = operation.task.params

        // Validate required parameters for Aptos balance queries
        if (!params.address) {
            log.debug("Missing address")
            return {
                result: "error",
                error: "Missing address",
            }
        }

        if (!params.coinType) {
            log.debug("Missing coinType")
            return {
                result: "error",
                error: "Missing coinType",
            }
        }

        // Query balance using the appropriate method
        let balance: string

        if (params.coinType === "0x1::aptos_coin::AptosCoin") {
            // Use APT-specific method for efficiency
            balance = await aptosInstance.getAPTBalanceDirect(params.address)
        } else {
            // Use generic coin balance method
            balance = await aptosInstance.getCoinBalanceDirect(
                params.coinType,
                params.address,
            )
        }

        log.debug("balance query result received")

        return {
            result: balance,
            status: true,
        }
    } catch (error) {
        log.error(`Aptos balance query error: ${errorKind(error)}`)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}
