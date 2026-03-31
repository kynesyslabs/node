import type { IOperation } from "@kynesyslabs/demosdk/types"
import * as multichain from "@kynesyslabs/demosdk/xm-localsdk"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import { Network } from "@aptos-labs/ts-sdk"
import handleAptosPayRest from "./aptos_pay_rest"
import log from "@/utilities/logger"

export default async function handleAptosContractWrite(operation: IOperation) {
    return await handleAptosPayRest(operation)
    log.debug("[XM Method] Aptos Contract Write")

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

        // Contract writes require pre-signed transactions (following EVM pattern)
        if (
            !operation.task.signedPayloads ||
            operation.task.signedPayloads.length === 0
        ) {
            return {
                result: "error",
                error: "Missing signed transaction payload. Contract writes must be pre-signed on SDK side.",
            }
        }

        log.debug("Processing pre-signed Aptos contract write transaction")

        // Send the pre-signed transaction using LocalSDK (same pattern as EVM)
        const signedTx = operation.task.signedPayloads[0]
        const txResponse = await aptosInstance.sendTransaction(signedTx)

        log.debug("Aptos contract write transaction result:", txResponse.result)
        log.debug("Transaction hash:", txResponse.hash)

        return {
            result: txResponse.result,
            hash: txResponse.hash,
            status: txResponse.result === "success",
        }
    } catch (error) {
        log.error("Aptos contract write error:", error)
        return {
            result: "error",
            error: error.toString(),
        }
    }
}
