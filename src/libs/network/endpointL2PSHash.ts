import L2PSHashes from "@/libs/blockchain/l2ps_hashes"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { emptyResponse } from "./rpcDispatch"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"

interface L2PSHashPayload {
    l2ps_uid: string
    consolidated_hash: string
    transaction_count: number
}

export async function handleL2PSHashUpdate(tx: Transaction): Promise<RPCResponse> {
    const response: RPCResponse = structuredClone(emptyResponse)

    try {
        if (!tx.content?.data?.[1]) {
            response.result = 400
            response.response = "Invalid transaction structure"
            response.extra = "Missing L2PS hash payload in transaction data"
            return response
        }

        if (!tx.blockNumber) {
            response.result = 400
            response.response = "Missing block_number"
            response.extra = "L2PS hash updates require valid block_number (cannot default to 0)"
            return response
        }

        const payloadData = tx.content.data[1]

        if (
            typeof payloadData !== "object" ||
            !("l2ps_uid" in payloadData) ||
            !("consolidated_hash" in payloadData) ||
            !("transaction_count" in payloadData)
        ) {
            response.result = 400
            response.response = "Invalid L2PS hash payload"
            response.extra = "Missing required fields: l2ps_uid, consolidated_hash, or transaction_count"
            return response
        }

        const l2psHashPayload = payloadData as L2PSHashPayload
        const l2psUid = l2psHashPayload.l2ps_uid

        const parallelNetworks = ParallelNetworks.getInstance()
        const l2psInstance = await parallelNetworks.getL2PS(l2psUid)

        if (!l2psInstance) {
            response.result = 403
            response.response = "Not participant in L2PS network"
            response.extra = `L2PS network ${l2psUid} not found or not joined`
            return response
        }

        try {
            await L2PSHashes.updateHash(
                l2psHashPayload.l2ps_uid,
                l2psHashPayload.consolidated_hash,
                l2psHashPayload.transaction_count,
                BigInt(tx.blockNumber),
            )

            log.info(`[L2PS Hash Update] Stored hash for L2PS ${l2psUid}: ${l2psHashPayload.consolidated_hash.substring(0, 16)}... (${l2psHashPayload.transaction_count} txs)`)
        } catch (storageError: any) {
            log.error("[L2PS Hash Update] Failed to store hash mapping:", storageError)
            response.result = 500
            response.response = "Failed to store L2PS hash update"
            response.extra = storageError.message || "Storage error"
            return response
        }

        response.result = 200
        response.response = {
            message: "L2PS hash update processed",
            l2ps_uid: l2psUid,
            consolidated_hash: l2psHashPayload.consolidated_hash,
            transaction_count: l2psHashPayload.transaction_count,
        }
        return response

    } catch (error) {
        log.error("[L2PS Hash Update] Error processing hash update:", error)
        const errorMsg = error instanceof Error ? error.message : String(error)
        response.result = 500
        response.response = "Internal error processing L2PS hash update"
        response.extra = errorMsg || "Unknown error"
        return response
    }
}
