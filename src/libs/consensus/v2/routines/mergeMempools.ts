import { Peer } from "@/libs/peer"
import log from "@/utilities/logger"
import Mempool from "@/libs/blockchain/mempool"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"

const PEER_CALL_TIMEOUT_MS = 15_000

function withTimeout(
    promise: Promise<RPCResponse>,
    ms: number,
    peer: Peer,
): Promise<RPCResponse> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<RPCResponse>(resolve => {
        timeoutId = setTimeout(
            () =>
                resolve({
                    result: 504,
                    response: "mergeMempools peer timeout",
                    require_reply: false,
                    extra: peer.identity,
                }),
            ms,
        )
    })

    return Promise.race([
        promise.finally(() => clearTimeout(timeoutId)),
        timeoutPromise,
    ])
}

export async function mergeMempools(mempool: Transaction[], shard: Peer[]) {
    // INFO: if shard only contains us, skip network requests
    shard = shard.filter(peer => peer.identity !== getSharedState.publicKeyHex)
    if (shard.length === 0) {
        return
    }

    const request: RPCRequest = {
        method: "mempool",
        params: mempool,
    }

    const promises = shard.map(peer => {
        log.only(
            `[mergeMempools] Merging mempool with ${peer.connection.string}`,
        )
        return withTimeout(
            peer.longCall(request, true, {
                sleepTime: 250,
                retries: 2,
            }),
            PEER_CALL_TIMEOUT_MS,
            peer,
        )
    })

    const settled = await Promise.allSettled(promises)

    // INFO: collect txs from successful responses, deduped by hash,
    // so we make a single Mempool.receive call instead of one per peer.
    const merged = new Map<string, Transaction>()
    for (const [i, result] of settled.entries()) {
        const peer = shard[i]

        if (result.status === "rejected") {
            log.error(
                `[mergeMempools] longCall rejected for ${peer.connection.string}: ${result.reason}`,
            )
            continue
        }

        const response = result.value
        if (response.result !== 200) {
            log.error(
                `[mergeMempools] Non-200 from ${peer.connection.string}: ${JSON.stringify(response, null, 2)}`,
            )
            continue
        }

        const txs = response.response as Transaction[]
        log.only(
            `[mergeMempools] Received ${txs.length} transactions from ${peer.connection.string}`,
        )
        for (const tx of txs) {
            if (!merged.has(tx.hash)) {
                merged.set(tx.hash, tx)
            }
        }
    }

    if (merged.size === 0) {
        return
    }

    log.only(
        `[mergeMempools] Forwarding ${merged.size} unique txs to Mempool.receive`,
    )
    await Mempool.receive(Array.from(merged.values()))
}
