import axios, { AxiosError } from "axios"
import { Deserializer, SignedTransaction } from "@aptos-labs/ts-sdk"

import { IOperation } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import type { TransactionResponse } from "sdk/localsdk/multichain/types/multichain"
import { XM_APTOS_SUBMIT_TIMEOUT_MS } from "src/utilities/constants"
import { aptosSignedTxHash } from "./signedTxHash"

/**
 * The outcome when the transaction may have reached the chain but the node
 * cannot tell: it names the hash so the caller can look it up.
 */
// Errors raised before any byte reached the Aptos node.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"])

function unknownOutcome(hash: string, chain: string, why: string): TransactionResponse {
    return {
        result: "unknown",
        hash,
        chain,
        error: `${why}; the transaction may still be included. Look up its hash before retrying.`,
    }
}

export default async function handleAptosPayRest(
    operation: IOperation,
): Promise<TransactionResponse> {
    try {
        const providerUrl = chainProviders.aptos[operation.subchain]
        if (!providerUrl) {
            return {
                result: "error",
                error: `Unsupported Aptos network: ${operation.subchain}`,
            }
        }

        const payload = operation.task.signedPayloads[0]
        if (!payload) {
            return {
                result: "error",
                error: "No signed payloads",
            }
        }

        const tx = hexToUint8Array(payload)

        try {
            // INFO: Try and parse the payload into a transaction object
            const deserializer = new Deserializer(tx)
            SignedTransaction.deserialize(deserializer)
        } catch {
            return {
                result: "error",
                error: "Invalid signed payload",
            }
        }

        const hash = aptosSignedTxHash(tx)
        const chain = operation.chain + "." + operation.subchain
        let response
        try {
            response = await axios.post(providerUrl + "/transactions", tx, {
                headers: {
                    "Content-Type": "application/x.aptos.signed_transaction+bcs",
                    Accept: "application/json",
                },
                timeout: XM_APTOS_SUBMIT_TIMEOUT_MS,
            })
        } catch (error) {
            if (error instanceof AxiosError && error.response?.data) {
                // The node answered and refused the transaction.
                return { result: "error", error: error.response.data }
            }
            const why = error instanceof Error ? error.message : String(error)
            const code = (error as { code?: string })?.code
            if (code && NOT_SENT_CODES.has(code)) {
                return { result: "error", error: `Aptos node unreachable: ${why}` }
            }
            // Possibly sent, but no answer: a timeout or a dropped connection.
            return unknownOutcome(hash, chain, `No answer from the Aptos node (${why})`)
        }

        if (typeof response.data?.hash === "string" && response.data.hash) {
            return { result: "success", hash: response.data.hash, chain }
        }
        return unknownOutcome(hash, chain, "The Aptos node accepted the request without naming a transaction hash")
    } catch (error) {
        return {
            result: "error",
            error: error instanceof Error ? error.message : String(error),
        }
    }
}
