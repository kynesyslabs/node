/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Chain from "../chain"
import PeerManager from "../../peer/PeerManager"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import Peer from "../../peer/Peer"

const peerManager = PeerManager.getInstance()
import { Response } from "../../communications/types/responseregistry"
import ResponseRegistry from "src/libs/communications/responseRegistry"

async function sleep(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time))
}

// INFO Syncing with the network
export default async function Sync(id: any) {
    // TODO Give the type
    // TODO Implement all the ComLink and responseRegistry mechanism in a standalone function
    let synced = true

    // NOTE Reading our data
    console.log("[SYNC] Our data: fetched")
    let _currentLastBlockNumber = await Chain.getLastBlockNumber()
    _currentLastBlockNumber = _currentLastBlockNumber.number
    console.log("[SYNC] Our data: last block number: ")
    console.log(_currentLastBlockNumber)
    let _currentLastBlockHash = await Chain.getLastBlockHash()
    _currentLastBlockHash = _currentLastBlockHash.hash
    console.log("[SYNC] Our data: last block hash: ")
    console.log(_currentLastBlockHash)
    console.log("\n============================\n\n")
    //await sleep(1000)

    console.log("[SYNC] Fetching data from peers")
    let peerlist = peerManager.getPeers()
    // console.log(peerlist)

    // NOTE This array contains all the responses promises and is filled step by step
    let responses: Promise<[boolean, Response]>[] = []

    // Asking to all the peers for the last block
    for (let i = 0; i < peerlist.length; i++) {
        // Creating a comlink object
        let _comlink = new ComLink()
        let _currentPeer = peerlist[i]
        // Generate the message to ask for the last block
        // logger.warn("id.ed25519.privateKey")
        // logger.warn(typeof id.ed25519.privateKey)
        // logger.warn(JSON.stringify(id.ed25519.privateKey))
        let _blockAskMessage = new Transmission(id.ed25519.privateKey)
        _blockAskMessage.initialize(
            "nodeCall",
            "getLastBlockNumber",
            id.ed25519.publicKey,
            _currentPeer.identity,
            null,
            null,
        )
        // Hash and sign it
        await _blockAskMessage.finalize()
        // Putting the message into the comlink
        console.log(
            "[SYNC] Asking " + _currentPeer.socket.id + " for the last block at " + _currentPeer.connectionString,
        )
        // Preparing for a response
        _comlink.properties.require_reply = true
        _comlink.properties.is_reply = false
        // Propagating the responseRegistry actual status

        ResponseRegistry.getInstance().requestResponse(_comlink)

        // Ask for the last block
        await _comlink.broadcastMessageToPeer(
            _currentPeer,
            _blockAskMessage,
            id.ed25519.privateKey,
        )

        // Add the response promise to the responses array
        let promise = ResponseRegistry
            .getInstance().checkResponse(_comlink.muid)
        responses.push(promise)

        // LINK https://stackoverflow.com/questions/23893872/how-to-properly-remove-event-listeners-in-node-js-eventemitter
        // The above link will be used to remove the listeners once the response is received, will be applied to keep clean the peers connections too
    }

    /* NOTE
     * Using the following code, we are waiting for all the responses to be received without blocking for each one
     * This is used to avoid returning to the main thread before each node has replied or timed out, but allows
     * sending the same message to a lot of nodes without blocking and just waiting for the responses to be received at the end.
     */
    console.log("[SYNC] Waiting for the responses")
    // Waiting all the responses
    let results = await Promise.all(responses)
    console.log("[SYNC] All responses received")
    //console.log(results)

    // Preparing a list of nodes which aren't in sync with us
    let unsyncedNodes = {} // TODO typize it

    // Ingesting the valid responses
    let _block_numbers = {}
    for (let i = 0; i < results.length; i++) {
        let _result = results[i]
        if (!_result[0]) {
            console.log("[SYNC] Response " + i + " not received")
        } else {
            console.log("[SYNC] Response " + i + " received")
            let peer_identity = _result[1].identity
            _block_numbers[peer_identity.toString("hex")] = {
                socket: _result[1].socket,
                connection_string: _result[1].connection_string,
                block_number: JSON.parse(_result[1].message).number,
                timestamp: _result[1].timestamp,
                peer: peer_identity,
            }
            console.log(
                "[SYNC FETCHED] Peer " +
                    peer_identity.toString("hex") +
                    " has the block number " +
                    _block_numbers[peer_identity.toString("hex")].block_number +
                    " at timestamp " +
                    _block_numbers[peer_identity.toString("hex")].timestamp,
            )
            // NOTE Checking for synchronization
            if (_block_numbers[peer_identity.toString("hex")].block_number != _currentLastBlockNumber) {
                // Not in sync peer
                unsyncedNodes[peer_identity.toString("hex")] = {
                    block_number: _block_numbers[peer_identity.toString("hex")].block_number,
                    timestamp: _block_numbers[peer_identity.toString("hex")].timestamp,
                    full_identity: peer_identity,
                    connection_string: _block_numbers[peer_identity.toString("hex")].connection_string,
                }
            }
        }
    }

    // NOTE Checking if we are in sync with the network
    if (Object.keys(unsyncedNodes).length == 0) {
        console.log("[SYNC] We are in sync with the network")
        synced = true
    } else {
        console.log("[SYNC] We are not in sync with the network by: " + Object.keys(unsyncedNodes).length + " peers")
        synced = false
        // REVIEW Each unsynced node mapped will be queried
        let unsyncedNodesNames = Object.keys(unsyncedNodes)
        for (let i = 0; i < unsyncedNodesNames.length; i++) {
            let name = unsyncedNodesNames[i]
            console.log("[SYNC] Asking " + name + " for the last block")
            let node = unsyncedNodes[name]
            console.log("[SYNC] Retrieving info...")
            let connection_string = node.connection_string
            console.log("[SYNC] Connection string: " + connection_string)
            // TODO Check if the block is forward or backward
            // TODO If forward, ask for the block
            // TODO Continue the sync process
        }
    }

    return synced
}
