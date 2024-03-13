/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Peer from "../Peer"
import PeerManager from "../PeerManager"

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
