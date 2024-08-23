import { RPCResponse } from "@kynesyslabs/demosdk-http/types"
import log from "src/utilities/logger"
import { Peer } from "src/libs/peer"

export default async function averageTimestamps(shard: Peer[]) {
    log.info("[CONSENSUS] Averaging timestamps for shard")
    var timestamps = []
    var promises: Promise<RPCResponse>[] = []
    // Ask each peer in the shard for their timestamp
    for (const peer of shard) {
        promises.push(peer.call({
            method: "consensus_routine",
            params: [{
                method: "getValidatorTimestamp",
                params: [],
            }],
        }))
    }
    // Wait for all promises to resolve
    await Promise.all(promises)
    for (const promise of promises) {
        var response = await promise
        timestamps.push(response.response)
    }
    // Calculate the average timestamp
    var average = timestamps.reduce((a, b) => a + b, 0) / timestamps.length
    log.info(`[CONSENSUS] Average timestamp: ${average} | Based on ${timestamps.length} peers`)
    // Return the average timestamp
    return average
}