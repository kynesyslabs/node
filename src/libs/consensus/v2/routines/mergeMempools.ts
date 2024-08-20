import Mempool from "src/libs/blockchain/mempool"
import { MempoolData } from "src/libs/blockchain/mempool"
import { Peer } from "src/libs/peer"

export async function mergeMempools(
    mempool: MempoolData,
    shard: Peer[],
): Promise<MempoolData> {
    var promises = []
    for (const peer of shard) {
        promises.push(
            peer.call({
                method: "mempool", // see server_rpc.ts
                params: [{ data: mempool }], // ? If possible, we should send the mempool directly without wrapping it in an object
            }),
        )
    }
    // Waiting for the various calls to complete
    await Promise.all(promises) // ! Add error handling
    // We call getMempool again to make sure we have the latest version that should have the merged mempools
    let mergedMempool = await Mempool.getMempool()
    return mergedMempool
}