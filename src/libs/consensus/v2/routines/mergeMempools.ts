import { RPCResponse, Transaction } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool_v2"
import { MempoolData } from "src/libs/blockchain/mempool"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"

export async function mergeMempools(mempool: Transaction[], shard: Peer[]) {
    const promises: Promise<RPCResponse>[] = []
    for (const peer of shard) {
        log.info(`[mergeMempools] Merging mempool with ${peer.identity}`)
        promises.push(
            peer.longCall(
                {
                    method: "mempool", // see server_rpc.ts
                    params: [{ data: mempool }], // ? If possible, we should send the mempool directly without wrapping it in an object
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
            await Mempool.receive(response.response as Transaction[])
        }
    }
}
