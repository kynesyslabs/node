/* eslint-disable no-unused-vars */
import ComLink from "../communications/comlink"
import ComLinkUtils from "../communications/comlinkUtils"
import { Identity } from "../identity"
import { Peer } from "../peer"
import Transmission from "../communications/transmission"
import Transaction from "../blockchain/transaction"
import { Operation } from "../blockchain/routines/executeOperations"
import Mempool from "../blockchain/mempool"
import GLS from "../blockchain/gls/gls"
import sharedState from "src/utilities/sharedState"
import ResponseRegistry from "../communications/responseRegistry"

// INFO Compose, sign and send a signed comlink chain easily
export async function remoteCall(receiver: any, // While is preferable to have an hex string we can use anything here 
                                 peer: Peer, 
                                 message: string, 
                                 type: string = "nodeCall",
                                 requireReply: boolean = false,
                                 isReply: boolean = false)
                                 : Promise<[boolean, any]> {
    let {identity} = sharedState.getInstance()
    // Initialize the comlink
    let _comlink = new ComLink()
    // Generate the transmission
    let _askMessage = new Transmission(identity.ed25519.privateKey)
    _askMessage.initialize(
        "nodeCall",
        message,
        identity.ed25519.publicKey,
        receiver,
        null,
        null,
    )
    // Hash and sign it
    await _askMessage.finalize()
    // Putting the message into a new comlink
    console.log(
        "[SYNC] Asking " +
            peer.socket.id +
            " for the last block at " +
            peer.connectionString,
    )
    // Preparing for a response
    _comlink.properties.require_reply = true
    _comlink.properties.is_reply = false

    // Propagating the responseRegistry actual status
    ResponseRegistry.getInstance().requestResponse(_comlink)

    // Ask for the last block
    await _comlink.broadcastMessageToPeer(
        peer,
        _askMessage,
        identity.ed25519.privateKey,
    )

    // Get out the response promise
    let responsePromise = ResponseRegistry.getInstance().checkResponse(
        _comlink.muid,
    )
    return responsePromise
}

// INFO Deriving a mempool operation from a given data by deriving a tx and the corresponding mempool operation
export async function deriveMempoolOperation(
    data: any,
    insert: boolean = true,
): Promise<any> {
    // Sanity check
    if (typeof(data) !== "string") {
        try {
            data = JSON.stringify(data)
        } catch (e) {
            console.log(e)
            return false
        }
    }
    // We should have a valid, attested request: lets handle it
    let derivedTx: Transaction
    let derivedOperation: Operation
    // Deriving a transaction
    derivedTx = await createTransaction(data)
    console.log("Derived tx:")
    console.log(derivedTx)
    // Deriving an operation from the tx
    derivedOperation = await createOperation(derivedTx)
    console.log("Derived operation:")
    console.log(derivedOperation)
    if (insert) {
        // Inserting the operation in the next mempool session with the proper data
        Mempool.addTransaction(derivedTx)
        // And we do the same for the derived operation in the GLS
        GLS.getInstance().operations.push(derivedOperation)
    }
    return derivedOperation
}

export async function createOperation(transaction: Transaction): Promise<Operation> {
    let operation: Operation = {
        operator: null,
        actor: null,
        params: null,
        hash: null,
        nonce: null,
        timestamp: null,
        status: "pending",
        fees: {
            network_fee: null,
            rpc_fee: null,
            additional_fee: null,
        },
    }
    // TODO
    return operation
}

export async function createTransaction(
    data: any,
): Promise<Transaction> {
    let transaction: Transaction = {
        content: {
            type: null,
            from: null,
            to: null,
            amount: null,
            data: ["content", null], // type as string and content in hex string
            nonce: null, // Increments every time a transaction is sent from the same account
            timestamp: null, // Is the registered unix timestamp when the transaction was sent the first time
            transaction_fee: {
                network_fee: null,
                rpc_fee: null,
                additional_fee: null,
            }, 
        },
        signature: null,
        hash: null,
        confirmations: [],
        state_changes: [],
    }
    transaction.content.data["content"] = data
    // TODO
    return transaction
}