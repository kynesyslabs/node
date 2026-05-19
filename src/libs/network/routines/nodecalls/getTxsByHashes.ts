import Mempool from "@/libs/blockchain/mempool"
import { getSharedState } from "@/utilities/sharedState"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { handleError } from "src/errors"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

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

    log.info(
        `[NETWORK] Received getTxsByHashes request for ${data.hashes.length} transactions`,
    )

    try {
        let hashes = data.hashes
        if (hashes.length > getSharedState.batchSyncTxLimit) {
            // INFO: Limit maximum number of transactions to be sent back at a time
            hashes = data.hashes.slice(0, getSharedState.batchSyncTxLimit)
        }

        const toGet = new Set(hashes)
        const transactions = await Chain.getTransactionsFromHashes(hashes)

        for (const tx of transactions) {
            toGet.delete(tx.hash)
        }

        if (toGet.size > 0) {
            // NOTE: If peer tries to fetch transactions for a block not
            // finalized by this peer yet,
            // (because block is broadcasted right after voting,
            // and it's possible that this peer might be slow)
            // the block txs will not be in the transactions table yet,
            // fetch them from the mempool, and update the blockNumber to match block
            const missing = await Mempool.getTransactionsByHashes(
                Array.from(toGet),
            )
            transactions.push(
                ...missing.map(tx => ({
                    ...tx,
                    blockNumber: getSharedState.lastBlockNumber,
                })),
            )
        }

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
        handleError(error, "NETWORK", { source: "getTxsByHashes" })
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
