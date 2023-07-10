import Chain from "../chain"
import PeerManager from "../../peer/PeerManager"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import { responseRegistry } from "../../communications"
import forge, { pki } from "node-forge"
import * as fs from "fs"

const peerManager = PeerManager.getInstance()

// NOTE Sleep function
async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

export default async function Sync(id: any) {
    // TODO Give the type
    // TODO Implement all the ComLink and responseRegistry mechanism in a standalone function
    let synced = true
    console.log("[SYNC] Our data: fetched")
    let _currentLastBlockNumber = await Chain.getLastBlockNumber()
    let _currentLastBlockHash = await Chain.getLastBlockHash()

    console.log("[SYNC] Fetching data from peers")
    let peerlist = peerManager.getPeers()
    // Asking to all the peers for the last block
    for (let i = 0; i < peerlist.length; i++) {
        // Creating a comlink object
        let _comlink = new ComLink()
        let _currentPeer = peerlist[i]
        // Generate the message to ask for the last block
        let _blockAskMessage = new Transmission(id.ed25519.privateKey)
        _blockAskMessage.initialize(
            "nodeCall",
            "getLastBlockNumber",
            id.ed25519.publicKey,
            _currentPeer,
            null,
            null,
        )
        // Hash and sign it
        await _blockAskMessage.finalize()
        // Putting the message into the comlink
        console.log(
            "[SYNC] Asking " + _currentPeer.socket.id + " for the last block",
        )
        // Preparing for a response
        _comlink.properties.require_reply = true
        _comlink.properties.is_reply = false
        // Propagating the responseRegistry actual status

        responseRegistry.getInstance().requestResponse(_comlink) // TODO Do a singleton here too

        // Ask for the last block
        await _comlink.broadcastMessageToPeer(
            _currentPeer,
            _blockAskMessage, // TODO DELETE sensitivde info here
            id.ed25519.privateKey,
        )
        /* REVIEW
         * We should use responseRegistry.hasResponse(_comlink) to check periodically if the response is received
         * Or look into communications.js ResponseRegistry for a TODO that explains how to do this in a more elegant way
         * In any case, here we should wait until the response is received
         */
        let timeout_limit = 2000
        let timeout_counter = 0
        while (!responseRegistry.getInstance().hasResponse(_comlink)) {
            await sleep(100)
            timeout_counter += 100
            if (timeout_counter > timeout_limit) {
                console.log(
                    "[SYNC] Timeout limit reached: no response received",
                )
                return false // TODO Manage it
            }
        }
        // REVIEW Ensure the above works
        // LINK https://stackoverflow.com/questions/23893872/how-to-properly-remove-event-listeners-in-node-js-eventemitter
        // The above link will be used to remove the listeners once the response is received, will be applied to keep clean the peers connections too
    }
    return synced
}
