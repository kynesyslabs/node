import { Peer } from "@/libs/peer"
import log from "@/utilities/logger"
import Mempool from "@/libs/blockchain/mempool_v2"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"

export async function mergeMempools(mempool: Transaction[], shard: Peer[]) {
    // INFO: if shard only contains us, skip network requests
    if (
        shard.length === 1 &&
        shard[0].identity === getSharedState.publicKeyHex
    ) {
        return
    }

    const promises: Promise<RPCResponse>[] = []
    const request: RPCRequest = {
        method: "mempool",
        params: mempool,
    }

    for (const peer of shard) {
        log.info(`[mergeMempools] Merging mempool with ${peer.identity}`)
        promises.push(
            peer.longCall(request, true, {
                sleepTime: 250,
                retries: 3,
            }),
        )
    }

    const responses = await Promise.all(promises) // ! Add error handling

    for (const response of responses) {
        log.info("[mergeMempools] Received mempool merge response:")
        log.debug("[mergeMempools] " + JSON.stringify(response))

        if (response.result === 200) {
            await Mempool.receive(response.response as Transaction[])
        }
    }
}
