import { Peer, PeerManager } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import { promisify } from "util"
import log from "src/utilities/logger"

import Transmission from "../../communications/transmission"
/* eslint-disable indent */
import * as stat from "./timeSyncUtils"
import { NodeCall } from "../manageNodeCall"

const sleep = promisify(setTimeout)
interface Offset {
    roundtrip: number
    offset: number
}

interface SynchronizationData {
    offset: number
    latency: number
}

export default async function getPeerTime(
    peer: Peer,
    id: any,
): Promise<number> {
    // A peer object must have a valid socket
    if (!peer.connection.string) {
        return null
    }

    log.warning("[PEER TIMESYNC] Getting peer time delta")
    log.debug("[PEER TIMESYNC] Peer: " + JSON.stringify(peer))
    log.debug("[PEER TIMESYNC] ID: " + id)

    const nodeCall: NodeCall = {
        message: "getPeerTime",
        data: null,
        muid: null,
    }

    const response = await peer.call({
        method: "nodeCall",
        params: [nodeCall],
    })

    // Response management
    if (response.result === 200) {
        log.debug(
            `[PEER TIMESYNC] Received timestamp in response: ${response.response}`,
        )
    } else {
        log.warning("[PEER TIMESYNC] No timestamp received")
    }
    return response.response.timestamp
}

export const calculatePeerTimeOffset =
    async (): Promise<SynchronizationData> => {
        //FIXME: this should happen outside of here, in the part where the peers that will partecipate in block validation are selected
        const id = getSharedState.identity
        const peer = PeerManager.getInstance().getPeers()[0]

        const offsets = [] as Offset[]
        for (let i = 0; i < 20; i++) {
            await sleep(500)
            const offset = await calculateOffset(id, peer)
            offsets.push(offset)
        }

        // filter out null results
        const results = offsets.filter(result => result !== null)

        // calculate the limit for outliers
        const roundtrips = results.map(result => result.roundtrip)
        const limit = stat.median(roundtrips) + stat.std(roundtrips)

        log.debug(`[PEER TIMESYNC] latency median: ${stat.median(roundtrips)}`)
        log.debug(
            `[PEER TIMESYNC] latency standard deviation: ${stat.std(
                roundtrips,
            )}`,
        )
        log.debug(`[PEER TIMESYNC] latency limit: ${limit}`)
        // filter all results which have a roundtrip smaller than the mean+std
        const filtered = results.filter(result => result.roundtrip < limit)
        const processedOffsets = filtered.map(result => result.offset)
        const processedLatencies = filtered.map(result => result.roundtrip / 2)

        // return the new offset
        return filtered.length > 0
            ? {
                  offset: stat.mean(processedOffsets),
                  latency: stat.mean(processedLatencies),
              }
            : null
    }

const calculateOffset = async (id, peer): Promise<Offset> => {
    // Upon receipt by client, client subtracts current time from sent time and divides by two to compute latency.
    const startTime = new Date().valueOf()

    //FIXME: Handle timeouts of requests
    const serverTime = await getPeerTime(id, peer)
    const currentTime = new Date().valueOf()

    const roundtrip = currentTime - startTime
    const onewayTrip = roundtrip / 2

    // It subtracts current time from server time to determine client-server time delta and adds in the half-latency to get the correct clock delta.
    const offset = serverTime - currentTime + onewayTrip

    return { offset, roundtrip }
}
