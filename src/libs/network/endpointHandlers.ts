/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// ! TODO Pay attention to the return types (RPCResponse)

import multichainCapabilities from "sdk/localsdk/multichain/types/multichainCapabilities"
import multichainDispatcher from "src/features/multichain/XMDispatcher"
import Chain from "src/libs/blockchain/chain"
import Mempool, { MempoolData } from "src/libs/blockchain/mempool"
import {
    broadcastVerifiedNativeTransaction,
    confirmTransaction,
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
import handleL2PS from "./routines/transactions/handleL2PS"
import { normalizeWebBuffers } from "src/libs/network/routines/normalizeWebBuffers"
import Sessions from "src/libs/network/routines/sessionManager"
import { Peer } from "src/libs/peer"
import { Blocks } from "src/model/entities/Blocks"
import sharedState from "src/utilities/sharedState"
import _, { chain } from "lodash"
// NOTE Terminal kit for useful logging
import terminalkit from "terminal-kit"

import {
    AddressInfo,
    BundleContent,
    ExecutionResult,
    IWeb2Payload,
    IWeb2Request,
    ValidityData,
    XMScript,
} from "@kynesyslabs/demosdk-http/types"

import GLS from "../blockchain/gls/gls"
import {
    NativePayload,
    StringifiedPayload,
    Web2Payload,
    XMPayload,
} from "node_modules/@kynesyslabs/demosdk-http/build/types/blockchain/Transaction"
import { StatusNative } from "src/model/entities/StatusNative"
import Block from "../blockchain/block"
import { BlockContent } from "../../../../sdks/src/types/blockchain/blocks"
import handleWeb2Request from "./routines/transactions/handleWeb2Request"
import getPeerInfo from "./routines/nodecalls/getPeerInfo"
import forge from "node-forge"
import PeerManager from "src/libs/peer/PeerManager"
import log from "src/utilities/logger"
import { ConsensusRequest, RPCResponse } from "@kynesyslabs/demosdk-http/types"
import { emptyResponse } from "./server_rpc"
import RepresentativeShard from "../consensus/mechanisms/types/RepresentativeShard"

let term = terminalkit.terminal

export default class ServerHandlers {
    

    
    // !SECTION Consensus Voting
    // ANCHOR Vote request

    static async handleVoteRequest(timestamp: number): Promise<RPCResponse> {
        console.log("[handleVoteRequest] Handling vote request with timestamp: ")
        console.log(timestamp)
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        // Todo : compare the received response response with what we have locally, and return the vote result
        console.log("[SERVERHANDLER] handleVoteRequest")
        const mempool = await Mempool.getMempool()

        // REVIEW Is this the right way to get the shard?
        var shard = sharedState.getInstance().shard // ! Why sometimes it is undefined?
        if (!shard) {
            console.log("[handleVoteRequest] Shard not found, generating...")
            let onlinePeers = await PeerManager.getInstance().getOnlinePeers()
            console.log("[handleVoteRequest] Online peers: " + onlinePeers)
            shard = await RepresentativeShard.getInstance().getShard(onlinePeers)
            console.log("[handleVoteRequest] Shard: " + shard)
        }
        console.log("[handleVoteRequest] Shard: " + shard)

        const { derivedBlock } = await deriveBlock(mempool, timestamp, shard)
        const proposedBlock = derivedBlock
        let proposedBlockHash = proposedBlock.hash
        console.log("[handleVoteRequest] Proposed block hash: " + proposedBlockHash)
        response.result = 200
        response.response = proposedBlockHash.trim()
        return response
    }

    // !SECTION Login On Chain

    // ANCHOR Validate transaction
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
    ): Promise<ExecutionResult> {
        let fname = "[handleExecuteTransaction] "
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

        console.log(
            "[SERVER] Received transaction for execution: " + queriedTx.hash,
        )

        // We need to have issued the validity data
        if (hexDataKey !== hexOurKey) {
            term.red.bold(
                fname + "Invalid validityData signature key (not us) 💀 : ",
            )

            result.success = false
            result.response = false
            result.extra = "Invalid signature key"
            return result
        }
        // Also the signature must be valid
        let hashedData = Hashing.sha256(JSON.stringify(validatedData.data))
        console.log(JSON.stringify(validatedData))
        console.log("Backend - Hash:", hashedData)
        console.log(
            "Backend - Data Signature:",
            Buffer.from(dataSignature as Buffer).toString("hex"),
        )
        console.log(
            "Backend - Data Key:",
            Buffer.from(dataKey as Buffer).toString("hex"),
        )
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
        let payload:
            | XMPayload
            | Web2Payload
            | NativePayload
            | StringifiedPayload
        switch (tx.content.type) {
            case "crosschainOperation":
            case "multichainOperation":
                payload = tx.content.data as XMPayload
                console.log("[Included XM Chainscript]")
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
                )

                // TODO Add result.success handling
                result.response = web2_result
                break
            case "native":
                // REVIEW This still works with the new tx system?
                var native_result = await broadcastVerifiedNativeTransaction(
                    validatedData,
                )
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
    static async handleXMChainOperation(
        xmscript: XMScript,
    ): Promise<RPCResponse> {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        /* NOTE This workflow goeas as:
         * The XM Operation is validated, executed and verified
         * when applicable.
         * A transaction is derived from the executed operation.
         * An operation is then created and pushed in the GLS.
         * An operation for the gas is also pushed it pn the GLS.
         * The tx is pushed in the mempool if applicable.
         */
        console.log("[XMChain] Handling XM Chain Operation...")
        // REVIEW Remember that crosschain operations can be in chainscript syntax
        // INFO Use the src/features/multichain/chainscript/chainscript.chs for the specs
        //console.log(content.data)
        response = await multichainDispatcher.digest(xmscript)
        // TODO
        return response
    }

    // INFO This method is used to allow signed data exchanges between peers and clients
    static async handleXMChainSignedPayload(content: any): Promise<any> {
        // TODO Probably to take out
    }

    static async handleXMChainStatus(): Promise<RPCResponse> {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        // NOTE Remember that crosschain operations are in chainscript syntax (see chainscript_example.ts)
        response.response = await multichainCapabilities()
        // TODO
        return response
    }

    // Proxy method for handleWeb2Request
    static async handleWeb2Request(
        content: IWeb2Request,
    ): Promise<RPCResponse> {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        response = await handleWeb2Request(content)
        return response
    }

    // Proxy method for handleL2PS
    static async handleL2PS(content: any): Promise<RPCResponse> {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        response = await handleL2PS(content)
        return response
    }

    static async handleConsensusRequest(
        request: ConsensusRequest,
    ): Promise<RPCResponse> {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        let senderIdentity = request.sender
        console.log("[SERVER] Received consensus request")
        console.log(
            "[SERVER] Peer identity information received: " +
                senderIdentity,
        )
        if (!sharedState.getInstance().consensusMode) {
            response.result = 400
            response.response = false
            response.extra = "We are not in consensus mode"
            return response
        }

        console.log("we are in consensus mode")

        let authorized = false
        let senderPublicKey = senderIdentity

        const { shard } = sharedState.getInstance()

        if (!shard) {
            response.result = 400
            response.response = false
            response.extra = "No shard found in shared state"
            return response
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
            response.result = 401
            response.response = false
            response.extra = "Not authorized"
            return response
        }

        switch (request.message) {
            case "getMempool":
                response.response = await Mempool.getMempool()
                //console.log(response)
                response.result = 200
                response.require_reply = false
                response.extra = "Mempool received"
                console.log("[SERVERHANDLER] Received mempool")
                return response

            default:
                response.result = 400
                response.response = false
                response.extra = "Unknown message"
                return response
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
        console.log("[handleMempool] Received a message")
        console.log(content)
        let extra: any
        let require_reply = false
        const response = await Mempool.receive(content.data as MempoolData)
        return { extra, require_reply, response }
    }

}
