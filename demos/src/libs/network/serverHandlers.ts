/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Peer, PeerManager } from "src/libs/peer"
import InstantMessaging from "src/features/messaging/instantMessaging"
import { Identity } from "src/libs/identity"
import { ConsensusRequest } from "../consensus/Consensus"
import Mempool from "src/libs/blockchain/mempool"
import chain from "src/libs/blockchain/chain"
import { handlers as web2handlers } from "src/features/web2"
import validateWeb2 from "../blockchain/routines/validateWeb2"
import validateTransaction from "../blockchain/routines/validateTransaction"
import multichainDispatcher from "src/features/multichain/multichainDispatcher"
import multichainCapabilities from "sdk/localsdk/multichain/types/multichainCapabilities"
import sharedState from "src/utilities/sharedState"

export default class ServerHandlers {
    static async handleTransaction(content: any): Promise<any> {
        let require_reply = true // REVIEW Sure?
        let extra, response

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

        return { extra, require_reply, response }
    }

    static async handleXMChainOperation(content: any): Promise<any> {
        let extra
        let require_reply = false
        // NOTE Remember that crosschain operations are in chainscript syntax (see chainscript_example.ts)
        let response = await multichainDispatcher(content.data)
        // TODO
        return { extra, require_reply, response }
    }

    static async handleXMChainStatus(): Promise<any> {
        let extra
        let require_reply = false
        // NOTE Remember that crosschain operations are in chainscript syntax (see chainscript_example.ts)
        const response = await multichainCapabilities()
        // TODO
        return { extra, require_reply, response }
    }

    static async handleValidateWeb2(content: any): Promise<any> {
        let extra,
            require_reply = false
        const response = await validateWeb2(content.data)

        return { extra, require_reply, response }
    }

    static async handleWeb2Request(request: any, content: any): Promise<any> {
        console.log("[SERVER] Received web2Request")
        console.log(JSON.stringify(request))

        let extra,
            require_reply = false
        let response
        const currentPeerString = Identity.getInstance().getConnectionString()

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
                console.log("[SERVER] Received attestation request for getUrl")
                response = await web2handlers.http_attest(
                    content.message.httpVerb,
                    content.message.url,
                    content.message.headers,
                    currentPeerString,
                    content.message.web2Data,
                )
                break
            case "process_attestGetUrl":
                console.log("[SERVER] Received process_attestGetUrl request")
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
        return { extra, require_reply, response }
    }

    static async handleConsensusRequest(content: any): Promise<any> {
        let extra,
            require_reply = false
        let response

        if (content.type == "tx") {
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
            return { extra, require_reply, response }
        }

        console.log("[SERVER] Received consensus request")
        if (!sharedState.getInstance().consensusMode) {
            return {
                extra,
                require_reply,
                response: { error: "We are not in consensus mode" },
            }
        }

        let authorized = true
        // TODO Check if we are a validator
        if (!authorized) {
            return {
                extra,
                require_reply,
                response: { error: "Not authorized" },
            }
        }

        let consensus_request: ConsensusRequest = content.message
        let stage = consensus_request.stage // This is the stage of the consensus we are in and is a string representing the operation
        switch (stage) {
            // REVIEW Define all the stages of the consensus where validators will talk to each other
            case "mempool_sync":
                console.log("[SERVER] Received mempool sync request")
                if (consensus_request.extra == "send") {
                    console.log(
                        "[SERVER] Received mempool sync data: checking and maybe merging",
                    )
                    let success = await Mempool.receive(consensus_request.data) // This is the mempool we should sync with ours
                    if (!success) {
                        return {
                            extra,
                            require_reply,
                            response: { error: "Mempool sync failed" },
                        }
                    }
                    let formattedData = await Mempool.sort(
                        consensus_request.data,
                    )
                    success = await Mempool.merge(formattedData)
                    if (!success) {
                        return {
                            extra,
                            require_reply,
                            response: { error: "Mempool merge failed" },
                        }
                    }
                    response = { success: "Mempool merged" }
                } else {
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

        return { extra, require_reply, response }
    }

    static async handleMessage(content: any): Promise<any> {
        // Basic message handling logic
        // ...
        let extra
        let require_reply = false
        const response = await InstantMessaging.parseMessage(content)
        return { extra, require_reply, response }
    }

    static async handleStorage(content: any): Promise<any> {
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
        let extra
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
        let extra
        let require_reply = false
        let response
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
                response = "I am " + id_ed25519.publicKey.toString("hex")
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
        }
        return { extra, require_reply, response }
    }
}
