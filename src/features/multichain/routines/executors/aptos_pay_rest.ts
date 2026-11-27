import axios, { AxiosError } from "axios"
import { Deserializer, SignedTransaction } from "@aptos-labs/ts-sdk"

import { IOperation } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"
import type { TransactionResponse } from "sdk/localsdk/multichain/types/multichain"

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

        const response = await axios.post(providerUrl + "/transactions", tx, {
            headers: {
                "Content-Type": "application/x.aptos.signed_transaction+bcs",
                Accept: "application/json",
            },
            timeout: 1000,
        })

        if (response.data?.hash) {
            return {
                result: "success",
                hash: response.data.hash,
                chain: operation.chain + "." + operation.subchain,
            }
        }

        return {
            result: "success",
            error: response.data,
        }
    } catch (error) {
        if (error instanceof AxiosError) {
            if (error.response?.data) {
                return {
                    result: "error",
                    error: error.response.data,
                }
            }

            // check if is a timeout error
            if (error.message.includes("timeout")) {
                return {
                    result: "error",
                    error: "Transaction timeout. Please try again",
                }
            }

            return {
                result: "error",
                error: error.message,
            }
        }

        return {
            result: "error",
            error: error.toString(),
        }
    }
}
