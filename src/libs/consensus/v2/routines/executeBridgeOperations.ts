import { Transaction } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

export default async function executeBridgeOperations(
    mempool: Transaction[],
): Promise<[string[], string[]]> {
    // TODO Implement this
    // Get the native bridge operations from the mempool
    const nativeBridgeOperations = []

    for (const tx of mempool) {
        if (tx.content.type === "nativeBridge") {
            nativeBridgeOperations.push(tx)
        }
    }

    log.only(JSON.stringify(nativeBridgeOperations, null, 2))

    // TODO Execute the native bridge operations themselves

    return [[], []]
}
