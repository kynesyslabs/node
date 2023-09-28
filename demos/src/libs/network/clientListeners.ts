/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { PeerManager } from "../peer"
var term = require("terminal-kit").terminal

export default class ClientListeners {
    private peer: any

    constructor(peer: any) {
        this.peer = peer
    }

    public async runListeners() {
        await this.connectListener()
    }

    private connectListener = async () => {
        this.peer.socket.on("connect", async (connected_socket) => {
            term.green("[CLIENT] Connected to peer\n")
            PeerManager.getInstance().addPeer(this.peer)
        })
    }
}
