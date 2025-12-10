import { RPCResponse, Transaction } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool_v2"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"

export async function mergeMempools(mempool: Transaction[], shard: Peer[]) {
    const promises: Promise<RPCResponse>[] = []
    for (const peer of shard) {
        log.info(`[mergeMempools] Merging mempool with ${peer.identity}`)
        promises.push(
            peer.longCall(
                {
                    method: "mempool",
                    params: mempool.map(tx => tx.hash),
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
        log.info("[mergeMempools] " + JSON.stringify(response, null, 2))

        if (response.result === 200) {
            // INFO: Response contains the difference between the two nodes
            if (response.response.length > 0) {
                log.only("🟠 [mergeMempools] Receiving difference: " + response.response.length)
                await Mempool.receive(response.response as Transaction[])
            } else {
                log.only("🟠 [mergeMempools] No difference received")
            }
        }
    }
}
