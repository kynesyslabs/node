/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Pay attention to the return types (RPCResponse)

import Chain from "src/libs/blockchain/chain"
import Mempool from "src/libs/blockchain/mempool_v2"
import { confirmTransaction } from "src/libs/blockchain/routines/validateTransaction"
import Transaction from "src/libs/blockchain/transaction"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import handleL2PS from "./routines/transactions/handleL2PS"
import { getSharedState } from "src/utilities/sharedState"
import _ from "lodash"
import terminalKit from "terminal-kit"
import {
    ExecutionResult,
    ValidityData,
    XMScript,
    ConsensusRequest,
    RPCResponse,
    IWeb2Payload,
    GCREdit,
    SigningAlgorithm,
} from "@kynesyslabs/demosdk/types"
import PeerManager from "src/libs/peer/PeerManager"
import log from "src/utilities/logger"
import { emptyResponse } from "./server_rpc"
// SECTION Handlers for different types of transactions
import handleDemosWorkRequest from "./routines/transactions/demosWork/handleDemosWorkRequest"
import multichainDispatcher from "src/features/multichain/XMDispatcher" // ? Rename to handleXMRequest

// ? Note: this is to be implemented once demosWork is in place
import { DemoScript } from "@kynesyslabs/demosdk/types"
import { Peer } from "../peer"
import HandleGCR from "../blockchain/gcr/handleGCR"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import { SubnetPayload } from "@kynesyslabs/demosdk/l2ps"
import { L2PSMessage, L2PSRegisterTxMessage } from "../l2ps/parallelNetworks"
import { handleWeb2ProxyRequest } from "./routines/transactions/handleWeb2ProxyRequest"
import { parseWeb2ProxyRequest } from "../utils/web2RequestUtils"
import handleIdentityRequest from "./routines/transactions/handleIdentityRequest"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { IdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import { NativeBridgeOperationCompiled } from "@kynesyslabs/demosdk/bridge"
import handleNativeBridgeTx from "./routines/transactions/handleNativeBridgeTx"
import handleContractDeploy from "./routines/transactions/handleContractDeploy"
import handleContractCall from "./routines/transactions/handleContractCall"
/* // ! Note: this will be removed once demosWork is in place
import {
    NativePayload,
    StringifiedPayload,
    Web2Payload,
    XMPayload,
} from "@kynesyslabs/demosdk/types"
*/

const term = terminalKit.terminal

function isReferenceBlockAllowed(referenceBlock: number, lastBlock: number) {
    return (
        referenceBlock >= lastBlock - getSharedState.referenceBlockRoom &&
        referenceBlock <= lastBlock
    )
}

export default class ServerHandlers {
    // ANCHOR Validate transaction
    static async handleValidateTransaction(
        tx: Transaction,
        sender: string,
    ): Promise<ValidityData> {
        term.yellow("[handleTransactions] Handling a DEMOS tx...\n")
        const fname = "[handleTransactions] "
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
            validationData = await confirmTransaction(tx, sender)

            // NOTE Gas operation is created at this point (and balance is checked)
            // NOTE Nonce assignment is done in the GCR too
            // REVIEW Generating GCREdit on our side and comparing it with the one in the Transaction object
            // See DemosTransactions.ts -> prepare(data) for the details
            const gcrEdits = await GCRGeneration.generate(tx)
            // TODO This is a workaround, if it works we should make it more elegant
            // Client side the gcredits are created without the tx hash, which is added in the node
            // ! Maybe we should remove the tx hash from the GCREdit object directly which improves consistency
            gcrEdits.forEach((gcredit: GCREdit) => {
                gcredit.txhash = ""
            })
            // Hashing both the gcredits
            const gcrEditsHash = Hashing.sha256(JSON.stringify(gcrEdits))
            console.log("gcrEditsHash: " + gcrEditsHash)
            const txGcrEditsHash = Hashing.sha256(
                JSON.stringify(tx.content.gcr_edits),
            )
            console.log("txGcrEditsHash: " + txGcrEditsHash)
            const comparison = txGcrEditsHash == gcrEditsHash
            if (!comparison) {
                log.error("[handleValidateTransaction] GCREdit mismatch")
                console.log(txGcrEditsHash + " <> " + gcrEditsHash)
            }
            if (comparison) {
                log.info("[handleValidateTransaction] GCREdit hash match")
            } else {
                throw new Error("GCREdit mismatch")
            }
            // REVIEW Recalculate the Transaction hash too
            //tx.hash = Hashing.sha256(JSON.stringify(tx.content))

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
            const hashedValidationData = Hashing.sha256(
                JSON.stringify(validationData.data),
            )
            const signature = await ucrypto.sign(
                getSharedState.signingAlgorithm,
                new TextEncoder().encode(hashedValidationData),
            )

            validationData.signature = {
                type: getSharedState.signingAlgorithm,
                data: uint8ArrayToHex(signature.signature),
            }
        }

        term.bold.white(fname + "Transaction handled.")
        return validationData
    }

    // NOTE This method is used to handle the execution of a transaction
    // TODO Better typing for content (must contain validity data, hashing and signature as shown below)
    // TODO Either put this into a module or do something to make it more modular
    static async handleExecuteTransaction(
        validatedData: ValidityData,
        sender: string,
    ): Promise<ExecutionResult> {
        // Log the entire validatedData object to inspect its structure
        console.log("[handleExecuteTransaction] Validated Data:", validatedData)

        const fname = "[handleExecuteTransaction] "
        const result: ExecutionResult = {
            success: true,
            response: null,
            extra: null,
            require_reply: false,
        }
        // NOTE Content should contain validity data and our signature to proceed
        // Integrity checks
        // const ourKey = getSharedState.identity.ed25519.publicKey
        const ourKey = (
            await ucrypto.getIdentity(getSharedState.signingAlgorithm)
        ).publicKey

        log.debug("Our key: " + ourKey)
        const hexOurKey = uint8ArrayToHex(ourKey as Uint8Array)
        const queriedTx = _.cloneDeep(validatedData.data.transaction) // dataManipulation.copyCreate(validatedData.data.transaction)
        // REVIEW Correct? If the transaction has no block number, we set it to the last block number + 1
        if (!queriedTx.blockNumber) {
            log.warning(
                "[handleExecuteTransaction] Queried tx has no block number: " +
                    queriedTx.hash,
            )
            const lastBlockNumber = await Chain.getLastBlockNumber()
            queriedTx.blockNumber = lastBlockNumber + 1
            log.warning(
                "[handleExecuteTransaction] Queried tx block number set to: " +
                    queriedTx.blockNumber,
            )
        }
        console.log(
            "[handleExecuteTransaction] Queried tx processing in block: " +
                queriedTx.blockNumber,
        )

        // We need to have issued the validity data
        if (validatedData.rpc_public_key.data !== hexOurKey) {
            term.red.bold(
                fname + "Invalid validityData signature key (not us) 💀 : ",
            )

            result.success = false
            result.response = false
            result.extra = "Invalid signature key"
            return result
        }
        // Also the signature must be valid

        const hashedData = Hashing.sha256(JSON.stringify(validatedData.data))
        const signatureValid = await ucrypto.verify({
            algorithm: validatedData.signature.type as SigningAlgorithm,
            message: new TextEncoder().encode(hashedData),
            publicKey: hexToUint8Array(
                validatedData.rpc_public_key.data,
            ) as any,
            signature: hexToUint8Array(validatedData.signature.data) as any,
        })

        if (!signatureValid) {
            log.error(
                "[handleExecuteTransaction] Invalid validityData signature: " +
                    validatedData.signature.data +
                    " - " +
                    validatedData.rpc_public_key.data,
            )
            result.success = false
            result.response = false
            result.extra = "Invalid signature"
            return result
        }
        // Finally, the block number reference must be valid
        const blockNumber = validatedData.data.reference_block
        const lastBlockNumber = await Chain.getLastBlockNumber()

        if (!isReferenceBlockAllowed(blockNumber, lastBlockNumber)) {
            log.error(
                "[handleExecuteTransaction] Invalid validityData block reference: " +
                    blockNumber +
                    " - " +
                    lastBlockNumber,
            )
            result.success = false
            result.response = false
            result.extra = "Invalid block reference"
            return result
        }
        // REVIEW Is this useful at this point?
        if (!validatedData.data.valid) {
            // An invalid transaction won't even be added to the mempool
            log.error(
                "[handleExecuteTransaction] Invalid validityData: " +
                    validatedData.data.message,
            )
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
        const tx = _.cloneDeep(validatedData.data.transaction) // dataManipulation.copyCreate(validatedData.data.transaction)
        // Using a payload variable to be able to check types immediately
        let payload: DemoScript | any // ! Remove this once demosWork is in place
        switch (tx.content.type) {
            // SECTION Legacy code
            // NOTE This is to be removed once demosWork is in place, but is crucial for now
            case "crosschainOperation":
                payload = tx.content.data
                console.log("[Included XM Chainscript]")
                console.log(payload[1])
                // TODO Better types on answers
                var xmResult = await ServerHandlers.handleXMChainOperation(
                    payload[1] as XMScript,
                )
                // TODO Add result.success handling
                result.response = xmResult
                break

            case "subnet":
                payload = tx.content.data
                console.log(
                    "[handleExecuteTransaction] Subnet payload: " + payload[1],
                )
                var subnetResult = await ServerHandlers.handleSubnetTx(
                    payload[1] as SubnetPayload,
                )
                result.response = subnetResult
                break

            case "web2Request": {
                payload = tx.content.data[1] as IWeb2Payload
                const web2Result = await ServerHandlers.handleWeb2Request(
                    payload,
                )
                result.response = web2Result
                break
            }
            // ! SECTION End of legacy code

            case "demoswork":
                var demosWorkPayload = tx.content.data
                var demosWorkScript = demosWorkPayload[1] as DemoScript
                try {
                    const demosWorkResult = await handleDemosWorkRequest(
                        demosWorkScript,
                    )
                    result.response = demosWorkResult
                } catch (e) {
                    log.error(
                        "[handleExecuteTransaction] Error in demosWork: " + e,
                    )
                    result.success = false
                    result.response = e
                    result.extra = "Error in demosWork"
                }
                break

            case "native":
                // INFO: Just update the response text
                result.response = {
                    message: "Transaction applied, waiting for confirmation",
                }
                result.success = true
                break

            case "identity":
                try {
                    const identityResult = await handleIdentityRequest(
                        tx,
                        sender,
                    )
                    const status = identityResult.success
                        ? "applied"
                        : "not applied"

                    result.success = identityResult.success
                    result.extra = {
                        message:
                            identityResult.message + `. Transaction ${status}.`,
                    }
                } catch (e) {
                    console.error(e)
                    log.error("[handleverifyPayload] Error in identity: " + e)
                    result.success = false
                    result.response = {
                        message: "Failed to verify signature",
                    }
                    result.extra = {
                        error: e.toString(),
                    }
                }
                break

            case "nativeBridge":
                payload = tx.content.data
                var nativeBridgeResult = await handleNativeBridgeTx(
                    payload[1] as NativeBridgeOperationCompiled,
                )
                if (nativeBridgeResult === null) {
                    result.success = false
                    result.response = false
                    result.extra = {
                        error: "Failed to handle native bridge transaction",
                    }
                }
                result.response = nativeBridgeResult
                break

            case "contractDeploy":
                try {
                    payload = tx.content.data
                    const contractDeployResult = await handleContractDeploy(
                        payload[1],
                        sender,
                    )
                    result.success = contractDeployResult.success
                    result.response = {
                        message: contractDeployResult.message,
                        contractAddress: contractDeployResult.contractAddress,
                        deploymentFee: contractDeployResult.deploymentFee?.toString(),
                    }
                    if (!contractDeployResult.success) {
                        result.extra = {
                            error: contractDeployResult.error,
                        }
                    }
                } catch (e) {
                    log.error("[handleExecuteTransaction] Error in contractDeploy: " + e)
                    result.success = false
                    result.response = {
                        message: "Contract deployment failed",
                    }
                    result.extra = {
                        error: e.toString(),
                    }
                }
                break

            case "contractCall":
                try {
                    payload = tx.content.data
                    const contractCallResult = await handleContractCall(
                        payload[1],
                        sender,
                    )
                    result.success = contractCallResult.success
                    result.response = {
                        message: contractCallResult.message,
                        result: contractCallResult.result,
                        gasUsed: contractCallResult.gasUsed?.toString(),
                    }
                    if (!contractCallResult.success) {
                        result.extra = {
                            error: contractCallResult.error,
                        }
                    }
                } catch (e) {
                    log.error("[handleExecuteTransaction] Error in contractCall: " + e)
                    result.success = false
                    result.response = {
                        message: "Contract call failed",
                    }
                    result.extra = {
                        error: e.toString(),
                    }
                }
                break
        }

        // Only if the transaction is valid we add it to the mempool
        if (result.success) {
            // REVIEW Simulating gcr edits application as we will apply them in the consensus
            const simulate = true
            // NOTE We apply the GCREdit to the GCR and check if it is successful. If not, we return an error
            const editsResults = await HandleGCR.applyToTx(
                queriedTx,
                false, // isRollback
                simulate,
            )

            if (!editsResults.success) {
                log.error("[handleExecuteTransaction] Failed to apply GCREdit")
                result.success = false
                result.response = false
                result.extra = {
                    error: "Failed to apply GCREdit: " + editsResults.message,
                }

                return result
            }

            // We add the transaction to the mempool
            console.log(
                "[handleExecuteTransaction] Adding tx with hash: " +
                    queriedTx.hash +
                    " to the mempool",
            )
            try {
                const { confirmationBlock, error } =
                    await Mempool.addTransaction({
                        ...queriedTx,
                        reference_block: validatedData.data.reference_block,
                    })

                console.log(
                    "[handleExecuteTransaction] Transaction added to mempool",
                )

                if (error) {
                    result.success = false
                    result.response = {
                        message: "Failed to add transaction to mempool",
                    }
                }

                // INFO: Add block confirmation number
                result.extra = {
                    ...(result.extra ? result.extra : {}),
                    confirmationBlock,
                    ...(error ? { error } : {}),
                }
            } catch (e) {
                result.success = false
                result.response = false
                result.extra = {
                    message: "Failed to add transaction to mempool",
                }

                log.error(
                    "[handleExecuteTransaction] Failed to add transaction to mempool: " +
                        e,
                )
            }
        }

        // Response is then sent back automatically as a reply (with our validation)
        // Returning the state of the transaction including operations
        return result
    }

    // INFO Handling Web2 Request
    static async handleWeb2Request(
        rawPayload: IWeb2Payload,
    ): Promise<RPCResponse> {
        const params = parseWeb2ProxyRequest(rawPayload)

        return await handleWeb2ProxyRequest(params)
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
         * An operation is then created and pushed in the GCR.
         * An operation for the gas is also pushed it pn the GCR.
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

    // Proxy method for handleDemosWorkRequest
    static async handleDemosWorkRequest(content: DemoScript) {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        response = await handleDemosWorkRequest(content)
        return response
    }

    // NOTE If we receive a SubnetPayload, we use handleL2PS to register the transaction
    static async handleSubnetTx(content: SubnetPayload) {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        const payload: L2PSRegisterTxMessage = {
            type: "registerTx",
            data: {
                uid: content.uid,
                encryptedTransaction: content.data,
            },
            extra: "register",
        }
        response = await handleL2PS(payload)
        return response
    }

    // Proxy method for handleL2PS, used for non encrypted L2PS Calls
    // TODO Implement this in server_rpc, this is not a tx
    static async handleL2PS(content: L2PSMessage): Promise<RPCResponse> {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        // REVIEW Refuse registerTx calls as they are managed in endpointHandlers.ts
        if (content.type === "registerTx") {
            response.result = 400
            response.response = false
            response.extra = "registerTx calls should be sent in a Transaction"
            return response
        }
        // REVIEW Refuse registerAsPartecipant calls as they are managed in endpointHandlers.ts
        if (content.type === "registerAsPartecipant") {
            response = await handleL2PS(content)
            return response
        }
    }

    static async handleConsensusRequest(
        request: ConsensusRequest,
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        const senderIdentity = request.sender
        //console.log("[SERVER] Received consensus request")
        /*console.log(
            "[SERVER] Peer identity information received: " +
                senderIdentity,
        )*/
        if (!getSharedState.consensusMode) {
            log.error("[endpointHandlers] We are not in consensus mode")
            response.result = 400
            response.response = false
            response.extra =
                "We are not in consensus mode (and you are using the old consensus mechanism)"
            return response
        }

        //console.log("we are in consensus mode")

        let authorized = false
        const senderPublicKey = senderIdentity

        const { shard } = getSharedState

        if (!shard) {
            log.error("[endpointHandlers] No shard found in shared state")
            response.result = 400
            response.response = false
            response.extra = "No shard found in shared state"
            return response
        }
        //console.log("[SERVERHANDLER] Shard found in shared state")
        //console.log(shard)

        const peerList = shard

        // Authorizing the sender
        for (const peer of peerList) {
            if (peer.identity === senderPublicKey) {
                authorized = true
                break
            }
        }

        // Return error if not authorized
        if (!authorized) {
            log.error("[endpointHandlers] Not authorized")
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
                //console.log("[SERVERHANDLER] Received mempool")
                return response

            default:
                log.error("[endpointHandlers] Unknown message")
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
        const requireReply = false
        const response = "Not Yet Implemented"
        return { extra, requireReply, response }
    }

    static async handleStorage(): Promise<any> {
        // Basic storage handling logic
        // ...
        const extra = { storageState: "mocked" }
        const requireReply = true
        const response = {}
        return { extra, requireReply, response }
    }

    static async handleMempool(content: any): Promise<any> {
        // Basic message handling logic
        // ...
        log.info("[handleMempool] Received a message")
        log.info(content)
        let response = {
            success: false,
            mempool: [],
        }

        try {
            response = await Mempool.receive(content.data as Transaction[])
        } catch (error) {
            console.error(error)
        }

        const ourId = getSharedState.publicKeyHex
        const ourDate = new Date().toISOString()

        return {
            result: response.success ? 200 : 400,
            response: response.mempool,
            extra:
                (response.success ? "Mempool received" : "Mempool not merged") +
                ` by: ${ourId} at ${ourDate}`,
            requireReply: false,
        }
    }

    // REVIEW Add a method to handle the reception of a peerlist
    static async handlePeerlist(content: Peer[]): Promise<any> {
        // Basic peerlist handling logic
        const ourPeerList = PeerManager.getInstance().getPeers()
        // Create a new peerlist with only unique peers (readable)
        const mergedPeerList: Peer[] = []
        for (const peer of content) {
            if (!mergedPeerList.includes(peer)) {
                mergedPeerList.push(peer)
            }
        }
        // Order the peerlist by alphanumeric
        const orderedPeerList = mergedPeerList.sort((a, b) =>
            a.identity.localeCompare(b.identity),
        )
        // Set the peerlist to the peer manager and discard the current one
        PeerManager.getInstance().setPeers(orderedPeerList, true)
        const extra = { peerlistState: "merged" }
        const requireReply = false
        const response = true
        return { extra, requireReply, response }
    }
}
