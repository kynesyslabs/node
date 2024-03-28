/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { comlinkUtils } from "src/libs/communications"
import { cryptography } from "src/libs/crypto"
import { demostdlib } from "../utils"
/* eslint-disable no-extra-semi */
import ServerHandlers from "src/libs/network/serverHandlers"
import { Peer } from "src/libs/peer"
import sharedState from "src/utilities/sharedState"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

import { proofConsensusHandler } from "../consensus/routines/proofOfConsensus"
import { ISession } from "./routines/sessionManager"
import * as Security from "./securityModule"

let term = terminalkit.terminal

export interface BrowserRequest {
    message: string
    data: any
}

export default class ServerListeners {
    peer: Peer

    constructor(peer: Peer) {
        this.peer = peer
    }

    async runListeners() {
        await this.comlinkListener()
        await this.browserRequestListener()
        await this.voteRequestListener()
    }

    // NOTE Browser requests follows a completely different path from the others
    // INFO this set of listeners does not require authentication and
    // are not comlink as well, so they need to have their own listeners
    async browserRequestListener() {
        this.peer.socket.on("browser_request", async request => {
            term.yellow("[SERVER] Received browser request\n")
            // NOTE request MUST be a string conforming to BrowserRequest interface
            let req: BrowserRequest = JSON.parse(request)
            let browserResponse: [boolean, any]
            let res: ISession | (string | boolean)[]
            switch (req.message) {
                case "login_request":
                    res = await ServerHandlers.handleLoginRequest(req)
                    browserResponse = [true, res]
                    break
                case "login_response":
                    res = await ServerHandlers.handleLoginResponse(req)
                    browserResponse = [true, res]
                    break
                case "logout_request":
                    break
                default:
                    browserResponse = [false, "Invalid request"]
                    break
            }
            this.peer.socket.emit(
                "browser_response",
                JSON.stringify(browserResponse),
            )
        })
    }

    // NOTE ComLinks are managed "centrally" here so apply securityModule stuff here
    async comlinkListener() {
        this.peer.socket.on("comlink", async request => {
            term.yellow("[SERVER] Received comlink\n")
            const id_ed25519 = sharedState.getInstance().identity.ed25519
            const receiver = this.peer.socket
            let parsed_comlink: any // TODO Better typing
            // TODO This can be put into securityModule for consistency
            try {
                // Parsing comlink
                parsed_comlink = await comlinkUtils.parseComlink(
                    request,
                    this.peer.socket,
                )
                if (!parsed_comlink) {
                    return // TODO Better error handling
                }
            } catch (error) {
                term.red(error)
                console.log("Returning")
                return // TODO Better error handling
            }
            let _comlink_request = parsed_comlink[0]
            console.log("[serverListeners] ComLink request received and parsed correctly")
            //console.log(_comlink_request)
            let content = parsed_comlink[1]
            console.log("[serverListeners] Received comlink content")

            let extra: any, require_reply: any, response: any

            //let content_data = content.data
            //console.log("[DATA INCLUDED IN THE COMLINK]")
            //console.log(content_data)

            // NOTE And here we have the real deal
            console.log("[serverListeners] content.type: " + content.type)
            switch (content.type) {
                /* FIXME We need to calculate the gas cost for operations that require it
                 * To implement the above, all the non-system operations must be grouped into the
                 * validateTx and executeTx types. The Transaction object must be compliant to support
                 * XM, Web2 and possibly other operations.
                 * This way, using the validity + execute cases, we can efficiently pre-check and compute
                 * the gas cost for the operation and its validity.
                */
                // NOTE To execute a native tx, the client needs to first confirm it
                case "validateTx":
                    term.yellow.bold("[SERVER] Received validateTx\n")
                    var validityData = await ServerHandlers.handleTransaction(content)
                    response = validityData.data.valid
                    extra = validityData.data.message
                    require_reply = false
                    break
                // NOTE Taking validity data and executing the transaction
                case "executeTx":
                    term.yellow.bold("[SERVER] Received executeTx\n")
                    response = await ServerHandlers.handleExecuteTransaction(content)
                    break

                case "crosschain_operation":
                case "multichain_operation":
                    console.log(
                        "[Included XM Chainscript]" +
                            JSON.stringify(content.message) +
                            "\n\n",
                    )
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleXMChainOperation(
                            content.message,
                        ))
                    break
                case "web2Request":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleWeb2Request(
                            request,
                            content,
                            this.peer.socket,
                        ))
                    break

                case "proofOfConsensus":
                    ;({ extra, require_reply, response } =
                        await proofConsensusHandler(content))
                    break
                case "consensus":
                    console.log(
                        "[SERVER LISTENER HANDLER]: received consensus request",
                    )
                    console.log(
                        parsed_comlink[0].chain.current.currentMessage.bundle
                            .content.sender,
                    )
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleConsensusRequest(
                            request,
                            content,
                            parsed_comlink[0].chain.current.currentMessage
                                .bundle.content.sender,
                        ))
                    break

                case "messages":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleMessage(content))
                    break

                case "storage":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleStorage())
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
                    term.red(
                        `[COMLINK INVALID] No known type: ${content.type}\n`,
                    )
                    break
            }
            //console.log("content.message: " + content.message)
            //console.log("content.message.action: " + content.message.action)

            // ANCHOR Reply logic
            // NOTE unless specified, we now send back the updated comlink as a response
            await demostdlib.reply(
                _comlink_request,
                response,
                require_reply,
                extra,
            )

            // TODO & REVIEW Call security module for send limiting messages
            let secDisabled = false
            if (!secDisabled) {
                let ts = new Date().getTime()
                let securityInterceptor: Security.ISecurityReport =
                    await Security.modules.communications.comlink.checkRateLimits(
                        ts,
                    )
                if (!securityInterceptor.state) {
                    switch (securityInterceptor.code) {
                        case "429":
                            break

                        default:
                            term.red.bold(
                                "[COMLINK] [SECURITY INTERCEPTOR] Unknown error: " +
                                    securityInterceptor.code.toString(),
                            )
                            term.red.bold(
                                "[COMLINK] [SECURITY INTERCEPTOR] Reported:",
                            )
                            console.log(securityInterceptor.message)
                            break
                    }
                }
            }

            // Sending back the response
            console.log("[SERVER] Sending back comlink")
            //console.log(JSON.stringify(_comlink_request))
            receiver.emit("comlink_reply", _comlink_request) // reply is managed in the common listeners
        })
        // TODO See in communications.js and find the best way to validate, check and digest the request
    }

    // INFO Register or update a peer identity and connection string
    async authReplyListener() {
        // REVIEW Auth reply listener should not add a client to the peerlist if is read only
        this.peer.socket.on("auth_reply", async data => {
            let identity = await cryptography.load("./.demos_identity")
            term.yellow("[SERVER] Received auth reply")
            if (data !== "readonly") {
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
            } else {
                term.yellow(
                    "[SERVER] Client is read only: not asking for authentication",
                )
            }
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

    voteRequestListener = async () => {
        this.peer.socket.on("voteRequest", async (request, callback) => {
            term.yellow("[SERVER] Received vote request\n")
            //console.log(request)
            let voteResponse: string
            let res: string

            console.log("request")
            //console.log(request)

            switch (request.parameter) {
                case "forgedProposedHash":
                    res = await ServerHandlers.handleVoteRequest(
                        request.timestamp,
                    )
                    voteResponse = res
            }

            callback(voteResponse)
        })
    }
}
