import { PeerManager } from "../peer"
import { logger } from "../utils"

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
            logger.log("[CLIENT] Connected to peer")
            PeerManager.getInstance().addPeer(this.peer)
        })
    }
}
