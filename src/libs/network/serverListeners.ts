import Transaction from "src/libs/blockchain/transaction"
import { comlinkUtils } from "src/libs/communications"
import ComLink from "src/libs/communications/comlink"
import { cryptography } from "src/libs/crypto"
import manageMessages from "src/libs/network/routines/manageMessages"
import { ISession } from "src/libs/network/routines/sessionManager"
import * as Security from "src/libs/network/securityModule"
/* eslint-disable no-extra-semi */
import ServerHandlers from "src/libs/network/serverHandlers"
import { Peer } from "src/libs/peer"
import { demostdlib } from "src/libs/utils"
import sharedState from "src/utilities/sharedState"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

import {
    BundleContent,
    ISecurityReport,
    ValidityData,
} from "@kynesyslabs/demosdk/types"

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

    // REVIEW ComLinks are managed "centrally" here so apply securityModule stuff here
    /* NOTE ComLink and Transactions
     Once a comlink is received, we need to parse it and check if it is a transaction or a message.
     Basically, a transaction needs gas calculation and validation, then it is sent back to the client that can
     either execute it or discard it.
     A message is just a message, so it is handled by its type.
    */
    async comlinkListener() {
        this.peer.socket.on("comlink", async request => {
            await this.manageComLink(request)
        })
        // TODO See in communications.js and find the best way to validate, check and digest the request
    }

    // This method is used to check the comlink before processing it
    async preflightComLinkChecks(request: any): Promise<any> {
        term.yellow("[SERVER] Received comlink\n")
        console.log(request)
        const id_ed25519 = sharedState.getInstance().identity.ed25519
        const receiver = this.peer.socket
        let _comlink_request: ComLink
        // TODO This can be put into securityModule for consistency
        try {
            // Parsing comlink
            _comlink_request = await comlinkUtils.parseComlink(
                request,
                this.peer.socket,
            )
            if (!_comlink_request) {
                return // TODO Better error handling
            }
        } catch (error) {
            term.red(error)
            console.log("Returning")
            return // TODO Better error handling
        }
        // We can now extract the comlink and the content to be used in the handlers
        console.log(
            "[serverListeners] ComLink request received and parsed correctly",
        )

        let content: BundleContent =
            _comlink_request.chain.current.currentMessage.bundle.content
        return { _comlink_request, content, id_ed25519, receiver }
    }

    // Here, we manage the comlink and its content
    async manageComLink(request: any) {
        // Security and sanity checks
        let { _comlink_request, content, id_ed25519, receiver } =
            await this.preflightComLinkChecks(request)
        //console.log(_comlink_request)
        // NOTE Now we have a valid ComLink and we can work with it
        console.log("[serverListeners] Received comlink content")

        let extra: any, require_reply: any, response: any

        console.log("[serverListeners] content.type: " + content.type)
        console.log("[serverListeners] content.extra: " + content.extra)

        // NOTE Intercepts the comlink and checks if it is a L2PS request
        if (content.type === "l2ps") {
            ;({ response, require_reply, extra } = await ServerHandlers.handleL2PS(content))
            if (!response) {
                term.red.bold(
                    "[SERVER] Error while handling L2PS request, aborting",
                )
            }
            // Sending back the response
            console.log("[SERVER] Sending back comlink")
            await demostdlib.reply(
                _comlink_request,
                response,
                require_reply,
                extra,
            )
            receiver.emit("comlink_reply", _comlink_request) // reply is managed in the common listeners
            return
        }

        /* NOTE If we are here, we have a transaction or we error out
        if (content.type !== "transaction") {
            term.red.bold(
                "[SERVER] Received a non recognized comlink, aborting",
            )
            console.log(content.type)
            await demostdlib.reply(
                _comlink_request,
                false,
                false,
                "invalid comlink type",
            )
            receiver.emit("comlink_reply", _comlink_request) // reply is managed in the common listeners
            return
        } */

        // TODO Better to modularize this
        // REVIEW We use the 'extra' field to see if it is a confirmTx request (prior to execution)
        // or an broadcastTx request (to execute the transaction after gas cost is calculated).
        // Transactions are either gas consuming or not, so we need to check if the transaction
        // needs to be validated,executed or treated as a message.
        switch (content.extra) {
            // ANCHOR Gas consuming transactions
            // Validating a tx means that we calculate gas and check if the transaction is valid
            // Then we send the validation data to the client that can use it to execute the tx
            case "confirmTx":
                term.yellow.bold("[SERVER] Received confirmTx\n")
                var validityData =
                    await ServerHandlers.handleValidateTransaction(
                        content.data as Transaction,
                    )
                response = validityData
                extra = ""
                require_reply = false // REVIEW Should we require a reply here?

                // console.log(response)

                break
            // Executing a tx means that we execute the transaction and send back the result
            // to the client. We first need to check if the tx is actually valid.
            case "broadcastTx":
                term.yellow.bold("[SERVER] Received broadcastTx\n")
                // REVIEW This method needs to actually verify if the transaction is valid
                var result = await ServerHandlers.handleExecuteTransaction(
                    content.data as ValidityData,
                    this.peer.socket,
                )
                // Destructuring the result to get the extra, require_reply and response
                ;({ extra, require_reply, response } = result)
                break
            // ANCHOR Messages
            // All the rest of the comlink types do not require extra validation or gas calculation
            // They are treated as messages and are handled by their types themselves
            // For readability, we call an external function to manage the messages
            default:
                ;({ extra, require_reply, response } = await manageMessages(
                    content,
                    _comlink_request,
                    request,
                    id_ed25519,
                    receiver,
                ))
                break
        }
        //console.log("content.message: " + content.message)
        //console.log("content.message.action: " + content.message.action)

        // ANCHOR Reply logic
        // NOTE unless specified, we now send back the updated comlink as a response
        await demostdlib.reply(_comlink_request, response, require_reply, extra)

        // TODO & REVIEW Call security module for send limiting messages
        let secDisabled = false
        if (!secDisabled) {
            let ts = new Date().getTime()
            let securityInterceptor: ISecurityReport =
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
