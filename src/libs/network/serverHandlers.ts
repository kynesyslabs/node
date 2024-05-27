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
import {
    broadcastVerifiedNativeTransaction, confirmTransaction,
} from "src/libs/blockchain/routines/validateTransaction"
import Transaction from "src/libs/blockchain/transaction"
import deriveBlock from "src/libs/consensus/routines/deriveBlock"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import eggs from "src/libs/network/routines/eggs"
import getBlockByHash from "src/libs/network/routines/nodecalls/getBlockByHash"
import getBlockByNumber from "src/libs/network/routines/nodecalls/getBlockByNumber"
import getBlockHeaderByHash from "src/libs/network/routines/nodecalls/getBlockHeaderByHash"
import getBlockHeaderByNumber from "src/libs/network/routines/nodecalls/getBlockHeaderByNumber"
import getPeerlist from "src/libs/network/routines/nodecalls/getPeerlist"
import getPreviousHashFromBlockHash from "src/libs/network/routines/nodecalls/getPreviousHashFromBlockHash"
import getPreviousHashFromBlockNumber from "src/libs/network/routines/nodecalls/getPreviousHashFromBlockNumber"
import { normalizeWebBuffers } from "src/libs/network/routines/normalizeWebBuffers"
import Sessions from "src/libs/network/routines/sessionManager"
import { BrowserRequest } from "src/libs/network/serverListeners"
import { Peer } from "src/libs/peer"
import { Blocks } from "src/model/entities/Blocks"
import sharedState from "src/utilities/sharedState"
import _ from "lodash"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

import {
    AddressInfo, ExecutionResult, IWeb2Payload, IWeb2Request, ValidityData,
    XMScript,
} from "@kynesyslabs/demosdk/types"

import GLS from "../blockchain/gls/gls"
import { NativePayload, StringifiedPayload, Web2Payload, XMPayload } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/Transaction"
import { StatusNative } from "src/model/entities/StatusNative"

let term = terminalkit.terminal

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
        let validationData: ValidityData
        try {
            /* NOTE This workflow goeas as:
             * The transaction is validated
             * A gas operation is created and is sent back alongside the validation data
             * TODO Add signatures to validation data
             * The validation data can be used by the client to effectively execute the tx
             */
            //console.log(fname + "Validating transaction...")
            validationData = await confirmTransaction(tx)
            //console.log(fname + "Fetching result...")
        } catch (e) {
            term.red.bold("[TX VALIDATION ERROR] 💀 : ")
            term.red(e)
            validationData = {
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
                JSON.stringify(validationData.data),
            )
            validationData.signature = Cryptography.sign(
                hashedValidationData,
                sharedState.getInstance().identity.ed25519.privateKey,
            )
        }

        term.bold.white(fname + "Transaction handled.")
        return validationData
    }

    // NOTE This method is used to handle the execution of a transaction
    // TODO Better typing for content (must contain validity data, hashing and signature as shown below)
    // TODO Either put this into a module or do something to make it more modular
    static async handleExecuteTransaction(
        validatedData: ValidityData,
        senderSocket: any,
    ): Promise<ExecutionResult> {

        let fname =     "[handleExecuteTransaction] "
        let result: ExecutionResult = {
            success: true,
            response: null,
            extra: null,
            require_reply: false,
        }
        // NOTE Content should contain validity data and our signature to proceed
        // Integrity checks
        let ourKey = sharedState.getInstance().identity.ed25519.publicKey
        let hexOurKey = ourKey.toString("hex")
        let dataKey = validatedData.rpc_public_key
        let hexDataKey = Buffer.from(dataKey as Buffer).toString("hex")
        let dataSignature = validatedData.signature
        let queriedTx = _.cloneDeep(validatedData.data.transaction) // dataManipulation.copyCreate(validatedData.data.transaction)

        // queriedTx.content.from = queriedTx?.content?.from?.toString()
        // queriedTx.content.from = queriedTx?.content?.to?.toString()

        console.log("[SERVER] Received transaction for execution: " + queriedTx.hash)

        // We need to have issued the validity data
        if (hexDataKey !== hexOurKey) {
            term.red.bold(fname + "Invalid validityData signature key (not us) 💀 : ")

            result.success = false
            result.response = false
            result.extra = "Invalid signature key"
            return result

        }
        // Also the signature must be valid
        let hashedData = Hashing.sha256(JSON.stringify(validatedData.data))
        console.log(JSON.stringify(validatedData))
        console.log("Backend - Hash:", hashedData)
        console.log("Backend - Data Signature:", Buffer.from(dataSignature as Buffer).toString("hex"))
        console.log("Backend - Data Key:", Buffer.from(dataKey as Buffer).toString("hex"))
        let signatureValid = Cryptography.verify(
            hashedData,
            dataSignature,
            dataKey,
        )
        if (!signatureValid) {
            term.red.bold(fname + "Invalid validityData signature 💀 : ")
            result.success = false
            result.response = false
            result.extra = "Invalid signature"
            return result
        }
        // Finally, the block number reference must be valid
        let blockNumber = validatedData.data.reference_block
        let lastBlockNumber = await Chain.getLastBlockNumber()
        if (blockNumber != lastBlockNumber) {
            term.red.bold(fname + "Invalid validityData block reference 💀 : ")
            result.success = false
            result.response = false
            result.extra = "Invalid block reference"
            return result
        }
        // REVIEW Is this useful at this point?
        if (!validatedData.data.valid) {
            // An invalid transaction won't even be added to the mempool
            term.yellow.bold(fname + "Invalid validityData 💀 : ")
            console.log(validatedData.data.message)
            result.success = false
            result.response = false
            result.extra = validatedData.data.message
            return result
        }

        /* NOTE
                    We just processed the cryptographic validity of the transaction.
                    We will now try to execute it obtaining valid Operations.
                */
        term.green.bold(fname + "Valid validityData! \n")
        // REVIEW Switch case for different types of transactions
        let tx = _.cloneDeep(validatedData.data.transaction) // dataManipulation.copyCreate(validatedData.data.transaction)
        // Using a payload variable to be able to check types immediately
        let payload: XMPayload | Web2Payload | NativePayload | StringifiedPayload
        switch (tx.content.type) {
            case "crosschainOperation":
            case "multichainOperation":
                payload = tx.content.data as XMPayload
                console.log(
                    "[Included XM Chainscript]")
                console.log(payload[1])
                // TODO Better types on answers
                var xm_result = await ServerHandlers.handleXMChainOperation(
                    payload[1] as XMScript,
                )
                // TODO Add result.success handling
                result.response = xm_result
                break
            case "web2Request":
                // TODO Better types on answers
                payload = tx.content.data as Web2Payload
                var web2_result = await ServerHandlers.handleWeb2Request(
                    payload[1] as IWeb2Request,
                    senderSocket,
                )
                
                // TODO Add result.success handling
                result.response = web2_result
                break
            case "native":
                // REVIEW This still works with the new tx system?
                var native_result = await broadcastVerifiedNativeTransaction(validatedData)
                // NOTE We add the Transaction to the mempool as it looks valid
                if (native_result[0]) {
                    result.success = true
                }
                // REVIEW Check if this is ok with types
                result.response = native_result
        }
        // Only if the transaction is valid we add it to the mempool
        if (result.success) {
            // REVIEW We add the transaction to the mempool
            Mempool.addTransaction(queriedTx)
            // TODO Check if Operation(s) are added to the GLS too
            // FIXME Add an operation for the nonce or anyway a way to manage the nonce
        }
        // TODO Broadcast the tx to the other peers (or maybe not, consensus should take care of it)
        // Response is then sent back automatically as a reply (with our validation)
        // Returning the state of the transaction including operations
        return result
    }

    // INFO Handling XM Transaction
    static async handleXMChainOperation(xmscript: XMScript): Promise<any> {
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
        // TODO Probably to take out
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
        content: IWeb2Request,
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

        let extra: string,
            require_reply = false
        let response: IWeb2Request
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
            response = fullResponse[1] as IWeb2Request
        } else {
            response = null
            extra = fullResponse[1] as string
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
    // FIXME Pls modularize me! Don't leave me alone!
    // REVIEW The method is scared: please modularize it!
    // NOTE As you can see, this method is a mess. Please modularize it.
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
        let { data } = content
        //console.log(typeof data)
        console.log(JSON.stringify(content))
        switch (content.message) {
            // NOTE The following commented block of code is vestigial
            /*case "crosschain_operation":
            case "multichain_operation":
                term.yellow.bold("[SERVER] Received crosschain_operation\n")
                response = await ServerHandlers.handleXMChainOperation(content)
                break // REVIEW Here or in comlinks? */
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
                console.log(`get block by number ${data.blockNumber}`)
                result = await getBlockByNumber(data)
                response = result.response
                extra = result.extra
                break
            case "getBlockByHash":
                console.log(`get block by hash ${data.hash}`)
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
                console.log(`getting tx with hash ${data.hash}`)
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
                nStat = await GLS.getGLSNativeStatus(data.address) as StatusNative
                response = nStat.toString() // REVIEW It works ?
                break
            case "getAddressNonce":
                if (!data.address) {
                    receiver.emit("public", {
                        error: "No address specified",
                    })
                }
                nStat = await GLS.getGLSNativeStatus(data.address) as StatusNative
                response = nStat.nonce
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
