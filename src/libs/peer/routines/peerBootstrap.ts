/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { cryptography } from "src/libs/crypto"

import Client from "../../network/client"
import Peer from "../Peer"
import PeerManager from "../PeerManager"
import getPeerIdentity from "./getPeerIdentity"
import log from "src/utilities/logger"

const peerManager = PeerManager.getInstance()

export default async function peerBootstrap(
    local_list: string[],
): Promise<Peer[]> {
    const id_ed25519 = await cryptography.load("./.demos_identity")
    console.log("[PEER BOOTSTRAP] Loading peers...")
    // Validity check
    for (let i = 0; i < local_list.length; i++) {
        console.log("[PEER BOOTSTRAP] Checking peer " + local_list[i])
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
        // REVIEW Connection test and add to valid_peers
        // Trying to connect and retrieve the socket for the given peer using Peer class
        let _currentTestingPeer: Peer = PeerManager.extractPeerFromString(_currentPeerURL)
        // TODO See PeerManager.extractPeerFromString and Client.connectToPeer comments
        let _currentPeerObject = await Client.connectToPeer(
            currentPeerAddress,
            currentPeerPort,
        ) // Returns the Peer object
        if (_currentPeerObject) {
            console.log("[BOOTSTRAP] _currentPeerObject has a socket id: " + _currentPeerObject.connection.socket.id)
            // Adding identity if any
            console.log(
                "[BOOTSTRAP] Testing " + currentPeerAddress + " identity",
            )

            _currentPeerObject = await getPeerIdentity(
                _currentPeerObject,
                id_ed25519,
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
                process.exit(1)
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

            /*if (containsPeer(_currentPeerObject, peerlist)) { // FIXME Disabled as was not working. Should be fixed
				term.yellow("[BOOTSTRAP] WARNING: Duplicate peer " + currentPeerAddress + ":" + currentPeerPort + "\n")
			} else */
            console.warn("[PEERBOOTSTRAP] Adding peer to peerlist")
            //console.warn(_currentPeerObject)
            if (_currentPeerObject.connection.socket.connected) {
                let inserted =
                    PeerManager.getInstance().addPeer(_currentPeerObject)
                if (!inserted) {
                    console.log(
                        "[PEERBOOTSTRAP] Could not add peer to peerlist (see above)",
                    )
                    log.info("[PEERBOOTSTRAP] Could not add peer to peerlist (see error)")
                    // peerlist.push(_currentPeerObject)
                }
            }
            else {
                    console.log(
                        "[PEERBOOTSTRAP] Refusing to add peer " +
                            currentPeerAddress +
                            " as it is not connected",
                    )
                    log.info("[PEERBOOTSTRAP] Refusing to add peer " + currentPeerAddress + " as it is not connected")
                    // Adding the peer string to the list of offline peers so it can be tried later
                    PeerManager.getInstance().addOfflinePeer(_currentPeerURL)
            }
        } else {
            console.log(
                "[BOOTSTRAP] ERROR: Cannot connect to peer: " +
                    currentPeerAddress +
                    ":" +
                    currentPeerPort +
                    " (will retry) \n",
            )
            log.info("[BOOTSTRAP] ERROR: Cannot connect to peer: " + currentPeerAddress + ":" + currentPeerPort + " (will retry) \n")
            // Adding the peer string to the list of offline peers so it can be tried later
            PeerManager.getInstance().addOfflinePeer(_currentPeerURL)
        }
    }
    // Dying if there are no valid peers
    if (peerManager.getPeers().length == 0) {
        // Exit if there are no valid peers
        console.log("No valid peers found, listening for connections...")
    }
    return peerManager.getPeers()
}
