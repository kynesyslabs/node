/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { cryptography } from "src/libs/crypto"
import { Peer, PeerManager } from "src/libs/peer"
import { comlinkUtils } from "src/libs/communications"
import InstantMessaging from "src/features/messaging/instantMessaging"
import { Identity } from "src/libs/identity"
import Transmission from "src/libs/communications/transmission"
import { ConsensusRequest } from "../consensus/Consensus"
import Mempool from "src/libs/blockchain/mempool"
import chain from "src/libs/blockchain/chain"
import { handlers as web2handlers } from "src/features/web2"
import validateWeb2 from "../blockchain/routines/validateWeb2"
import validateTransaction from "../blockchain/routines/validateTransaction"
import multichainDispatcher from "src/features/multichain/multichainDispatcher"
import multichainCapabilities from "sdk/localsdk/multichain/types/multichainCapabilities"
import sharedState from "src/utilities/sharedState"

export default class ServerListeners {
    peer: Peer

    constructor(peer: Peer) {
        this.peer = peer
    }

    async runListeners() {
        await this.authReplyListener() // REVIEW Is this used?
        await this.authAskEmit() // REVIEW Is this used?
        await this.comlinkListener()
    }

    // INFO Register or update a peer identity and connection string
    authReplyListener = async () => {
        // FIXME Auth reply listener should not add a client to the peerlist if is read only
        this.peer.socket.on("auth_reply", async data => {
            let identity = await cryptography.load("./.demos_identity")
            console.log("[SERVER] Received auth reply")
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
                console.log(
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

    comlinkListener = async () => {
        this.peer.socket.on("comlink", async request => {
            // REVIEW I don't think we need to do this every time
            console.log("[SERVER] Received comlink")
            //console.log(request)
            const id_ed25519 = await cryptography.load("./.demos_identity")
            // TODO Add responseRegistry support as per main.js and communications.js
            const receiver = this.peer.socket
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
            var response: any
            var extra: string = null
            var require_reply = false

            // INFO Validation endpoint (labeled for easy break statements)
            type_selector: if (content.type == "tx") {
                require_reply = true // REVIEW Sure?
                // Verify and execute the transaction
                let validatedTx = await validateTransaction(
                    content.type,
                    content.message,
                )
                // Returning an appropriate response
                if (!validatedTx[0]) {
                    extra = "InvalidTransaction: " + validatedTx[1]
                    response = false
                } else {
                    // Adding the valid tx to the mempool
                    Mempool.addTransaction(validatedTx[1]) // Works by writing the registry
                    extra = validatedTx[1].hash
                    response = true
                }
                // TODO Broadcast the tx to the other peers
                // Response is then sent back automatically as a reply (with our validation)
            }

            // ANCHOR Crosschain endpoints
            else if (
                content.type == "crosschain_operation" ||
                content.type == "multichain_operation"
            ) {
                // NOTE Remember that crosschain operations are in chainscript syntax (see chainscript_example.ts)
                response = await multichainDispatcher(content.data)
                // TODO
            } else if (
                content.type == "crosschain_status" ||
                content.type == "multichain_status"
            ) {
                response = await multichainCapabilities()
            }

            // ANCHOR Web2 endpoints
            else if (content.type == "validate_web2") {
                response = await validateWeb2(content.data)
                // TODO
            }

            // INFO Web2 endpoints
            else if (content.type === "web2Request") {
                console.log("[SERVER] Received web2Request")
                console.log(JSON.stringify(request))
                const currentPeerString =
                    Identity.getInstance().getConnectionString()

                switch (content.message.action) {
                    case "getUrl":
                        console.log("[SERVER] Received getUrl")
                        response = await web2handlers.http_request(
                            content.message.httpVerb,
                            content.message.url,
                            content.message.headers,
                            currentPeerString,
                            PeerManager.getInstance().getPeers().length,
                        )
                        break
                    case "attestGetUrl":
                        console.log(
                            "[SERVER] Received attestation request for getUrl",
                        )
                        response = await web2handlers.http_attest(
                            content.message.httpVerb,
                            content.message.url,
                            content.message.headers,
                            currentPeerString,
                            content.message.web2Data,
                        )
                        break
                    case "process_attestGetUrl":
                        console.log(
                            "[SERVER] Received process_attestGetUrl request",
                        )
                        response = await web2handlers.http_process_attestation(
                            content.message.httpVerb,
                            content.message.url,
                            content.message.headers,
                            currentPeerString,
                            content.message.web2Data,
                        )
                        console.log(
                            "[SERVER] Response from http process attestation is: " +
                                JSON.stringify(response),
                        )
                        break
                    default:
                        break
                }
            }

            // INFO Consensus endpoint
            else if (content.type == "consensus") {
                console.log("[SERVER] Received consensus request")
                if (!sharedState.getInstance().consensusMode) {
                    response = { error: "We are not in consensus mode" }
                    break type_selector
                }
                // TODO Check if once we are in consensus, we also are validators
                let authorized = true
                // TODO Check if we are a validator
                if (!authorized) {
                    response = { error: "Not authorized" }
                    break type_selector
                }

                let consensus_request: ConsensusRequest = content.message
                let stage = consensus_request.stage // This is the stage of the consensus we are in and is a string representing the operation
                switch (stage) {
                    // REVIEW Define all the stages of the consensus where validators will talk to each other
                    case "mempool_sync":
                        console.log("[SERVER] Received mempool sync request")
                        if (consensus_request.extra == "send") {
                            // REVIEW It should work
                            console.log(
                                "[SERVER] Received mempool sync data: checking and maybe merging",
                            )
                            let success = await Mempool.receive(
                                consensus_request.data,
                            ) // This is the mempool we should sync with ours
                            if (!success) {
                                response = { error: "Mempool sync failed" }
                                break
                            }
                            let formattedData = await Mempool.sort(
                                consensus_request.data,
                            )
                            success = await Mempool.merge(formattedData)
                            if (!success) {
                                response = { error: "Mempool merge failed" }
                                break
                            }
                            response = { success: "Mempool merged" }
                        } else {
                            // REVIEW Should we identify somehow or comlink id is enough?
                            console.log(
                                "[SERVER] Received mempool sync request: sending data",
                            )
                            let mempool = await Mempool.getMempool()
                            response = { mempool: mempool }
                        }
                        break
                    default:
                        response = { error: "Unknown consensus stage" }
                        break
                }
            }

            // ANCHOR Web3 endpoints

            // INFO Messaging endpoint
            else if (content.type === "messages") {
                // REVIEW Call the appropriate lib to parse the request and act
                response = await InstantMessaging.parseMessage(content)
            }

            // INFO Storage endpoint
            else if (content.type === "storage") {
                // TODO Call the appropriate lib to parse the request and act
            }

            // INFO Mempool endpoint
            else if (content.type === "mempool") {
                // Getting the mempool instance
                response = await Mempool.receive(content.message)
            }

            // INFO Node APIs endpoints (valid without authentication too)
            else if (content.type === "nodeCall") {
                let socketized_response: Peer[]
                let data = content.data
                console.log(typeof data)
                switch (content.message) {
                    case "getPeerlist":
                        console.log("[SERVER] Received getPeerlist")
                        // Getting our current peerlist
                        socketized_response =
                            PeerManager.getInstance().getPeers()
                        response = []
                        // Filling response with peers without socket objects
                        for (let peer of socketized_response) {
                            peer.socket = null
                            response.push(peer)
                        }
                        break
                    case "getLastBlockNumber":
                        console.log("[SERVER] Received getLastBlockNumber")
                        response = await chain.getLastBlockNumber()
                        console.log(
                            "[CHAIN.ts] Received reply from the database",
                        ) // REVIEW Debug
                        console.log(response)
                        break
                    case "getLastBlockHash":
                        response = await chain.getLastBlockHash()
                        break
                    case "getBlockByNumber":
                        if (
                            data.blockNumber === undefined ||
                            data.blockNumber === null
                        ) {
                            console.log("[SERVER ERROR] Missing blockNumber")
                            console.log(data)
                            receiver.emit("error", {
                                error: "No block specified",
                                muid: content.muid,
                            })
                        } else {
                            console.log(
                                "[SERVER] Received getBlockByNumber: " +
                                    data.blockNumber,
                            )
                            response = await chain.getBlockByNumber(
                                data.blockNumber,
                            )
                        }
                        break
                    case "getBlockByHash":
                        if (!data.hash) {
                            receiver.emit("public", {
                                error: "No block specified",
                            })
                        }
                        response = await chain.getBlockByHash(data.hash)
                        break
                    case "getTxByHash":
                        if (!data.hash) {
                            receiver.emit("public", {
                                error: "No tx specified",
                            })
                        }
                        response = await chain.getTxByHash(data.hash)
                        break
                    case "getMempool":
                        response = await chain.getPendingPool()
                        break
                    // INFO Authentication listener
                    case "getPeerIdentity":
                        // NOTE We don't need to sign anything as the comlink is signed already
                        response =
                            "I am " + id_ed25519.publicKey.toString("hex")
                        break

                    // INFO Address info endpoint
                    case "getAddressInfo":
                        if (!data.address) {
                            receiver.emit("public", {
                                error: "No address specified",
                            })
                        }
                        response = await chain.getAddressInfo(data.address)
                        break
                }
            }
            // INFO Default
            else {
                console.log("[COMLINK INVALID] No known type: " + content.type)
            }

            console.log("content.type: " + content.type)
            console.log("content.message: " + content.message)
            console.log("content.message.action: " + content.message.action)

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
                "placeholder", // TODO Add the receiver // FIXME: DONT WE HAVE THIS IN THE receiver object already?
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
}
