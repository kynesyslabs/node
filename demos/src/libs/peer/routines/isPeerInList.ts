import PeerManager from '../PeerManager'
import Peer from "../Peer"

// INFO Checking if a peer is already in the peerlist
export default function isPeerInList(peer: Peer) {
	const peerList = PeerManager.getInstance().getPeers()
	let identity = peer.identity
	for (let i = 0; i < peerList.length; i++) {
		if (peerList[i].identity === identity) {
            return true
        }
	}
	return false
}
