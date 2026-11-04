import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import {
    answer,
    failedRead,
    refusal,
    signedHeader,
    toBlockNumber,
    type SignedHeader,
} from "./finalityShared"

export const MAX_SEGMENT_BLOCKS = 500

// Content grows with the transactions a block orders, so the count alone
// does not bound a reply; past this many content bytes the segment ends
// early and the client asks again from `to + 1`.
export const MAX_SEGMENT_CONTENT_BYTES = 8 * 1024 * 1024

/**
 * Signed headers `from..to` (inclusive), for a client walking the chain
 * from a checkpoint it trusts: each carries the bytes its hash is taken of,
 * the round and the message its signatures sign.
 *
 * `to` in the answer is the last header served: the range is cut at this
 * node's head and at MAX_SEGMENT_CONTENT_BYTES, never at a gap. 400 for a
 * range that is not 0 <= from <= to or spans more than MAX_SEGMENT_BLOCKS;
 * 404 not_found when `from` is above the head (503 node_not_synced while
 * this node is behind).
 */
export default async function getBlockSegment(data: {
    from?: unknown
    to?: unknown
}): Promise<RPCResponse> {
    const from = toBlockNumber(data?.from)
    const to = toBlockNumber(data?.to)
    if (from === null || to === null || to < from) {
        return refusal(400, "invalid_range")
    }
    if (to - from + 1 > MAX_SEGMENT_BLOCKS) {
        return refusal(400, "range_too_large", { maxBlocks: MAX_SEGMENT_BLOCKS })
    }

    try {
        const head = await Chain.getLastBlockNumber()
        if (from > head) {
            return getSharedState.syncStatus
                ? refusal(404, "not_found", { head })
                : refusal(503, "node_not_synced", { head })
        }
        const last = Math.min(to, head)
        const blocks = await Chain.getBlockRange(from, last)
        if (blocks.length !== last - from + 1) {
            throw new Error(`blocks ${from}..${last} are not all stored (${blocks.length} found)`)
        }

        const headers: SignedHeader[] = []
        let bytes = 0
        for (const [i, block] of blocks.entries()) {
            if (block.number !== from + i) {
                throw new Error(`block ${from + i} is missing from the stored range ${from}..${last}`)
            }
            const header = signedHeader(block)
            if (headers.length > 0 && bytes + header.contentBytes.length > MAX_SEGMENT_CONTENT_BYTES) {
                break
            }
            bytes += header.contentBytes.length
            headers.push(header)
        }

        return answer({
            from,
            to: from + headers.length - 1,
            head,
            headers,
        })
    } catch (error) {
        log.error("[getBlockSegment] Error reading the segment:", error)
        return failedRead(error)
    }
}
