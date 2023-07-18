import { Server as ServerType } from "socket.io"
import { logger } from "../utils"
import { PeerManager, Peer } from "../peer"
import { Identity } from "../identity"
import ServerListeners from "./serverListeners"

const identity = Identity.getInstance()

export default class Server {
    static setupListeners = async function (server: ServerType) {
        server.on("connection", async peerSocket => {
            logger.log("[SERVER] Peer connected")

            const newPeer = new Peer()
            newPeer.setSocket(peerSocket)
            newPeer.setIdentity(identity.ed25519.publicKey)
            PeerManager.getInstance().addPeer(newPeer)
            const serverListeners = new ServerListeners(newPeer)
            serverListeners.runListeners()
        })
    }
}
