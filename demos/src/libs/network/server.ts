import { Server as ServerType } from "socket.io"
import { logger } from "../utils"
import { PeerManager, Peer } from "../peer"
import { Identity } from "../identity"

const identity = Identity.getInstance()

export default class Server {
    static setupListeners = async function (server: ServerType) {
        server.on("connection", async peerSocket => {
            logger.log("[SERVER] Peer connected")

            const newPeer = new Peer()
            this.addPeer(newPeer, peerSocket)
        })
    }

    static addPeer = function (peer: Peer, peerSocket) {
        peer.setSocket(peerSocket)
        peer.setIdentity(identity.ed25519)
        PeerManager.getInstance().addPeer(peer)
    }
}
