/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* eslint-disable no-extra-semi */
import ServerHandlers from "src/libs/network/serverHandlers"
import { cryptography } from "src/libs/crypto"
import { Peer } from "src/libs/peer"
import { comlinkUtils } from "src/libs/communications"
import { logger } from "src/libs/utils"
import { Identity } from "src/libs/identity"
import Transmission from "src/libs/communications/transmission"

export default class ServerListeners {
    peer: Peer

    constructor(peer: Peer) {
        this.peer = peer
    }

    async runListeners() {
        // await this.authReplyListener()
        // await this.authAskEmit()
        await this.comlinkListener()
    }

    async comlinkListener() {
        this.peer.socket.on("comlink", async request => {
            logger.log("[SERVER] Received comlink")
            const id_ed25519 = await cryptography.load("./.demos_identity")
            const receiver = this.peer.socket

            // Parsing comlink
            const parsed_comlink = await comlinkUtils.parseComlink(
                request,
                this.peer.socket,
            )
            if (!parsed_comlink) return

            let _comlink_request = parsed_comlink[0]
            let content = parsed_comlink[1]

            let extra: any, require_reply: any, response: any

            switch (content.type) {
                case "tx":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleTransaction(content))
                    break

                case "crosschain_operation":
                case "multichain_operation":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleXMChainOperation(content))
                    break

                case "crosschain_status":
                case "multichain_status":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleXMChainStatus())
                    break

                case "validate_web2":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleValidateWeb2(content))
                    break

                case "web2Request":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleWeb2Request(
                            request,
                            content,
                        ))
                    break

                case "consensus":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleConsensusRequest(content))
                    break

                case "messages":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleMessage(content))
                    break

                case "storage":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleStorage(content))
                    break

                case "mempool":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleMempool(content))
                    break

                case "nodeCall":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleNodeAPI(
                            content,
                            receiver,
                            id_ed25519,
                        ))
                    break

                default:
                    logger.log(
                        `[COMLINK INVALID] No known type: ${content.type}`,
                    )
                    break
            }

            logger.log("content.type: " + content.type)
            logger.log("content.message: " + content.message)
            logger.log("content.message.action: " + content.message.action)

            // ANCHOR Reply logic
            // REVIEW unless specified, we now send back the updated comlink as a response
            // Building a message to send back in the comlink

            var response_message = new Transmission(
                Identity.getInstance().ed25519.privateKey,
            )
            response_message.initialize(
                // TODO Specify the answer so that it has a type AND a message
                "reply",
                JSON.stringify(response),
                id_ed25519.publicKey,
                "placeholder", // TODO Add the receiver, don't we already have it in the receiver object?
                null,
                extra,
            )
            await response_message.finalize()
            // Populating the comlink
            _comlink_request.properties.is_reply = true // Setting the reply flag as we are replying
            _comlink_request.properties.require_reply = require_reply // Setting the require_reply flag as provided above
            await _comlink_request.replyToMessage(
                response_message,
                id_ed25519.privateKey,
            )
            // Sending back the response
            console.log("[SERVER] Sending back comlink")
            //console.log(JSON.stringify(_comlink_request))
            receiver.emit("comlink_reply", _comlink_request) // reply is managed in the common listeners
        })
        // TODO See in communications.js and find the best way to validate, check and digest the request
    }

    // INFO Register or update a peer identity and connection string
    async authReplyListener() {
        // FIXME Auth reply listener should not add a client to the peerlist if is read only
        this.peer.socket.on("auth_reply", async data => {
            let identity = await cryptography.load("./.demos_identity")
            logger.log("[SERVER] Received auth reply")
            if (!(data === "readonly")) {
                // REVIEW Verify the signature with the public key on the message
                let _verification = await cryptography.verify(
                    data[0],
                    data[1],
                    data[2],
                )
                // Disconnect if the verification is false
                if (!_verification) {
                    this.peer.socket.emit("auth_fail")
                    this.peer.socket.disconnect()
                }
            } else
                logger.log(
                    "[SERVER] Client is read only: not asking for authentication",
                )
            // And we reply ok with our signature too
            let _signature = cryptography.sign("auth_ok", identity.privateKey)
            let _reply = {
                signature: _signature,
                identity: identity.publicKey,
            }
            this.peer.socket.emit("auth_ok", _reply)
        })
    }

    authAskEmit = async () => {
        await this.peer.socket.emit("auth_ask", "sign this")
    }
}
