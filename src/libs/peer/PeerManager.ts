/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Peer from "./Peer"
import log from "src/utilities/logger"
import Transmission from "../communications/transmission"
import Cryptography from "../crypto/cryptography"
import Hashing from "../crypto/hashing"
import sharedState from "src/utilities/sharedState"
import forge from "node-forge"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { method } from "lodash"
import { HelloPeerRequest } from "../network/manageHelloPeer"
import fs from "fs"

function ForgeToHex(forgeBuffer: any) {
    console.log("[forge to string encoded]")
    //console.log(forgeBuffer)
    let rebuffer = Buffer.from(forgeBuffer)
    forgeBuffer = rebuffer.toString("hex")
    console.log("DECODED INTO:")
    console.log("0x" + forgeBuffer)
    return "0x" + forgeBuffer
}

export default class PeerManager {
    private static instance: PeerManager
    private peerList: Record<string, Peer> // Storing all the connections, will be filtered once the request is done
    private offlinePeers: Record<string, Peer> // Storing all the offline peers to be retried later

    private constructor() {
        this.peerList = {}
        this.offlinePeers = {}
    }

    static getInstance(): PeerManager {
        if (!this.instance) {
            this.instance = new PeerManager()
        }
        return this.instance
    }

    // Loading the peer list from the demos_peer.json
    loadPeerList() {
        let rawPeerList = fs.readFileSync(
            sharedState.getInstance().peerListFile,
            "utf8",
        )
        let peerList = JSON.parse(rawPeerList)
        // Creating a peer object for each peer in the peer list, assigning the connection string and adding it to the peer list
        for (const peer in peerList) {
            let peerObject = this.createNewPeer(peer)
            peerObject.connection.string = peerList[peer]
            this.addPeer(peerObject)
        }
    }

    // Fetching peer info from /info endpoint
    async fetchPeerInfo(peer: Peer) {
        const info = await peer.fetch("info")
    }

    createNewPeer(identity: string): Peer {
        const peer = new Peer()
        peer.identity = identity
        peer.connection.string = ""
        return peer
    }

    getPeers(): Peer[] {
        return this._getActors(true, false)
    }


    getAll(): Peer[] {
        return this._getActors(true, true)
    }

    getOfflinePeers(): Record<string, Peer> {
        return this.offlinePeers
    }

    private _getActors(peers: boolean, connections: boolean): Peer[] {
        console.log("[PeerManager] Getting all peers...")
        console.log("[PeerManager] peers: " + peers)
        console.log("[PeerManager] connections: " + connections)
        const actorList: Peer[] = []
        const connectedList: Peer[] = []
        const authenticatedList: Peer[] = []
        //console.log(this.peerList)
        for (const peer in this.peerList) {
            console.log("[PeerManager] Getting peer " + peer)
            let _peer = this.peerList[peer]
            console.log("[PeerManager] With url: " + _peer.connection.string)
            // Filtering
            if (_peer.identity != undefined) {
                console.log(
                    "[PEERMANAGER] This peer has an identity: treating it as an authenticated peer",
                )
                authenticatedList.push(_peer)
            } else {
                console.log(
                    "[PEERMANAGER] This peer has no identity: treating it as a connection only peer",
                )
                connectedList.push(_peer)
            }
        }
        // Merging and returning
        if (peers) {
            actorList.push(...authenticatedList)
        }
        if (connections) {
            actorList.push(...connectedList)
        }
        console.log(
            "[PEERMANAGER] Retrieved and filtered actor list length: " +
                actorList.length,
        )
        return actorList
    }

    // Creating a JSON object with the peerlist and logging it
    logPeerList() {
        const json_peerlist = {}
        for (const peer in this.peerList) {
            json_peerlist[peer] = {
                connection_string: this.peerList[peer].connection.string,
                identity: this.peerList[peer].identity,
                is_authenticated: this.peerList[peer].verification.status,
            }
        }
        // Flushing the log file and logging the peerlist
        log.custom(
            "peer_list",
            JSON.stringify(json_peerlist, null, 2),
            false,
            true,
        )
    }

    async getOnlinePeers(): Promise<Peer[]> {
        //const onlinePeers: Peer[] = []
        for await (const _peer of Object.values(this.peerList)) {
            const peerInstance = new Peer()
            peerInstance.identity = _peer.identity
            peerInstance.connection.string = _peer.connection.string
            console.log(
                "[PEERMANAGER] Checking online status of peer " +
                    peerInstance.identity,
            )
            await PeerManager.sayHelloToPeer(peerInstance)
        }
        // Returning the list of online peers from the peerlist
        return this.getPeers() // REVIEW is this working?
    }

    addPeer(peer: Peer) {
        console.log("[PEERMANAGER] Adding peer")
        if (peer.identity === "placeholder") {
            console.log("[WARN] No identity detected: refusing to add peer")
            console.log(peer)
            return false
        }
        // REVIEW check for duplicates
        const identity = peer.identity
        let action = "added"
        if (this.peerList[identity]) {
            console.log("[PEERMANAGER] Peer already exists: updating it")
            action = "updated"
        }
        this.peerList[identity] = peer
        console.log("[PEERMANAGER] Peer " + action)
        console.log("Identity: " + peer.identity)
        console.log("Connection string: " + peer.connection.string)
        if (!peer.connection.string) {
            console.log("[WARN] No connection string detected")
        }
        return true
    }

    addOfflinePeer(peerInstance: Peer) {
        console.log(
            "[PEERMANAGER] Adding offline peer " +
                peerInstance.connection.string,
        )
        if (this.offlinePeers[peerInstance.identity]) {
            this.offlinePeers[peerInstance.identity] = peerInstance
        }
        console.log("[PEERMANAGER] Offline peers: " + this.offlinePeers)
    }

    removeOfflinePeer(identity: string) {
        delete this.offlinePeers[identity]
    }

    // REVIEW This method should be tested and finalized with the new peer structure
    static async sayHelloToPeer(peer: Peer) {
        sharedState.getInstance().peerRoutineRunning += 1 // Adding one to the peer routine running counter

        // TODO test and finalize this method
        log.info("[Hello Peer] Saying hello to peer " + peer.identity)
        const our_id = sharedState.getInstance().identity.ed25519.publicKey
        let connection_string = sharedState.getInstance().connectionString // ? Are we sure about this
        let signed_connection_string = Cryptography.sign(
            connection_string,
            sharedState.getInstance().identity.ed25519.privateKey,
        )
        log.info("[Hello Peer] Signing connection string: " + connection_string)
        log.info(
            "[Hello Peer] Signed connection string: " +
                ForgeToHex(signed_connection_string),
        )
        // Sending the transmission to the peer
        const hello_request: HelloPeerRequest = {
            url: connection_string,
            publicKey: our_id.toString("hex"),
        }
        // Not awaiting the response to not block the main thread
        peer.call({
            method: "hello_peer",
            params: [hello_request],
        }).then(response => {
            PeerManager.helloPeerCallback(response, peer)
        })
        console.log("[Hello Peer] Hello request sent: waiting for response")
    }

    // Callback for the hello peer
    static helloPeerCallback(response: RPCResponse, peer: Peer) {
        log.info("[Hello Peer] Response received from peer: " + peer.identity)
        //console.log(response) // ? Delete this if not needed
        // TODO Test and Finish this
        // REVIEW is the message the response itself?
        log.info("[Hello Peer] Response message: " + response.response)
        // Based on the response, we can decide what to do
        if (response.result === 200) {
            log.info(
                "[Hello Peer] Peer is online, replied and recognized us. Adding to peer list",
            )
            //console.log(peer)
            PeerManager.getInstance().addPeer(peer)
        } else {
            log.info(
                "[Hello Peer] Failed to connect to peer: " +
                    peer.identity +
                    ". Adding to offline list",
            )
            // Add the peer to the offline list
            PeerManager.getInstance().addOfflinePeer(peer)
        }
        sharedState.getInstance().peerRoutineRunning -= 1 // Subtracting one from the peer routine running counter
        //process.exit(0)
    }
}
