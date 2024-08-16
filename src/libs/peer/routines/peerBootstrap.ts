/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { cryptography } from "src/libs/crypto"

import Peer from "../Peer"
import PeerManager from "../PeerManager"
import getPeerIdentity from "./getPeerIdentity"
import log from "src/utilities/logger"

const peerManager = PeerManager.getInstance()

// Proxy function to call peerBootstrap in a nicer way
export async function peerlistCheck(local_list: string[]): Promise<Peer[]> {
    return await peerBootstrap(local_list)
}

// ANCHOR Main function
export default async function peerBootstrap(
    local_list: string[],
): Promise<Peer[]> {
    console.log("[PEER BOOTSTRAP] Loading peers...")
    // Validity check
    for (let i = 0; i < local_list.length; i++) {
        console.log("[PEER BOOTSTRAP] Checking peer " + local_list[i])
        // ANCHOR Extract peer info from the string
        let _currentPeerURL = local_list[i] // The url of the peer
        // If there is a : in the url, we assume it's a address + port
        let currentPeerAddress: string
        let currentPeerPort: number
        let currentPublicKey: string
        if (_currentPeerURL.includes(">")) {
            currentPeerAddress = _currentPeerURL.split(">")[0]
            currentPeerPort = parseInt(_currentPeerURL.split(">")[1])
            currentPublicKey = _currentPeerURL.split(">")[2]
        } else {
            currentPeerAddress = _currentPeerURL
            currentPeerPort = 53550
        }
        console.log(
            "[BOOTSTRAP] Testing " +
                currentPeerAddress +
                ":" +
                currentPeerPort +
                ":" +
                currentPublicKey,
        ) 
        // ANCHOR Connection test and hello_peer routine
        let _currentPeerObject: Peer = new Peer(currentPeerAddress, currentPeerPort, currentPublicKey)
        if (_currentPeerObject) {
            // Adding identity if any
            console.log(
                "[BOOTSTRAP] Testing " + currentPeerAddress + " identity",
            )
            // After this, the peer object will have an identity and thus will be verified
            _currentPeerObject = await getPeerIdentity(
                _currentPeerObject,
                currentPublicKey,
            )
            console.log(
                "[BOOSTRAP: overriding connectionstring] " + _currentPeerURL,
            )
            console.log(_currentPeerObject)
            // ! remove debug code
            try {
                _currentPeerObject.connection.string = _currentPeerURL // Adding this step
            } catch (error) {
                console.log("[PEERBOOTSTRAP] Error setting connection string: " + error)
                log.critical("Error setting connection string: " + error)
                continue
            }
            console.log(
                "[BOOTSTRAP] OK: Valid peer " +
                    currentPeerAddress +
                    ":" +
                    currentPeerPort +
                    "\n",
            )
            log.info("[BOOTSTRAP] OK: Valid peer " + currentPeerAddress + ":" + currentPeerPort + "\n")

            console.log("[BOOTSTRAP] _currentPeerObject", _currentPeerObject)
            // This should automatically add the peer to the peer list or the offline list
            let response =await _currentPeerObject.call({
                method: "hello_peer",
                params: [{
                    url: currentPeerAddress,
                    port: currentPeerPort,
                    publicKey: currentPublicKey,
                }],
            })
            console.log("[BOOTSTRAP] Response: " + JSON.stringify(response, null, 2))
        } 
    }
    // Dying if there are no valid peers
    if (peerManager.getPeers().length == 0) {
        // Exit if there are no valid peers
        console.log("No valid peers found, listening for connections...")
    } else {
        console.log("Valid peers found: " + peerManager.getPeers().length)
    }
    return peerManager.getPeers()
}
