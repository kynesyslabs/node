import { Peer } from "@/libs/peer"
import log from "@/utilities/logger"
import Mempool from "@/libs/blockchain/mempool"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"

export async function mergeMempools(mempool: Transaction[], shard: Peer[]) {
    // INFO: if shard only contains us, skip network requests
    shard = shard.filter(peer => peer.identity !== getSharedState.publicKeyHex)
    if (shard.length === 0) {
        return
    }

    const promises: Promise<RPCResponse>[] = []
    const request: RPCRequest = {
        method: "mempool",
        params: mempool,
    }

    for (const peer of shard) {
        log.debug(
            `[mergeMempools] Merging mempool with ${peer.connection.string}`,
        )
        promises.push(
            peer.longCall(request, true, {
                sleepTime: 250,
                retries: 3,
            }),
        )
    }

    const responses = await Promise.all(promises) // ! Add error handling
    for (const response of responses) {
        if (response.result === 200) {
            log.debug(
                `[mergeMempools] Received ${response.response.length} transactions`,
            )
            await Mempool.receive(response.response as Transaction[])
        } else {
            log.error("Error when merging mempools")
            log.error(JSON.stringify(response, null, 2))
        }
    }
}
