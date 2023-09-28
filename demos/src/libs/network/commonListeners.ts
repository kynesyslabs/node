/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { PeerManager } from "../peer"
import { Identity } from "../identity"
import { cryptography } from "../crypto"
import ComLinkUtils from "../communications/comlinkUtils"
import ResponseRegistry from "../communications/responseRegistry"
import getRemoteIP from "../network/routines/getRemoteIP"
import sharedState from "src/utilities/sharedState"
var term = require("terminal-kit").terminal

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
            // Removing the peer from the list if it was in
            term.yellow("[COMMON] Peer disconnected")
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

    
    // INFO For non sensitive data
    private publicListener = async () => {
        this.peer.socket.on("public", request => async () => {
            console.log("[PEER] Received")
            let response = {
                muid: request.muid,
                data: null,
            }
            console.log(request.cmd) // TODO Create a type for the request format
            if (request === "public_ip") {
                let ip = await Identity.getInstance().getPublicIP()
                response.data = ip
            }
            // else if
            else {
                response.data = "Unknown command: " + request.cmd
            }
            // Once the response should be processed, we need to send it back
            // TODO Would be better to have requests with is_reply set to true or false instead of two listeners
            this.peer.socket.emit("public_reply", response)
        })
    }

    private comlinkReplyListener = async () => {
        this.peer.socket.on("comlink_reply", async request => {
            // request is a ComLink object with the same structure as the comlink listener below
            console.log("[PEER] Received reply to " + request.muid)
            //console.log(JSON.stringify(request, null, 2))
            // REVIEW Check if the responseRegistry contains the muid of the request
            const response = ResponseRegistry.getInstance().hasResponse(request.muid)
            if (!response) {
                console.log("[PEER] No response expected for " + request.muid)
                return
            } else {
                console.log(
                    "[PEER] Received expected response for " + request.muid,
                )
            }
            //console.log(request)
            // Parsing the comlink
            let parsed_comlink = await ComLinkUtils.parseComlink(
                request,
                this.peer.socket,
            ) 
            if (!parsed_comlink) {
                return
            }
            let _comlink_request = parsed_comlink[0]
            let content = parsed_comlink[1]
            // Registering the response
            let connection_string: string = await getRemoteIP()
            connection_string = "http://" + connection_string + ":" + sharedState.getInstance().serverPort
            ResponseRegistry.getInstance().registerResponse(request.chain.current.currentMessage, request.muid, this.peer.socket, connection_string)
        })
    }

    private errorListener = async () => {
        this.peer.socket.on("error", async request => {
            console.log("[PEER] Received error:")
            console.log(request)
        })
    }
}
