/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Peer, PeerManager } from "src/libs/peer"
import InstantMessaging from "src/features/messaging/instantMessaging"
import Mempool from "src/libs/blockchain/mempool"
import chain from "src/libs/blockchain/chain"
import handleWeb2 from "src/features/web2/web2endpoints"
import validateTransaction from "../blockchain/routines/validateTransaction"
import multichainDispatcher from "src/features/multichain/multichainDispatcher"
import multichainCapabilities from "sdk/localsdk/multichain/types/multichainCapabilities"
import sharedState from "src/utilities/sharedState"
import { BrowserRequest } from "./serverListeners"
import { normalizeWebBuffers } from "./routines/normalizeWebBuffers"
import Sessions from "./routines/sessionManager"

var term = require("terminal-kit").terminal

export default class ServerHandlers {
    // ANCHOR BrowserRequest

    // SECTION Login On Chain
    static async handleLoginRequest(content: BrowserRequest) {
        // A browser login request is the first step for a user to confirm their identity
        // The user will be prompted for a message to sign and their session is either created or updated
        let address_requested = content.data.publicKey // Must be a JSON string of a publicKey
        let requested_session =
            Sessions.getInstance().newSession(address_requested)
        return requested_session
    }

    static async handleLoginResponse(content: BrowserRequest) {
        let result = [true, ""]
        let s_signature = content.data.signature // Must be a JSON or a string of a signature (as Uint8Array or {type: "Buffer", data: []})
        let signature_conversion = normalizeWebBuffers(s_signature)
        let signature = signature_conversion[0]
        if (!signature)
            return [false, "Invalid signature: " + signature_conversion[1]]
        // TODO Check session validity
        // INFO When a user logs in, the server will store and send a token valid for X time
        // the user possessing that token will be able to demonstrate that the user is still logged in
        // even in 3rd party applications.
        // In any case, by calling loginRequest any application is able to enforce the user to log in
        // and verify themselves again.
        return result
    }
    // !SECTION Login On Chain

    // ANCHOR Comlinks
    static async handleTransaction(content: any): Promise<any> {
        let require_reply = true // REVIEW Sure?
        let extra: string, response: boolean

        // Verify and execute the transaction
        let validatedTx: any[]
        try {
            validatedTx = await validateTransaction(
                content.type,
                content.message,
            )
        } catch (e) {
            term.red("[TX VALIDATION ERROR]: ")
            term.red(e)
            validatedTx = [false, e.message]
        }
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

        return { extra, require_reply, response }
    }

    static async handleXMChainOperation(content: any): Promise<any> {
        let extra: any
        let require_reply = false
        // REVIEW Remember that crosschain operations can be in chainscript syntax
        // INFO Use the src/features/multichain/chainscript/chainscript.chs for the specs
        let response = await multichainDispatcher.digest(content.data)
        // TODO
        return { extra, require_reply, response }
    }

    // INFO This method is used to allow signed data exchanges between peers and clients
    static async handleXMChainSignedPayload(content: any): Promise<any> {
        // TODO
    }

    static async handleXMChainStatus(): Promise<any> {
        let extra: any
        let require_reply = false
        // NOTE Remember that crosschain operations are in chainscript syntax (see chainscript_example.ts)
        const response = await multichainCapabilities()
        // TODO
        return { extra, require_reply, response }
    }

    // NOTE Theoretically, content should be IWeb2Request compliant
    // LINK "../../features/web2/types/Web2Request";
    static async handleWeb2Request(
        request: any,
        content: any,
        senderSocket: any,
    ): Promise<any> {
        console.log("[SERVER] Received web2Request")
        console.log(JSON.stringify(request))

        let extra: any,
            require_reply = false
        let response: unknown
        // We get our connection string
        // const currentPeerString = Identity.getInstance().getConnectionString()
        // NOTE Switched to the new class
        let fullResponse = await handleWeb2(content, senderSocket)
        // Managing the results
        if (fullResponse[0]) {
            response = fullResponse[1]
        } else {
            response = "error"
            extra = fullResponse[1]
        }
        return { extra, require_reply, response }
    }

    // FIXME Use the new consensus classes
    static async handleConsensusRequest(): Promise<any> {
        let extra: string,
            require_reply = false
        let response: any

        console.log("[SERVER] Received consensus request")
        if (!sharedState.getInstance().consensusMode) {
            return {
                extra,
                require_reply,
                response: { error: "We are not in consensus mode" },
            }
        }

        // TODO First part of rBFT: PoR Shard creation
        let authorized = true
        // TODO Check if we are a validator
        if (!authorized) {
            return {
                extra,
                require_reply,
                response: { error: "Not authorized" },
            }
        }

        // TODO Go through the rBFT phases

        return { extra, require_reply, response }
    }

    static async handleMessage(content: any): Promise<any> {
        // Basic message handling logic
        // ...
        let extra: any
        let require_reply = false
        const response = await InstantMessaging.parseMessage(content)
        return { extra, require_reply, response }
    }

    static async handleStorage(): Promise<any> {
        // Basic storage handling logic
        // ...
        let extra = { storageState: "mocked" }
        let require_reply = true
        let response = {}
        return { extra, require_reply, response }
    }

    static async handleMempool(content: any): Promise<any> {
        // Basic message handling logic
        // ...
        let extra: any
        let require_reply = false
        const response = await Mempool.receive(content.message)
        return { extra, require_reply, response }
    }

    static async handleNodeAPI(
        content: any,
        receiver: any,
        id_ed25519: any,
    ): Promise<any> {
        // Basic Node API handling logic
        // ...
        let extra: any
        let require_reply = false
        let response: string | Peer[] | number
        let socketized_response: Peer[]
        let data = content.data
        console.log(typeof data)
        console.log(JSON.stringify(content))
        switch (content.message) {
            case "getPeerlist":
                console.log("[SERVER] Received getPeerlist")
                // Getting our current peerlist
                socketized_response = PeerManager.getInstance().getPeers()
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
                console.log("[CHAIN.ts] Received reply from the database") // REVIEW Debug
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
                    response = await chain.getBlockByNumber(data.blockNumber)
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
                response = "I am " + id_ed25519.publicKey//.toString("hex")
                console.log(response)
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
            case "getPeerTime":
                response = new Date().getTime()
                break
        }
        return { extra, require_reply, response }
    }
}
