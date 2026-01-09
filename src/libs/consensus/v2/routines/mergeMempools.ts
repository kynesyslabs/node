import { RPCResponse, Transaction } from "@kynesyslabs/demosdk/types"
import Mempool from "@/libs/blockchain/mempool_v2"
import { Peer } from "@/libs/peer"
import log from "@/utilities/logger"

export async function mergeMempools(mempool: Transaction[], shard: Peer[]) {
    const promises: Promise<RPCResponse>[] = []
    for (const peer of shard) {
        log.info(`[mergeMempools] Merging mempool with ${peer.identity}`)
        promises.push(
            peer.longCall(
                {
                    method: "mempool",
                    params: mempool,
                },
                true,
                250,
                3,
            ),
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
