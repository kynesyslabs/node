import PeerManager from "../PeerManager"
import Client from "../../network/client"
import getPeerIdentity from "./getPeerIdentity"
import { cryptography } from "src/libs/crypto"

const peerManager = PeerManager.getInstance()

export default async function peerBootstrap(local_list: string[]) {
    const id_ed25519 = await cryptography.load("./.demos_identity")
    let peerlist = peerManager.getPeers()

    // Validity check
    for (let i = 0; i < local_list.length; i++) {
        let _currentPeerURL = local_list[i] // The url of the peer
        // If there is a : in the url, we assume it's a address + port
        let currentPeerAddress
        let currentPeerPort
        if (_currentPeerURL.includes(">")) {
            currentPeerAddress = _currentPeerURL.split(">")[0]
            currentPeerPort = _currentPeerURL.split(">")[1]
        } else {
            currentPeerAddress = _currentPeerURL
            currentPeerPort = 53550
        }
        console.log(
            "[BOOTSTRAP] Testing " + currentPeerAddress + ":" + currentPeerPort,
        )
        // REVIEW Connection test and add to valid_peers
        // Trying to connect and retrieve the socket for the given peer using Peer class
        let _currentPeerObject = await Client.connectToPeer(
            currentPeerAddress,
            currentPeerPort,
        ) // Returns the Peer object 
        if (_currentPeerObject) { 
            // Adding identity if any
            console.log("[BOOTSTRAP] Testing " + currentPeerAddress + " identity")
            _currentPeerObject = await getPeerIdentity(_currentPeerObject, id_ed25519)
            console.log(
                "[BOOTSTRAP] OK: Valid peer " +
                    currentPeerAddress +
                    ":" +
                    currentPeerPort +
                    "\n",
            )
            /*if (containsPeer(_currentPeerObject, peerlist)) { // FIXME Disabled as was not working. Should be fixed
				term.yellow("[BOOTSTRAP] WARNING: Duplicate peer " + currentPeerAddress + ":" + currentPeerPort + "\n")
			} else */ peerlist.push(_currentPeerObject)
        } else {
            console.log(
                "[BOOTSTRAP] ERROR: Invalid peer " +
                    currentPeerAddress +
                    ":" +
                    currentPeerPort +
                    "\n",
            )
        }
        // Nice printing of the peerlist
        for (let i = 0; i < peerlist.length; i++) {
            console.log(peerlist[i].identity.toString("hex"))
        }
    }
    // Dying if there are no valid peers
    if (peerlist.length == 0) {
        // Exit if there are no valid peers
        console.log("No valid peers found, exiting")
        // eslint-disable-next-line no-undef
        process.exit(-3)
    }
    return peerlist
}
