/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import terminalkit from "terminal-kit"

import { PeerManager } from "../peer"
import { Peer } from "../peer"

const term = terminalkit.terminal

export default class ClientListeners {
    private peer: Peer

    constructor(peer: Peer) {
        this.peer = peer
    }

    public async runListeners() {
        await this.connectListener()
    }

    private connectListener = async () => {
        this.peer.connection.socket.on("connect", async () => {
            term.green("[CLIENT] Connected to peer\n")
            PeerManager.getInstance().addPeer(this.peer)
        })
    }
}
