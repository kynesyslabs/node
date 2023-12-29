/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Server as ServerType } from "socket.io"
import { Peer } from "../peer"
import ServerListeners from "./serverListeners"

import terminalkit from "terminal-kit"
var term = terminalkit.terminal

export default class Server {
    static setupListeners = async function (server: ServerType) {
        server.on("connection", async peerSocket => {
            term.green("[SERVER] Peer connected\n")

            const newPeer = new Peer()
            newPeer.setSocket(peerSocket)
            //newPeer.setIdentity(identity.ed25519.publicKey)
            //PeerManager.getInstance().addPeer(newPeer)
            const serverListeners = new ServerListeners(newPeer)
            serverListeners.runListeners()
        })
    }
}
