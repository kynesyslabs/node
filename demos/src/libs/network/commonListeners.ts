import { PeerManager } from "../peer"
import { Identity } from "../identity"
import { responseRegistry } from "../communications"
import { comlinkUtils } from "../communications"
import { logger } from "../utils"
import { cryptography } from "../crypto"

export default class CommonListeners {
    private peer: any

    constructor(peer: any) {
        this.peer = peer
    }

    public async runListeners() {
        await this.disconnectListener()
        await this.authAskListener()
        await this.publicListener()
        await this.comlinkReplyListener()
        await this.errorListener()
    }

    private disconnectListener = async () => {
        this.peer.socket.on("disconnect", async () => {
            logger.log("user disconnected")
            // Removing the peer from the list if it was in
            logger.log("[SERVER] Peer disconnected")
            PeerManager.getInstance().removePeer(this.peer)
        })
    }

    private authAskListener = async () => {
        this.peer.socket.on("auth_ask", async (data: { message: string }) => {
            console.log(data)
            // REVIEW Signing data.message with the private key
            let _signature = cryptography.sign(
                data.message,
                Identity.getInstance().ed25519.privateKey as any,
            )
            // REVIEW Sending the signature back along with the public key and the message
            let _sendBack = [
                data.message,
                _signature,
                Identity.getInstance().ed25519.publicKey,
            ]
            this.peer.socket.emit("auth_reply", _sendBack)
        })
    }

    private publicListener = () => {
        this.peer.socket.on("public", request => {
            console.log("[PEER] Received")
            console.log(request)
        })
    }

    private comlinkReplyListener = async () => {
        this.peer.socket.on("comlink_reply", async request => {
            // request is a ComLink object with the same structure as the comlink listener below
            console.log("[PEER] Received reply to " + request.muid)
            //console.log(JSON.stringify(request, null, 2))
            // REVIEW Check if the responseRegistry contains the muid of the request
            const responseRegistryList = responseRegistry.getInstance().list
            //console.log(_responseRegistry)
            const response = responseRegistryList[request.muid]
            if (!response) {
                console.log("[PEER] No response expected for " + request.muid)
                return
            } else {
                console.log(
                    "[PEER] Received expected response for " + request.muid,
                )
                // TODO Continue with the response logic (as per filling comlink if needed and verifications and so on)
            }
            console.log(request)
            // Parsing the comlink
            let parsed_comlink = await comlinkUtils.parseComlink(
                request,
                this.peer.socket,
            ) // FIXME Cant parse responses
            if (!parsed_comlink) return
            let _comlink_request = parsed_comlink[0]
            let content = parsed_comlink[1]
        })
    }

    private errorListener = async () => {
        this.peer.socket.on("error", async request => {
            console.log("[PEER] Received error:")
            console.log(request)
        })
    }
}
