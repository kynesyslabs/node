import log from "src/utilities/logger"
import Peer from "../Peer"
import PeerManager from "../PeerManager"
import { getSharedState } from "src/utilities/sharedState"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import { RPCRequest } from "@kynesyslabs/demosdk/types"

export async function peerGossip() {
    // Reentry prevention
    if (getSharedState.inPeerGossip) {
        return
    }
    getSharedState.inPeerGossip = true
    log.custom("peerGossip", "Starting peer gossip", true)
    let selectedPeers = []
    // Getting our peerlist
    let peers = PeerManager.getInstance().getPeers()
    // NOTE If there are no peers to gossip with, we'll just return
    if (peers.length === 0) {
        log.custom("peerGossip", "No peers to gossip with", true)
        return
    }
    // NOTE If there are less than 10 peers, we'll gossip with all of them: else we select 10 random peers to gossip with
    else if (peers.length < 10) {
        log.custom(
            "peerGossip",
            "Less than 10 peers, gossiping with all of them",
            true,
        )
        selectedPeers = peers
    } else {
        // We'll select a random subset of peers to send the peerlist hash request to
        // TODO Use better parameters for this (round robin, active peers, ping (if we have it), etc.)
        log.custom("peerGossip", "Selecting 10 random peers", false)
        var randomIndices = []
        for (let i = 0; i < 10; i++) {
            randomIndices.push(Math.floor(Math.random() * peers.length))
        }
        for (let index of randomIndices) {
            selectedPeers.push(peers[index])
        }
    }
    // Ordering the peerlist in an alphanumeric way
    peers.sort((a, b) => a.identity.localeCompare(b.identity))
    selectedPeers.sort((a, b) => a.identity.localeCompare(b.identity))
    log.custom("peerGossip", "Ordered our peerlist", false)
    // Hashing the peerlist
    let peersHash = Hashing.sha256(JSON.stringify(peers))
    log.custom("peerGossip", "Hashed our peerlist: " + peersHash, false)
    // ANCHOR Requesting the peerlist hashes to all peers
    let peerlistHashRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getPeerlistHash",
                data: null,
                muid: null,
            },
        ],
    }
    // Sending the request to all peers
    var promises = []
    log.custom(
        "peerGossip",
        "Sending peerlist hash request to all peers",
        false,
    )
    for (let peer of selectedPeers) {
        promises.push(peer.call(peerlistHashRequest))
    }
    log.custom("peerGossip", "Requested peerlist hashes", false)
    await Promise.all(promises)
    log.custom("peerGossip", "Received peerlist hashes", false)
    // Gathering the responses
    var peerlistHashes = []
    for (let promise of promises) {
        peerlistHashes.push(promise.response)
    }
    // ANCHOR Checking if the peerlist hashes are the same
    var differentPeerlistPeers: Peer[] = []
    for (let i = 0; i < peerlistHashes.length; i++) {
        if (peerlistHashes[i] !== peersHash) {
            log.custom(
                "peerGossip",
                "Peerlist hash mismatch, we will sync with this peer. Hash: " +
                    peerlistHashes[i],
                false,
            )
            differentPeerlistPeers.push(peers[i])
        }
    }
    // ANCHOR Requesting the peerlist from the peers with different hashes
    // NOTE We don't need to send our peerlist too because the other peers will use the same approach
    let peerlistRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getPeerlist",
                data: null,
                muid: null,
            },
        ],
    }
    log.custom(
        "peerGossip",
        "Requesting peerlist from peers with different hashes",
        false,
    )
    for (let peer of differentPeerlistPeers) {
        promises.push(peer.call(peerlistRequest))
    }
    await Promise.all(promises)
    log.custom(
        "peerGossip",
        "Received peerlists from peers with different hashes",
        false,
    )
    // ANCHOR Merging the peerlists
    let peerlists: Peer[][] = []
    for (let promise of promises) {
        peerlists.push(promise.response)
    }
    // Pushing our peerlist to the peerlists
    peerlists.push(peers)
    log.custom(
        "peerGossip",
        "Pushed our peerlist into the peerlists to merge",
        false,
    )
    // Merging the peerlists
    log.custom("peerGossip", "Merging peerlists", false)
    await mergePeerlists(peerlists)
    log.custom("peerGossip", "Peerlists merged", false)
    // Reentry prevention
    getSharedState.inPeerGossip = false
    log.custom("peerGossip", "Peer gossip finished", true)
    return
}

// Merging given peerlists into an ordered unique peerlist
async function mergePeerlists(peerlists: Peer[][]): Promise<boolean> {
    let mergedPeerlist: Peer[] = []
    for (let peerlist of peerlists) {
        for (let peer of peerlist) {
            if (!mergedPeerlist.includes(peer)) {
                mergedPeerlist.push(peer)
            }
        }
    }
    // Reordering the merged peerlist
    mergedPeerlist.sort((a, b) => a.identity.localeCompare(b.identity))
    // Updating the peer manager
    PeerManager.getInstance().setPeers(mergedPeerlist)
    return true
}
