import Mempool from "src/libs/blockchain/mempool"
import { MempoolData } from "src/libs/blockchain/mempool"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"

export async function mergeMempools(
    mempool: MempoolData,
    shard: Peer[],
): Promise<MempoolData> {
    var promises = []
    for (const peer of shard) {
        log.info(`[mergeMempools] Merging mempool with ${peer.identity}`)
        promises.push(
            peer.call({
                method: "mempool", // see server_rpc.ts
                params: [{ data: mempool }], // ? If possible, we should send the mempool directly without wrapping it in an object
            }),
        )
    }
    log.info("[mergeMempools] Merging mempools is awaiting")
    // Waiting for the various calls to complete
    await Promise.all(promises) // ! Add error handling
    log.info("[mergeMempools] Merging mempools is complete")
    // We call getMempool again to make sure we have the latest version that should have the merged mempools
    let mergedMempool = await Mempool.getMempool()
    console.log("[mergeMempools] Merged mempool:")
    console.log(mergedMempool)
    return mergedMempool
}