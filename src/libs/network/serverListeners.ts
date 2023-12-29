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
import { Identity } from "src/libs/identity"
import Transmission from "src/libs/communications/transmission"
import { proofConsensusHandler } from "../consensus/routines/proofOfConsensus"
import { ISecurityReport } from "./securityModule"
import * as Security from "./securityModule"

import terminalkit from "terminal-kit"
var term = terminalkit.terminal

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
        // await this.authReplyListener()
        // await this.authAskEmit()

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
            var res
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
            const id_ed25519 = await cryptography.load("./.demos_identity")
            const receiver = this.peer.socket
            var parsed_comlink
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
            console.log("comlink request")
            //console.log(_comlink_request)
            let content = parsed_comlink[1]

            let extra: any, require_reply: any, response: any

            // NOTE And here we have the real deal
            switch (content.type) {
                case "proofOfConsensus":
                    ;({ extra, require_reply, response } =
                        await proofConsensusHandler(content))
                    break

                case "tx":
                    term.yellow.bold("[SERVER] Received tx\n")
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleTransaction(content))
                    break

                case "crosschain_operation":
                case "multichain_operation": // TODO Here or as a nodeCall?
                    // var foo = {
                    //     type: "nodeCall",
                    //     message: "crosschain_operation",
                    //     sender: {
                    //         type: "Buffer",
                    //         data: [
                    //             117, 83, 167, 201, 6, 245, 3, 205, 235, 14, 81,
                    //             249, 59, 8, 93, 113, 8, 153, 106, 139, 123, 52,
                    //             189, 222, 131, 240, 243, 78, 34, 35, 6, 30,
                    //         ],
                    //     },
                    //     receiver: null,
                    //     timestamp: null,
                    //     data: {
                    //         multichain_operation: {
                    //             "2ad9e8e9-c173-4f27-ab8d-a73f6dd4dada": {
                    //                 chain: "eth",
                    //                 subchain: "dunno",
                    //                 is_evm: true,
                    //                 rpc: null,
                    //                 conditional: false,
                    //                 task: {
                    //                     type: "contract_read",
                    //                     params: {
                    //                         address:
                    //                             "0x33EeCbf908478C10614626A9D304bfe18B78DD73",
                    //                         // eslint-disable-next-line quotes
                    //                         abi: '[{"constant":true,"inputs":[{"name":"_interfaceId","type":"bytes4"}],"name":"supportsInterface","outputs":[{"name":"","type":"bool"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_galaxy","type":"uint8"},{"name":"_proposal","type":"bytes32"}],"name":"startDocumentPoll","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"name","outputs":[{"name":"","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"}],"name":"detach","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[{"name":"_tokenId","type":"uint256"}],"name":"getApproved","outputs":[{"name":"approved","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_approved","type":"address"},{"name":"_tokenId","type":"uint256"}],"name":"approve","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_proposal","type":"bytes32"}],"name":"updateDocumentPoll","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[],"name":"onUpgrade","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"InterfaceId_ERC165","outputs":[{"name":"","type":"bytes4"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"},{"name":"_target","type":"address"},{"name":"_reset","type":"bool"}],"name":"transferPoint","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_tokenId","type":"uint256"}],"name":"transferFrom","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_galaxy","type":"uint8"},{"name":"_target","type":"address"}],"name":"createGalaxy","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"depositAddress","outputs":[{"name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"},{"name":"_transferProxy","type":"address"}],"name":"setTransferProxy","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"treasuryUpgradeHash","outputs":[{"name":"","type":"bytes32"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_tokenId","type":"uint256"}],"name":"safeTransferFrom","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"},{"name":"_encryptionKey","type":"bytes32"},{"name":"_authenticationKey","type":"bytes32"},{"name":"_cryptoSuiteVersion","type":"uint32"},{"name":"_discontinuous","type":"bool"}],"name":"configureKeys","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[{"name":"_point","type":"uint32"},{"name":"_sponsor","type":"uint32"}],"name":"canEscapeTo","outputs":[{"name":"canEscape","type":"bool"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_treasuryImpl","type":"address"}],"name":"upgradeTreasury","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[{"name":"_tokenId","type":"uint256"}],"name":"exists","outputs":[{"name":"doesExist","type":"bool"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_galaxy","type":"uint8"},{"name":"_proposal","type":"address"},{"name":"_vote","type":"bool"}],"name":"castUpgradeVote","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_proposal","type":"address"}],"name":"updateUpgradePoll","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"treasuryProxy","outputs":[{"name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[{"name":"_tokenId","type":"uint256"}],"name":"ownerOf","outputs":[{"name":"owner","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_galaxy","type":"uint8"},{"name":"_proposal","type":"bytes32"},{"name":"_vote","type":"bool"}],"name":"castDocumentVote","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[],"name":"renounceOwnership","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"},{"name":"_manager","type":"address"}],"name":"setManagementProxy","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"owner","outputs":[{"name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"treasuryUpgraded","outputs":[{"name":"","type":"bool"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_galaxy","type":"uint8"},{"name":"_proposal","type":"address"}],"name":"startUpgradePoll","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"},{"name":"_target","type":"address"}],"name":"spawn","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_operator","type":"address"},{"name":"_approved","type":"bool"}],"name":"setApprovalForAll","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_galaxy","type":"uint8"},{"name":"_voter","type":"address"}],"name":"setVotingProxy","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_prefix","type":"uint16"},{"name":"_spawnProxy","type":"address"}],"name":"setSpawnProxy","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_tokenId","type":"uint256"},{"name":"_data","type":"bytes"}],"name":"safeTransferFrom","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_primary","type":"string"},{"name":"_secondary","type":"string"},{"name":"_tertiary","type":"string"}],"name":"setDnsDomains","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"}],"name":"reject","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"},{"name":"_sponsor","type":"uint32"}],"name":"escape","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"}],"name":"adopt","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":false,"inputs":[{"name":"_point","type":"uint32"}],"name":"cancelEscape","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[{"name":"_tokenId","type":"uint256"}],"name":"tokenURI","outputs":[{"name":"_tokenURI","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"azimuth","outputs":[{"name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"claims","outputs":[{"name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"polls","outputs":[{"name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[{"name":"_owner","type":"address"},{"name":"_operator","type":"address"}],"name":"isApprovedForAll","outputs":[{"name":"result","type":"bool"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"previousEcliptic","outputs":[{"name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[{"name":"_point","type":"uint32"},{"name":"_time","type":"uint256"}],"name":"getSpawnLimit","outputs":[{"name":"limit","type":"uint32"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"payable":false,"stateMutability":"nonpayable","type":"function"},{"inputs":[{"name":"_previous","type":"address"},{"name":"_azimuth","type":"address"},{"name":"_polls","type":"address"},{"name":"_claims","type":"address"},{"name":"_treasuryProxy","type":"address"}],"payable":false,"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"name":"_from","type":"address"},{"indexed":true,"name":"_to","type":"address"},{"indexed":true,"name":"_tokenId","type":"uint256"}],"name":"Transfer","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"name":"_owner","type":"address"},{"indexed":true,"name":"_approved","type":"address"},{"indexed":true,"name":"_tokenId","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"name":"_owner","type":"address"},{"indexed":true,"name":"_operator","type":"address"},{"indexed":false,"name":"_approved","type":"bool"}],"name":"ApprovalForAll","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"name":"to","type":"address"}],"name":"Upgraded","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"name":"previousOwner","type":"address"}],"name":"OwnershipRenounced","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"name":"previousOwner","type":"address"},{"indexed":true,"name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"}]',
                    //                         method: "name",
                    //                         params: "",
                    //                     },
                    //                     signedPayloads: [],
                    //                 },
                    //             },
                    //             "2b79982e-bdf1-47b3-932e-b884f038a232": {
                    //                 chain: "xrpl",
                    //                 subchain: "dunno",
                    //                 is_evm: false,
                    //                 rpc: null,
                    //                 conditional: false,
                    //                 task: {
                    //                     type: "pay",
                    //                     params: {
                    //                         to: "rnFShShcsKSb6UioaB7WwxytUJsbt4hXug",
                    //                         amount: "1",
                    //                     },
                    //                     signedPayloads: [
                    //                         {
                    //                             tx_blob:
                    //                                 "12000022000000002402974BCF201B02974BF96140000000000F424068400000000000000C7321ED7E40578AE6625CEC8E8DA93D68744D54DCF412E5836F171697B93E733C4F410D7440BDDEC9C46CA63D55B034EFF560D09619BF7EF091900EFCB21CE6AE1FF79A31212DBEFAD7E624890114C4ACAA81B93244D481B57F17E9F308B58F3B1E1393960E811434D8F8C04F67DDA8BAA27D6F184C402983E297F1831434D8F8C04F67DDA8BAA27D6F184C402983E297F1",
                    //                             hash: "DFF6467801734200A3596F9950962FB239F221F638E13A338559842E7389535B",
                    //                         },
                    //                     ],
                    //                 },
                    //             },
                    //         },
                    //     },
                    //     extra: null,
                    // }
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleXMChainOperation(content))
                    break

                case "web2Request":
                    ;({ extra, require_reply, response } =
                        await ServerHandlers.handleWeb2Request(
                            request,
                            content,
                            this.peer.socket,
                        ))
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

            console.log("content.type: " + content.type)
            console.log("content.message: " + content.message)
            console.log("content.message.action: " + content.message.action)

            // ANCHOR Reply logic
            // REVIEW unless specified, we now send back the updated comlink as a response
            // Building a message to send back in the comlink
            // TODO Use demostdlib

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
        })
        // TODO See in communications.js and find the best way to validate, check and digest the request
    }

    // INFO Register or update a peer identity and connection string
    async authReplyListener() {
        // FIXME Auth reply listener should not add a client to the peerlist if is read only
        this.peer.socket.on("auth_reply", async data => {
            let identity = await cryptography.load("./.demos_identity")
            term.yellow("[SERVER] Received auth reply")
            if (!(data === "readonly")) {
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
            var res: string

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
