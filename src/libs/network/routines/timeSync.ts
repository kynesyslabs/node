/* eslint-disable indent */
import * as stat from "./timeSyncUtils"
import { promisify } from "util"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import ResponseRegistry from "../../communications/responseRegistry"
import { Peer, PeerManager } from "src/libs/peer"
import { Identity } from "src/libs/identity"

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
    if (!peer.socket) {
        return null
    }

    console.warn("[PEER TIMESYNC] Getting peer time delta")
    console.log(peer)
    console.log(id)

    // Asking the peer for its time
    let comlink = new ComLink()
    let time_ask = new Transmission(id.privateKey)
    time_ask.initialize(
        "nodeCall",
        "getPeerTime",
        id.publicKey,
        "placeholder",
        null,
        null,
    )
    console.log("[PEER TIMESYNC] Time Ask")
    console.log(time_ask)
    await time_ask.finalize()
    comlink.properties.require_reply = true
    comlink.properties.is_reply = false
    console.log("[PEER TIMESYNC] Sending comlink")
    //console.log(comlink)
    // Adding the response request
    ResponseRegistry.getInstance().requestResponse(comlink)
    // Broadcasting the request
    await comlink.broadcastMessageToPeer(peer, time_ask, id.privateKey)
    // Awaiting the response
    let response = await ResponseRegistry.getInstance().checkResponse(
        comlink.muid,
    )
    console.log("[PEER TIMESYNC] Response received")
   //console.log(response)

    // Response management
    if (response[0]) {
        console.log(
            `[PEER TIMESYNC] Received timestamp in response: ${response[1].timestamp}`,
        )
    } else {
        console.log("[PEER TIMESYNC] No timestamp received")
    }
    return response[1].timestamp
}

export const calculatePeerTimeOffset =
    async (): Promise<SynchronizationData> => {
        //FIXME: this should happen outside of here, in the part where the peers that will partecipate in block validation are selected
        const id = Identity.getInstance()
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

        console.log(`[PEER TIMESYNC] latency median: ${stat.median(roundtrips)}`)
        console.log(
            `[PEER TIMESYNC] latency standard deviation: ${stat.std(
                roundtrips,
            )}`,
        )
        console.log(`[PEER TIMESYNC] latency limit: ${limit}`)
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
