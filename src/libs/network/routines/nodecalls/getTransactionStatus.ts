import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/

interface InterfaceGetTransactionStatusData {
    hash: unknown
}

/**
 * Returns the lifecycle state of a transaction by hash (see TxStatus), with
 * `checkedThroughBlock`: the height this node had searched through.
 *
 * A hash not found is answered 404, or 503 when this node knows it is two or
 * more blocks behind, so "not in this chain through H" is never confused
 * with "this node is behind"; a failed lookup is 500. `inSyncLoop` is not
 * used: every consensus round starts with a sync pass, so a node at the tip
 * would flap to 503. The state stays in the body in
 * every case, because SDK clients read only the body and keep polling on
 * "unknown".
 */
export default async function getTransactionStatus(
    data: InterfaceGetTransactionStatusData,
): Promise<RPCResponse> {
    const hash = data?.hash
    if (typeof hash !== "string" || !TX_HASH_REGEX.test(hash)) {
        return {
            result: 400,
            response: { error: "Missing or invalid 'hash' field" },
            extra: "",
            require_reply: false,
        }
    }
    const normalizedHash = hash.toLowerCase()

    try {
        // Read before the lookup, so everything at or below it was searched.
        const checkedThroughBlock = await Chain.getLastBlockNumber()
        const status = await Chain.getTransactionStatus(normalizedHash)
        if (status.state !== "unknown") {
            return {
                result: 200,
                response: { ...status, checkedThroughBlock },
                extra: "",
                require_reply: false,
            }
        }
        const synced = getSharedState.syncStatus
        return {
            result: synced ? 404 : 503,
            response: { state: "unknown", checkedThroughBlock },
            extra: { reason: synced ? "not_found" : "node_not_synced" },
            require_reply: false,
        }
    } catch (error) {
        log.error("[getTransactionStatus] Error fetching tx status:", error)
        return {
            result: 500,
            response: { error: "INTERNAL_ERROR" },
            extra: {
                reason: "lookup_failed",
                error: error instanceof Error ? error.message : String(error),
            },
            require_reply: false,
        }
    }
}
