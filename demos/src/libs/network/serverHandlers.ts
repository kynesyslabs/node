/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Peer, PeerManager } from "src/libs/peer"
import InstantMessaging from "src/features/InstantMessagingProtocol/instantMessagingProtocol"
import Mempool from "src/libs/blockchain/mempool"
import chain from "src/libs/blockchain/chain"
import handleWeb2 from "src/features/web2/Web2Dispatcher"
import validateTransaction from "../blockchain/routines/validateTransaction"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import multichainCapabilities from "sdk/localsdk/multichain/types/multichainCapabilities"
import sharedState from "src/utilities/sharedState"
import { BrowserRequest } from "./serverListeners"
import { normalizeWebBuffers } from "./routines/normalizeWebBuffers"
import Sessions from "./routines/sessionManager"
import Block from "src/libs/blockchain/blocks"
import Transaction from "src/libs/blockchain/transaction"
import eggs from "./routines/eggs"
import deriveBlock from "../consensus/routines/deriveBlock"
import AddressInfo from "../blockchain/types/addressInfo"
import { Address } from "cluster"

var term = require("terminal-kit").terminal

export default class ServerHandlers {
    // ANCHOR BrowserRequest

    // SECTION Login On Chain
    static async handleLoginRequest(content: BrowserRequest) {
        // A browser login request is the first step for a user to confirm their identity
        // The user will be prompted for a message to sign and their session is either created or updated
        let address_requested = content.data.publicKey // Must be a JSON string of a publicKey
        return Sessions.getInstance().newSession(address_requested)
    }

    static async handleLoginResponse(content: BrowserRequest) {
        let result = [true, ""]
        let s_signature = content.data.signature // Must be a JSON or a string of a signature (as Uint8Array or {type: "Buffer", data: []})
        let signature_conversion = normalizeWebBuffers(s_signature)
        let signature = signature_conversion[0]
        if (!signature) {
            return [false, "Invalid signature: " + signature_conversion[1]]
        }
        // TODO Check session validity
        // INFO When a user logs in, the server will store and send a token valid for X time
        // the user possessing that token will be able to demonstrate that the user is still logged in
        // even in 3rd party applications.
        // In any case, by calling loginRequest any application is able to enforce the user to log in
        // and verify themselves again.
        return result
    }

    // !SECTION Consensus Voting
    // ANCHOR Vote request

    static async handleVoteRequest(timestamp: number): Promise<string> {
        // Todo : compare the received response response with what we have locally, and return the vote result
        console.log("[SERVERHANDLER] handleVoteRequest")
        const mempool = await Mempool.getMempool()
        const propsedBlock = await deriveBlock(mempool, timestamp)
        let proposedBlockHash = propsedBlock.hash
        return proposedBlockHash
    }

    // !SECTION Login On Chain

    // ANCHOR Comlinks
    static async handleTransaction(content: any): Promise<any> {
        term.yellow("[handleTransactions] Handling a native DEMOS tx...\n")
        let require_reply = true // REVIEW Sure?
        let extra: string, response: boolean
        let fname = "[handleTransactions] "
        term.yellow(fname + "Handling transaction...")
        // Verify and execute the transaction
        let validatedTx: any[]
        try {
            /* NOTE This workflow goeas as:
             * The tx is validated, an operation is created and pushed in the GLS
             * An operation for the gas is also pushed in the GLS
             * The tx is pushed in the mempool if applicable
             */
            console.log(fname + "Validating transaction...")
            validatedTx = await validateTransaction(
                content.type,
                content.message,
            )
            console.log(fname + "Fetching result...")
        } catch (e) {
            term.red.bold("[TX VALIDATION ERROR] 💀 : ")
            term.red(e)
            validatedTx = [false, e.message]
        }

        // Returning an appropriate response
        if (!validatedTx[0]) {
            // An invalid transaction won't even be added to the mempool
            term.yellow.bold(fname + "Invalid transaction 💀 : ")
            console.log(validatedTx[1])
            extra = "InvalidTransaction 💀: " + validatedTx[1]
            response = false
        } else {
            /* NOTE 
                    We just processed the cryptographic validity of the transaction.
                    We have no idea of its state validity and thus won't modify the GLS, but
                    it can go into the mempool to be further processed if its cryptographically valid.
                */
            term.green.bold(fname + "Valid transaction: ")
            console.log(validatedTx[1])
            console.log(fname + "Adding transaction to mempool...")
            // Adding the valid tx to the mempool
            Mempool.addTransaction(validatedTx[1]) // Works by writing the registry
            extra = validatedTx[1].hash
            response = true
            //process.exit(0) /* TODO Eliminate this debug line */
        }
        // TODO Broadcast the tx to the other peers
        // Response is then sent back automatically as a reply (with our validation)
        term.bold.white(fname + "Transaction handled.")
        return { extra, require_reply, response }
    }

    // INFO Handling XM Transaction
    static async handleXMChainOperation(content: any): Promise<any> {
        /* NOTE This workflow goeas as:
         * The XM Operation is validated, executed and verified
         * when applicable.
         * A transaction is derived from the executed operation.
         * An operation is then created and pushed in the GLS.
         * An operation for the gas is also pushed in the GLS.
         * The tx is pushed in the mempool if applicable.
         */
        let extra: any
        let require_reply = false
        console.log("[XMChain] Handling XM Chain Operation...")
        // REVIEW Remember that crosschain operations can be in chainscript syntax
        // INFO Use the src/features/multichain/chainscript/chainscript.chs for the specs
        let response = await multichainDispatcher.digest(content.data)
        // TODO
        return { extra, require_reply, response }
    }

    // INFO This method is used to allow signed data exchanges between peers and clients
    static async handleXMChainSignedPayload(content: any): Promise<any> {
        // TODO Probably to take it out
    }

    static async handleXMChainStatus(): Promise<any> {
        let extra: any
        let require_reply = false
        // NOTE Remember that crosschain operations are in chainscript syntax (see chainscript_example.ts)
        const response = await multichainCapabilities()
        // TODO
        return { extra, require_reply, response }
    }

    // INFO Handling Web2 Transaction
    // NOTE Theoretically, content should be IWeb2Request compliant
    // LINK "../../features/web2/types/Web2Request";
    static async handleWeb2Request(
        request: any,
        content: any,
        senderSocket: any,
    ): Promise<any> {
        /* NOTE This workflow goeas as:
         * The Web2 Operation is validated, executed and verified
         * when applicable. Is then sent back once attested.
         * A transaction is derived from the executed web2 operation.
         * An operation is then created and pushed in the GLS.
         * An operation for the gas is also pushed in the GLS.
         * The tx is pushed in the mempool if applicable.
         */
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

    static async handleConsensusRequest(
        request: any,
        content: any,
        senderIdentity: any,
    ): Promise<any> {
        let extra: string,
            require_reply = false
        let response: any

        console.log("[SERVER] Received consensus request")
        console.log("[SERVER] Peer identity information:")
        console.log(senderIdentity)
        if (!sharedState.getInstance().consensusMode) {
            return {
                extra,
                require_reply,
                response: { error: "We are not in consensus mode" },
            }
        }

        let authorized = false
        let senderPublicKey = senderIdentity.toString("hex")

        const { shard } = sharedState.getInstance()

        if (!shard) {
            return {
                extra,
                require_reply,
                response: { error: "No shard found in shared state" },
            }
        }
        console.log("[SERVERHANDLER] Shard found in shared state")
        console.log(shard)

        const peerList = await shard.getPeers()

        // Authorizing the sender
        for (let peer of peerList) {
            if (peer.identity.toString("hex") === senderPublicKey) {
                authorized = true
                break
            }
        }

        // Return error if not authorized
        if (!authorized) {
            return {
                extra,
                require_reply,
                response: { error: "Not authorized" },
            }
        }

        switch (content.message) {
            case "getMempool":
                response = await Mempool.getMempool()
                console.log("[SERVERHANDLER] Received mempool")
                console.log(response)
                return { extra, require_reply, response }

            default:
                return {
                    extra,
                    require_reply,
                    response: { error: "Unknown message" },
                }
        }
    }

    static async handleMessage(content: any): Promise<any> {
        // Basic message handling logic
        // ...
        let extra: any
        let require_reply = false
        const response = "Not Yet Implemented"
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
        let response:
            | string
            | Peer[]
            | number
            | Block
            | Transaction
            | Transaction[]
            | AddressInfo
        let socketized_response: Peer[]
        let { data } = content
        console.log(typeof data)
        console.log(JSON.stringify(content))
        switch (content.message) {
            case "crosschain_operation":
            case "multichain_operation":
                term.yellow.bold("[SERVER] Received crosschain_operation\n")
                response = await ServerHandlers.handleXMChainOperation(content)
                break // REVIEW Here or in comlinks?
            case "getPeerlist":
                console.log("[SERVER] Received getPeerlist")
                // Getting our current peerlist
                socketized_response = PeerManager.getInstance().getPeers()
                response = [] as Peer[]
                // Filling response with peers without socket objects
                for (let peer of socketized_response) {
                    peer.socket = null
                    response.push(peer)
                }
                break
            // REVIEW Both below for getting the last hash (untested yet)
            case "getPreviousHashFromBlockNumber":
                console.log("[SERVER] Received getPreviousHashFromBlockNumber")
                if (data.blockNumber === undefined || data.blockNumber < 0) {
                    response = "error"
                    extra = "Block number is not valid"
                    break
                }
                response = await chain.getBlockByNumber(data.blockNumber)
                console.log(
                    "[CHAIN.ts] Received reply from the database: got a block",
                )
                response = response.content.previousHash
                break
            case "getPreviousHashFromBlockHash":
                console.log("[SERVER] Received getPreviousHashFromBlockNumber")
                if (data.blockHash === undefined || data.blockHash === "") {
                    response = "error"
                    extra = "Block hash is not valid"
                    break
                }
                response = await chain.getBlockByHash(data.blockHash)
                console.log(
                    "[CHAIN.ts] Received reply from the database: got a block",
                )
                response = response.content.previousHash
                break
            // REVIEW (untested) Headers instead of full blocks
            case "getBlockHeaderByNumber":
                if (
                    data.blockNumber === undefined ||
                    data.blockNumber < 0 ||
                    data.blockNumber === ""
                ) {
                    response = "error"
                    extra = "Block number is not valid"
                    break
                }
                response = await chain.getBlockByNumber(data.blockNumber)
                console.log(
                    "[CHAIN.ts] Received reply from the database: extracting header",
                )
                response = response.getHeader()
                console.log(response)
                break
            case "getBlockHeaderByHash":
                if (data.blockHash === undefined || data.blockHash === "") {
                    response = "error"
                    extra = "Block hash is not valid"
                    break
                }
                response = await chain.getBlockByHash(data.blockHash)
                console.log(
                    "[CHAIN.ts] Received reply from the database: extracting header",
                )
                response = response.getHeader()
                console.log(response)
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
                    console.log("[SERVER ERROR] Missing blockNumber 💀")
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
            case "getPeerTime":
                response = new Date().getTime()
                break

            // NOTE Don't look past here, go away
            // INFO For real, nothing here to be seen
            case "hots":
                console.log("[SERVER] Received hots")
                response = eggs.hots()
                break
            default:
                console.log("[SERVER] Received unknown message")
                // eslint-disable-next-line quotes
                response = '{ error: "Unknown message"}'
                break
        }
        return { extra, require_reply, response }
    }
}
