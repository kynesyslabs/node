import { Transaction } from "@kynesyslabs/demosdk/types"
import { bridge } from "@kynesyslabs/demosdk"
import Mempool from "@/libs/blockchain/mempool_v2"
export default async function executeBridgeOperations(): Promise<[string[], string[]]> {
    // TODO Implement this
    // Get the native bridge operations from the mempool
    const mempool = await Mempool.getMempool()
    const nativeBridgeOperations = []
    for (const tx of mempool) {
        if (tx.content.type === "nativeBridge") {
            nativeBridgeOperations.push(tx)
        }
    }
    // TODO Execute the native bridge operations themselves
    return [[], []]
}