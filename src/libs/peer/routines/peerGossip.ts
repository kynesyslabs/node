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

const maxGossipPeers = 10
// Gossip is the only way a node learns peers it was not introduced to by
// hello: a node whose only contact restarted and forgot it stays cut off
// until a round reaches it.
export const PEER_GOSSIP_INTERVAL_MS = 30_000

/**
 * Digest of a peer list by identity only. Sync heights and URLs differ
 * between views of the same set, so a digest over whole peer objects never
 * matched and every round fetched every list.
 */
export function peerlistDigest(peers: { identity: string }[]): string {
    // Code-unit order, not locale order: every node must hash the same bytes.
    const identities = [...new Set(peers.map(peer => peer.identity))].sort(
        (a, b) => Number(a > b) - Number(a < b),
    )
    return Hashing.sha256(JSON.stringify(identities))
}

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

    const others = allPeers.filter(
        peer => peer.identity && peer.identity !== getSharedState.publicKeyHex,
    )
    if (others.length === 0) {
        log.debug("[peerGossip] No other peers to gossip with")
        return
    }

    const selectedPeers = selectPeersForGossip(others)
    const peersHash = peerlistDigest(allPeers)

    log.custom("peerGossip", `Hashed our peerlist: ${peersHash}`, false)

    const peerHashResponses = await requestPeerlistHashes(selectedPeers)
    const differentPeerlistPeers = identifyDifferentPeers(
        peerHashResponses,
        peersHash,
        selectedPeers,
    )

    if (differentPeerlistPeers.length === 0) {
        log.custom("peerGossip", "No peers to sync with", true)
        // process.exit(0)
        return
    }

    await peersGossipProcess(differentPeerlistPeers)
}

// A list is untrusted input from any peer that passed hello; these bound how
// many hellos one round can make this node send.
export const MAX_PEERS_PER_LIST = 128
export const MAX_NEW_PEERS_PER_ROUND = 32

/**
 * Up to `count` entries of `list`, starting at a random offset and wrapping.
 * Lists arrive sorted by identity, so a fixed window would never reach a
 * missing peer past it, and a capped round would retry the same failing
 * candidates forever.
 */
function randomWindow<T>(list: T[], count: number, random: () => number): T[] {
    if (list.length <= count) return list
    const start = Math.floor(random() * list.length)
    return Array.from({ length: count }, (_, i) => list[(start + i) % list.length])
}

/**
 * Peers named in remote lists that this node does not know yet. Only the
 * identity and URL are taken: a list never sets sync data or status, which
 * for a known peer come from its own hello (see PeerManager.setPeers). A
 * malformed list or entry is skipped without dropping the others.
 */
export function unknownPeersFromLists(
    lists: unknown[],
    random: () => number = Math.random,
): Peer[] {
    const peerManager = PeerManager.getInstance()
    const found = new Map<string, Peer>()
    for (const list of randomWindow(lists, lists.length, random)) {
        if (!Array.isArray(list)) continue
        for (const entry of randomWindow(list, MAX_PEERS_PER_LIST, random)) {
            if (found.size >= MAX_NEW_PEERS_PER_ROUND) return [...found.values()]
            const identity = entry?.identity
            const url = entry?.connection?.string
            if (typeof identity !== "string" || typeof url !== "string") continue
            if (
                identity === getSharedState.publicKeyHex ||
                peerManager.getPeer(identity) ||
                found.has(identity)
            ) {
                continue
            }
            found.set(identity, new Peer(url, identity))
        }
    }
    return [...found.values()]
}

/**
 * Asks the peers whose lists differ for their full list and says hello to
 * the peers it names that this node does not know.
 */
async function peersGossipProcess(differentPeerlistPeers: Peer[]) {
    const peerlistRequest: RPCRequest = {
        method: "nodeCall",
        params: [{ message: "getPeerlist", data: null, muid: null }],
    }

    const responses = await Promise.allSettled(
        differentPeerlistPeers.map(peer => peer.call(peerlistRequest)),
    )
    const lists = responses
        .filter(
            (answer): answer is PromiseFulfilledResult<RPCResponse> =>
                answer.status === "fulfilled" && answer.value?.result === 200,
        )
        .map(answer => answer.value.response)

    const newPeers = unknownPeersFromLists(lists)
    log.debug(`[peerGossip] New peers from gossip: ${newPeers.length}`)
    if (newPeers.length > 0) {
        PeerManager.getInstance().setPeers(newPeers)
    }
}

/**
 * Selects a subset of peers for gossip.
 * @param {Peer[]} peers - All available peers.
 * @returns {Peer[]} - Selected peers for gossip.
 */
function selectPeersForGossip(peers: Peer[]): Peer[] {
    if (peers.length <= maxGossipPeers) {
        log.custom(
            "peerGossip",
            `Less than ${maxGossipPeers} peers, gossiping with all of them`,
            true,
        )
        return peers
    }

    log.custom("peerGossip", `Selecting ${maxGossipPeers} random peers`, false)
    return shuffleArray(peers).slice(0, maxGossipPeers)
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
    // One answer per peer, in order: identifyDifferentPeers pairs them by index.
    return Promise.all(
        peers.map(peer =>
            peer.call(peerlistHashRequest).catch(
                error =>
                    ({
                        result: 500,
                        response: null,
                        require_reply: false,
                        extra: error instanceof Error ? error.message : String(error),
                    }) as RPCResponse,
            ),
        ),
    )
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

        if (response.result === 200 && peerHash !== ourHash) {
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
