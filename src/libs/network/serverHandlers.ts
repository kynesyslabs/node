/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import multichainCapabilities from "sdk/localsdk/multichain/types/multichainCapabilities"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import handleWeb2 from "src/features/web2/Web2Dispatcher"
import Chain from "src/libs/blockchain/chain"
import Mempool from "src/libs/blockchain/mempool"
import { Peer } from "src/libs/peer"
import { Blocks } from "src/model/entities/Blocks"
import sharedState from "src/utilities/sharedState"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

import GLS from "../blockchain/gls/gls"
import {
    ValidityData,
    validateTransaction,
    executeVerifiedNativeTransaction,
} from "../blockchain/routines/validateTransaction"
import Transaction from "../blockchain/transaction"
import AddressInfo from "../blockchain/types/addressInfo"
import deriveBlock from "../consensus/routines/deriveBlock"
import eggs from "./routines/eggs"
import getPreviousHashFromBlockNumber from "./routines/nodecalls/getPreviousHashFromBlockNumber"
import { normalizeWebBuffers } from "./routines/normalizeWebBuffers"
import Sessions from "./routines/sessionManager"
import { BrowserRequest } from "./serverListeners"
import getPeerlist from "./routines/nodecalls/getPeerlist"
import getPreviousHashFromBlockHash from "./routines/nodecalls/getPreviousHashFromBlockHash"
import getBlockHeaderByHash from "./routines/nodecalls/getBlockHeaderByHash"
import getBlockHeaderByNumber from "./routines/nodecalls/getBlockHeaderByNumber"
import getBlockByNumber from "./routines/nodecalls/getBlockByNumber"
import getBlockByHash from "./routines/nodecalls/getBlockByHash"
import Hashing from "../crypto/hashing"
import Cryptography from "../crypto/cryptography"
import required from "src/utilities/required"
import { Operation } from "../blockchain/gls/gls"
import { IWeb2Payload } from "src/features/web2/types/Web2Types"

let term = terminalkit.terminal

interface ExecutionResult {
    response: any
    extra: any
    require_reply: boolean
    operations?: Operation[]
}

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

        const { derivedBlock } = await deriveBlock(mempool, timestamp)
        const proposedBlock = derivedBlock
        let proposedBlockHash = proposedBlock.hash
        return proposedBlockHash
    }

    // !SECTION Login On Chain

    // ANCHOR Comlinks
    static async handleValidateTransaction(
        tx: Transaction,
    ): Promise<ValidityData> {
        term.yellow("[handleTransactions] Handling a DEMOS tx...\n")
        let fname = "[handleTransactions] "
        term.yellow(fname + "Handling transaction...")
        // Verify and execute the transaction
        let validatedTx: ValidityData
        try {
            /* NOTE This workflow goeas as:
             * The transaction is validated
             * A gas operation is created and is sent back alongside the validation data
             * TODO Add signatures to validation data
             * The validation data can be used by the client to effectively execute the tx
             */
            //console.log(fname + "Validating transaction...")
            validatedTx = await validateTransaction(tx)
            //console.log(fname + "Fetching result...")
        } catch (e) {
            term.red.bold("[TX VALIDATION ERROR] 💀 : ")
            term.red(e)
            validatedTx = {
                data: {
                    valid: false,
                    reference_block: null,
                    message:
                        "An error occurred while validating the transaction",
                    gas_operation: null,
                    transaction: null,
                },
                signature: null,
                rpc_public_key: null,
            }
            // Signing and hashing the validation data
            let hashedValidationData = Hashing.sha256(
                JSON.stringify(validatedTx.data),
            )
            validatedTx.signature = Cryptography.sign(
                hashedValidationData,
                sharedState.getInstance().identity.ed25519.privateKey,
            )
        }

        term.bold.white(fname + "Transaction handled.")
        return validatedTx
    }

    // NOTE This method is used to handle the execution of a transaction
    // TODO Better typing for content (must contain validity data, hashing and signature as shown below)
    static async handleExecuteTransaction(
        validatedData: ValidityData,
        senderSocket: any,
    ): Promise<ExecutionResult> {
        let fname = "[handleExecuteTransaction] "
        let result: ExecutionResult = {
            response: null,
            extra: null,
            require_reply: false,
        }
        // NOTE Content should contain validity data and signature to proceed
        // FIXME Add signature + public key checks
        // Returning an appropriate response
        if (!validatedData.data.valid) {
            // An invalid transaction won't even be added to the mempool
            term.yellow.bold(fname + "Invalid transaction 💀 : ")
            console.log(validatedData.data.message)
            result.response = false
            result.extra = validatedData.data.message
            return result
        }

        /* NOTE
                    We just processed the cryptographic validity of the transaction.
                    We will now try to execute it obtaining valid Operations.
                */
        term.green.bold(fname + "Valid transaction! ")
        // REVIEW Switch case for different types of transactions
        let tx = validatedData.data.transaction
        // TODO Decide if the toMempool and Mempool.addTransaction should be here or in their dispatchers
        // TODO Preferably here, unified, with the dispatchers having standard replies
        switch (tx.content.type) {
            case "crosschain_operation":
            case "multichain_operation":
                console.log(
                    "[Included XM Chainscript]" +
                        JSON.stringify(tx.content.data[1]) +
                        "\n\n",
                )
                // TODO Better types on answers
                var xm_result = await ServerHandlers.handleXMChainOperation(
                    tx.content.data[1],
                )
                result.response = xm_result
                break
            case "web2Request":
                // TODO Better types on answers
                var web2_result = await ServerHandlers.handleWeb2Request(
                    JSON.parse(tx.content.data[1]) as IWeb2Payload,
                    senderSocket,
                )
                result.response = web2_result
                break
            case "native":
                var native_result = executeVerifiedNativeTransaction(validatedData)
                // NOTE We add the Transaction to the mempool as it looks valid
                if (native_result[0]) {
                    console.log(fname + "Adding transaction to mempool...")
                    // Adding the valid tx to the mempool
                    // REVIEW is this done here or by executing the transaction above?
                    Mempool.addTransaction(validatedData.data.transaction) // Works by writing the registry
                    //process.exit(0) /* TODO Eliminate this debug line */
                }
                // REVIEW Check if this is ok with types
                result.response = native_result
        }
        // TODO Broadcast the tx to the other peers
        // Response is then sent back automatically as a reply (with our validation)
        // Returning the state of the transaction including operations
        return result
    }

    // INFO Handling XM Transaction
    static async handleXMChainOperation(xmscript: any): Promise<any> {
        /* NOTE This workflow goeas as:
         * The XM Operation is validated, executed and verified
         * when applicable.
         * A transaction is derived from the executed operation.
         * An operation is then created and pushed in the GLS.
         * An operation for the gas is also pushed it pn the GLS.
         * The tx is pushed in the mempool if applicable.
         */
        let extra: any
        let require_reply = false
        console.log("[XMChain] Handling XM Chain Operation...")
        // REVIEW Remember that crosschain operations can be in chainscript syntax
        // INFO Use the src/features/multichain/chainscript/chainscript.chs for the specs
        //console.log(content.data)
        let response = await multichainDispatcher.digest(xmscript)
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
        content: IWeb2Payload,
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
        //console.log(JSON.stringify(request))

        let extra: any,
            require_reply = false
        let response: unknown
        // We get our connection string
        // const currentPeerString = Identity.getInstance().getConnectionString()
        // NOTE Switched to the new class

        //console.log("[WEB2 CONTENT DUMP]")
        //console.log(content)
        let fullResponse = await handleWeb2(content, senderSocket)
        //console.log("[WEB2 CONTENT RESPONSE DUMP]")
        //console.log(fullResponse)

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
        console.log("[SERVER] Peer identity information received")
        //console.log(senderIdentity)
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
        //console.log(shard)

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
                //console.log(response)
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

    // TODO Make this modular ffs
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
            | Blocks
            | Transaction
            | Transaction[]
            | AddressInfo
        let result: any // Storage for the result
        let nStat: any // Storage for the native status
        let socketized_response: Peer[]
        let { data } = content
        //console.log(typeof data)
        //console.log(JSON.stringify(content))
        switch (content.message) {
            case "crosschain_operation":
            case "multichain_operation":
                term.yellow.bold("[SERVER] Received crosschain_operation\n")
                response = await ServerHandlers.handleXMChainOperation(content)
                break // REVIEW Here or in comlinks?
            case "getPeerlist":
                response = await getPeerlist()
                break
            // REVIEW Both below for getting the last hash (untested yet)
            case "getPreviousHashFromBlockNumber":
                result = await getPreviousHashFromBlockNumber(data)
                response = result.response
                extra = result.extra
                break
            case "getPreviousHashFromBlockHash":
                result = await getPreviousHashFromBlockHash(data)
                response = result.response
                extra = result.extra
                break
            // REVIEW (untested) Headers instead of full blocks
            case "getBlockHeaderByNumber":
                result = await getBlockHeaderByNumber(data)
                response = result.response
                extra = result.extra
                break
            case "getBlockHeaderByHash":
                result = await getBlockHeaderByHash(data)
                response = result.response
                extra = result.extra
                break
            case "getLastBlockNumber":
                console.log("[SERVER] Received getLastBlockNumber")
                response = await Chain.getLastBlockNumber()
                console.log("[CHAIN.ts] Received reply from the database") // REVIEW Debug
                //console.log(response)
                break
            case "getLastBlockHash":
                response = await Chain.getLastBlockHash()
                break
            case "getBlockByNumber":
                result = await getBlockByNumber(data)
                response = result.response
                extra = result.extra
                break
            case "getBlockByHash":
                result = getBlockByHash(data)
                response = result.response
                extra = result.extra
                break
            case "getTxByHash":
                if (!data.hash) {
                    receiver.emit("public", {
                        error: "No tx specified",
                    })
                }
                response = await Chain.getTxByHash(data.hash)
                break
            case "getMempool":
                response = await Chain.getPendingPool()
                break
            // INFO Authentication listener
            case "getPeerIdentity":
                // NOTE We don't need to sign anything as the comlink is signed already
                response = "I am " + id_ed25519.publicKey.toString("hex")
                //console.log(response)
                break

            // INFO Address info endpoint
            case "getAddressInfo":
                if (!data.address) {
                    receiver.emit("public", {
                        error: "No address specified",
                    })
                }
                nStat = await GLS.getGLSNativeStatus(data.address)
                response = nStat.toString() // REVIEW It works ?
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

        // REVIEW Unified error handling
        if (response === "error") {
            receiver.emit("error", {
                error: extra,
                muid: content.muid,
            })
        }
        // REVIEW Is this ok? Follow back and see
        return { extra, require_reply, response }
    }
}
