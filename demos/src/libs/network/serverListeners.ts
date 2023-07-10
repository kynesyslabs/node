import { cryptography } from "../crypto"
import { Peer, PeerManager } from "../peer"
import { comlinkUtils } from "../communications"
import { Messaging, Message } from "src/features/messaging"
import { Identity } from "../identity"
import Transmission from "../communications/transmission"
import Transaction from "src/libs/blockchain/transaction"
import chain from "src/libs/blockchain/chain"

export default class ServerListeners {
    peer: Peer

    constructor(peer: Peer) {
        this.peer = peer
    }

    async runListeners() {
        await this.authReplyListener()
        await this.authAskEmit()
        await this.comlinkListener()
        await this.helloListener()
        await this.transactionsListener()
    }

    authReplyListener = async () => {
        this.peer.socket.on("auth_reply", async data => {
            console.log("[SERVER] Received auth reply")
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
            // TODO We add the peer to the list
            // And we reply ok
            this.peer.socket.emit("auth_ok")
        })
    }

    authAskEmit = async () => {
        await this.peer.socket.emit("auth_ask")
    }

    comlinkListener = async () => {
        this.peer.socket.on("comlink", async request => {
            // REVIEW I don't think we need to do this every time
            console.log("[SERVER] Received comlink")
            const id_ed25519 = await cryptography.load("./.demos_identity")
            // TODO Add responseRegistry support as per main.js and communications.js
            let _receiver = this.peer.socket
            // FIXME The below logic needs to be refactored in a separate method as it is used by other listeners too
            let parsed_comlink = await comlinkUtils.parseComlink(
                request,
                this.peer.socket,
            )
            if (!parsed_comlink) return
            let _comlink_request = parsed_comlink[0]
            let content = parsed_comlink[1]
            // Listening for commands
            // INFO This switch handles the public methods that should have this structure:
            //      { method: "methodName", params: { ... }, muid: [number] }
            // Where muid is a message unique identifier that is used to identify the response
            var response
            var require_reply = false

            // INFO Web2 endpoints
            if (content.type === "web2Request") {
                console.log("[SERVER] Received web2Request")
                switch (content.message.action) {
                    case "getUrl":
                        console.log("[SERVER] Received getUrl")
                        // response = web2.http_request(
                        //     content.message.httpVerb,
                        //     content.message.url,
                        //     content.message.headers,
                        // )
                        break
                    default:
                        break
                }
            }

            // INFO Messaging endpoint
            else if (content.type === "messages") {
                // REVIEW Call the appropriate lib to parse the request and act
                response = await Messaging.parseRequest(content)
            }

            // INFO Storage endpoint
            else if (content.type === "storage") {
                // TODO Call the appropriate lib to parse the request and act
            }

            // INFO Node APIs endpoints
            else if (content.type === "nodeCall") {
                switch (content.message) {
                    case "getLastBlockNumber":
                        console.log("[SERVER] Received getLastBlockNumber")
                        response = await chain.getLastBlockNumber()
                        console.log(response)
                        break
                    case "getLastBlockHash":
                        response = await chain.getLastBlockHash()
                        break
                    case "getBlockByNumber":
                        if (!request.parameters.blockNumber) {
                            _receiver.emit("public", {
                                error: "No block specified",
                            })
                        }
                        response = await chain.getBlockByNumber(
                            request.parameters.blockNumber,
                        )
                        break
                    case "getBlockByHash":
                        if (!request.parameters.blockHash) {
                            _receiver.emit("public", {
                                error: "No block specified",
                            })
                        }
                        response = await chain.getBlockByHash(
                            request.parameters.blockHash,
                        )
                        break
                    case "getMempool":
                        response = await chain.getPendingPool()
                        break
                }
            }
            // INFO Default
            else {
                console.log("[COMLINK INVALID] No known type: " + content.type)
            }
            // ANCHOR Reply logic
            // REVIEW unless specified, we now send back the updated comlink as a response
            // Building a message to send back in the comlink
            var response_message = new Transmission(
                Identity.getInstance().ed25519.privateKey,
            )
            response_message.initialize(
                // TODO Specify the answer so that it has a type AND a message
                "reply",
                JSON.stringify(response), // FIXME Here goes undefined, not good
                id_ed25519.publicKey,
                "placeholder", // FIXME Also here goes undefined, not good
                null,
                null,
            )
            await response_message.finalize()
            // Populating the comlink
            _comlink_request.properties.is_reply = true // Setting the reply flag as we are replying
            _comlink_request.properties.require_reply = require_reply // Setting the require_reply flag as provided above
            await _comlink_request.replyToMessage(
                response_message.bundle,
                id_ed25519.privateKey,
            )
            // Sending back the response
            console.log("[SERVER] Sending back comlink")
            //console.log(JSON.stringify(_comlink_request))
            _receiver.emit("comlink_reply", _comlink_request) // reply is managed in the common listeners
        })
        // TODO See in communications.js and find the best way to validate, check and digest the request
    }

    helloListener = async () => {
        this.peer.socket.on("hello", async request => {
            console.log("[DEBUG] hello there")
        })
    }

    transactionsListener = async () => {
        this.peer.socket.on("transactions", async request => {
            // Refusing the request if there is no muid
            if (!request.muid) {
                this.peer.socket.emit("transactions", {
                    status: "error",
                    message: "No muid specified",
                })
                return
            }
            // request.tx is the signed tx (or should be)
            let integrity = await Transaction.sanityCheck(request.tx)
            if (!integrity) {
                this.peer.socket.emit("transactions", {
                    status: "error",
                    message: "Invalid transaction",
                    muid: request.muid,
                })
                return
            }
            // If the tx is valid, we verify the signature
            let verification = await Transaction.verify(request.tx)
            if (!verification[0]) {
                this.peer.socket.emit("transactions", {
                    status: "error",
                    message: "Failed verification",
                    muid: request.muid,
                })
                return
            }
            // TODO Put the tx into the blockchain as pending
            // Verify coherence of the tx
            let coherence = await Transaction.isCoherent(request.tx)
            if (!coherence[0]) {
                this.peer.socket.emit("transactions", {
                    status: "error",
                    message: "Failed coherence",
                    muid: request.muid,
                })
                return
                // TODO handle the transactions execution
            }
        })
    }
}
