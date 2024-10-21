/* INFO
 * Peer Gossip Protocol Implementation
 *
 * This module manages the peer gossip process in a distributed network.
 * It handles peer list synchronization through the following steps:
 * 1. Initiates gossip with a subset of known peers
 * 2. Compares peer list hashes to identify discrepancies
 * 3. Requests full peer lists from peers with different hashes
 * 4. Merges and updates the local peer list
 *
 * The process ensures network-wide consistency of peer information
 * while minimizing unnecessary data transfer.
 */

import log from "src/utilities/logger"
import Peer from "../Peer"
import PeerManager from "../PeerManager"
import { getSharedState } from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"

const MAX_GOSSIP_PEERS = 10

/**
 * Initiates the peer gossip process.
 * This function ensures that only one gossip process runs at a time.
 */
export async function peerGossip() {
    if (getSharedState.inPeerGossip) return
    getSharedState.inPeerGossip = true

    try {
        log.custom("peerGossip", "Starting peer gossip", true)
        await performPeerGossip()
    } finally {
        getSharedState.inPeerGossip = false
        log.custom("peerGossip", "Peer gossip finished", true)
    }
}

/**
 * Performs the main peer gossip process.
 * This includes selecting peers, comparing peer lists, and syncing with peers that have different lists.
 */
async function performPeerGossip() {
    const peerManager = PeerManager.getInstance()
    const allPeers = peerManager.getPeers()

    if (allPeers.length === 0) {
        log.custom("peerGossip", "No peers to gossip with", true)
        return
    }

    const selectedPeers = selectPeersForGossip(allPeers)
    const orderedPeers = orderPeers(allPeers)
    const peersHash = Hashing.sha256(JSON.stringify(orderedPeers))

    log.custom("peerGossip", `Hashed our peerlist: ${peersHash}`, false)

    const peerHashResponses = await requestPeerlistHashes(selectedPeers)
    const differentPeerlistPeers = identifyDifferentPeers(
        peerHashResponses,
        peersHash,
        selectedPeers,
    )

    if (differentPeerlistPeers.length === 0) {
        log.custom("peerGossip", "No peers to sync with", true)
        return
    }

    await peersGossipProcess(differentPeerlistPeers, orderedPeers)
}

/**
 * Processes gossip with peers that have different peer lists.
 * Requests full peer lists from these peers and merges them.
 * @param {Peer[]} differentPeerlistPeers - Peers with different peer list hashes.
 * @param {Peer[]} ourPeerlist - Our current peer list.
 */
async function peersGossipProcess(
    differentPeerlistPeers: Peer[],
    ourPeerlist: Peer[],
) {
    const peerlistRequest: RPCRequest = {
        method: "nodeCall",
        params: [{ message: "getPeerlist", data: null, muid: null }],
    }

    log.custom(
        "peerGossip",
        "Requesting peerlist from peers with different hashes",
        false,
    )
    const responses = await Promise.all(
        differentPeerlistPeers.map(peer => peer.call(peerlistRequest)),
    )
    log.custom(
        "peerGossip",
        "Received peerlists from peers with different hashes",
        false,
    )

    const peerlistsToMerge = responses.map(response => response.response)
    peerlistsToMerge.push(ourPeerlist)

    log.custom("peerGossip", "Merging peerlists", false)
    await mergePeerlists(peerlistsToMerge)
    log.custom("peerGossip", "Peerlists merged", false)
}

/**
 * Merges multiple peer lists into a single, ordered, unique peer list.
 * @param {Peer[][]} peerlists - Array of peer lists to merge.
 * @returns {Promise<boolean>} - Returns true when merge is complete.
 */
async function mergePeerlists(peerlists: Peer[][]): Promise<boolean> {
    let mergedPeerlist: Peer[] = []
    for (let peerlist of peerlists) {
        for (let peer of peerlist) {
            if (!mergedPeerlist.includes(peer)) {
                mergedPeerlist.push(peer)
            }
        }
    }
    mergedPeerlist.sort((a, b) => a.identity.localeCompare(b.identity))
    PeerManager.getInstance().setPeers(mergedPeerlist)
    return true
}

/**
 * Selects a subset of peers for gossip.
 * @param {Peer[]} peers - All available peers.
 * @returns {Peer[]} - Selected peers for gossip.
 */
function selectPeersForGossip(peers: Peer[]): Peer[] {
    if (peers.length <= MAX_GOSSIP_PEERS) {
        log.custom(
            "peerGossip",
            `Less than ${MAX_GOSSIP_PEERS} peers, gossiping with all of them`,
            true,
        )
        return peers
    }

    log.custom(
        "peerGossip",
        `Selecting ${MAX_GOSSIP_PEERS} random peers`,
        false,
    )
    return shuffleArray(peers).slice(0, MAX_GOSSIP_PEERS)
}

/**
 * Orders peers based on their identity.
 * @param {Peer[]} peers - Peers to order.
 * @returns {Peer[]} - Ordered peers.
 */
function orderPeers(peers: Peer[]): Peer[] {
    return [...peers].sort((a, b) => a.identity.localeCompare(b.identity))
}

/**
 * Requests peer list hashes from selected peers.
 * @param {Peer[]} peers - Peers to request hashes from.
 * @returns {Promise<RPCResponse[]>} - Responses containing peer list hashes.
 */
async function requestPeerlistHashes(peers: Peer[]): Promise<RPCResponse[]> {
    const peerlistHashRequest: RPCRequest = {
        method: "nodeCall",
        params: [{ message: "getPeerlistHash", data: null, muid: null }],
    }

    log.custom(
        "peerGossip",
        "Sending peerlist hash request to selected peers",
        false,
    )
    let promises = []
    for (let peer of peers) {
        if (!peer.identity) {
            log.custom("peerGossip", "Peer has no identity, skipping", false)
            log.warning(`[peerGossip] Peer has no identity: ${peer}`)
            continue
        }
        console.log(`Sending peerlist hash request to ${peer.identity}`)
        promises.push(peer.call(peerlistHashRequest))
    }
    const responses = await Promise.all(promises)
    log.custom("peerGossip", "Received peerlist hashes", false)

    return responses
}

/**
 * Identifies peers with different peer list hashes.
 * @param {RPCResponse[]} responses - Responses containing peer list hashes.
 * @param {string} ourHash - Hash of our peer list.
 * @param {Peer[]} peers - Peers that were queried.
 * @returns {Peer[]} - Peers with different peer list hashes.
 */
function identifyDifferentPeers(
    responses: RPCResponse[],
    ourHash: string,
    peers: Peer[],
): Peer[] {
    return responses.reduce((acc, response, index) => {
        const peerHash = response.response
        log.custom("peerGossip", `- Peerlist hash: ${peerHash}`, false)

        if (peerHash !== ourHash) {
            log.custom(
                "peerGossip",
                `[!] Peerlist hash mismatch, we will sync with this peer. Hash: ${peerHash}`,
                false,
            )
            acc.push(peers[index])
        } else {
            log.custom(
                "peerGossip",
                `[*] Peerlist hash match, we will not sync with this peer. Hash: ${peerHash}`,
                false,
            )
        }

        return acc
    }, [] as Peer[])
}

/**
 * Shuffles an array using the Fisher-Yates shuffle algorithm.
 * @param {T[]} array - Array to shuffle.
 * @returns {T[]} - Shuffled array.
 */
function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array]
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled
}
