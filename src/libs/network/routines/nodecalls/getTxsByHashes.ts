import { getSharedState } from "@/utilities/sharedState"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"

interface InterfaceGetTxsByHashesData {
    hashes: string[]
}

export default async function getTxsByHashes(
    data: InterfaceGetTxsByHashesData,
): Promise<RPCResponse> {
    // Validate input
    if (!data.hashes || !Array.isArray(data.hashes)) {
        return {
            result: 400,
            response: [],
            extra: "Error: Invalid hashes parameter - must be an array",
            require_reply: false,
        }
    }

    if (data.hashes.length === 0) {
        return {
            result: 200,
            response: [],
            extra: "",
            require_reply: false,
        }
    }

    console.log(
        `[SERVER] Received getTxsByHashes request for ${data.hashes.length} transactions`,
    )

    try {
        let hashes = data.hashes
        if (hashes.length > getSharedState.batchSyncTxLimit) {
            // INFO: Limit maximum number of transactions to be sent back at a time
            hashes = data.hashes.slice(0, getSharedState.batchSyncTxLimit)
        }

        const transactions = await Chain.getTransactionsFromHashes(hashes)
        if (transactions && transactions.length > 0) {
            return {
                result: 200,
                response: transactions,
                require_reply: false,
                extra: "",
            }
        }

        return {
            result: 404,
            response: [],
            extra: "No transactions found for provided hashes",
            require_reply: false,
        }
    } catch (error) {
        console.error("[getTxsByHashes] Error fetching transactions:", error)
        return {
            result: 500,
            response: [],
            extra: `Error: ${
                error instanceof Error ? error.message : "Unknown error"
            }`,
            require_reply: false,
        }
    }
}
