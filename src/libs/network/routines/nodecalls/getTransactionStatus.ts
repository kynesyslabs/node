import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/

interface InterfaceGetTransactionStatusData {
    hash: unknown
}

/**
 * Returns the lifecycle state of a transaction by hash:
 *   - "pending"  — present in mempool
 *   - "included" — present in transactions table (with blockNumber)
 *   - "failed"   — reserved (not currently produced — see Chain.getTransactionStatus)
 *   - "unknown"  — not found anywhere
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
        const status = await Chain.getTransactionStatus(normalizedHash)
        return {
            result: 200,
            response: status,
            extra: "",
            require_reply: false,
        }
    } catch (error) {
        log.error(
            "[getTransactionStatus] Error fetching tx status:",
            error,
        )
        return {
            result: 500,
            response: { error: "INTERNAL_ERROR" },
            extra: `Error: ${
                error instanceof Error ? error.message : "Unknown error"
            }`,
            require_reply: false,
        }
    }
}
