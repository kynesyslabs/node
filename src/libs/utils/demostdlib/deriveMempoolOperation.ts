import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import log from "@/utilities/logger"

import { Operation } from "@kynesyslabs/demosdk/types"
/* eslint-disable no-unused-vars */
import Transaction from "../../blockchain/transaction"
import { ucrypto } from "@kynesyslabs/demosdk/encryption"

export interface DerivableNative {
    from: string
    to: string
    type: "web2Request" | "crosschainOperation" | "demoswork"
    data: any | string
    timestamp: number
    fees: {
        networkFee: number
        rpcFee: number
        additionalFee: number
    }
}

// REVIEW See if is fixed (should return something)
// INFO Deriving a mempool operation from a given data by deriving a tx and the corresponding mempool operation
export async function deriveMempoolOperation(
    data: DerivableNative,
    insert = true,
): Promise<any> {
    // Sanity check
    if (typeof data.data !== "string") {
        try {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            data.data = JSON.stringify(data.data, (_, v) =>
                typeof v === "bigint" ? v.toString() : v,
            )
        } catch (e) {
            log.error(e)
            return false
        }
    }
    // We should have a valid, attested request: lets handle it
    // Deriving a transaction
    // TODO Replace with deriveTransaction(data) using data.type
    const derivedTx: Transaction = await createTransaction(data) // A simple tx with data inside
    log.debug("Derived tx:")
    //log.debug(derivedTx)
    // Deriving an operation from the tx
    const derivedOperation: Operation = await createOperation(derivedTx) // An operation witnessing the validity of the data requested
    log.debug("Derived operation:")
    //log.debug(derivedOperation)
    if (insert) {
        // ANCHOR Inserting the operation in the next mempool session with the proper data
        // Mempool.addTransaction(derivedTx)
        // ANCHOR And we do the same for the derived operation, inserting it in the GCR
        // NOTE Deprecated in favor of the GCREdit system
        //GCR.getInstance().operations.push(derivedOperation)
    }
    // TODO Size limit?
    return [derivedTx.hash, derivedOperation] // REVIEW Is this ok?
}

/* TODO Plan for the future
 * We receive some form of data that can be:
 * 1. A web2 request
 * 2. A xm request
 * 3. A native transaction
 * We have to parse the data and create a transaction with the appropriate type and data
 * Then we have to derive the operation(s) from that transaction
 *
 * Pseudocode:
 *
 * createTransaction(data: any): Promise<Transaction> -> a tx with type and data
 * createOperation(transaction: Transaction): Promise<Operation[]> -> the various operations derived from the tx
 *
 * TODO: Standardize the three types responses (we should just need the hashes after all as we are assigning for xm and web2)
 *
 */

export async function deriveTransaction(data: any): Promise<Transaction> {
    // TODO Need to pass the data for registering the tx in the mempool (type, address...)
    if (data.type === "web2") {
        return await createTransactionProxy(data.data)
    } else if (data.type === "xm") {
        return await createTransactionProxy(data.data)
    } else {
        return null
    }
}

export async function deriveOperations(
    transaction: Transaction,
): Promise<Operation[]> {
    const operations = []
    // Analyzing the transaction type
    switch (transaction.content.type) {
        // TODO Do this
        case "web2Request":
            break
        case "crosschainOperation":
            break
        case "demoswork":
            break
        default:
            break
    }
    return null
}

// REVIEW operations are basically changes frozen until the block is mined

/* DEPRECATED */

export async function createOperation(
    transaction: Transaction,
): Promise<Operation> {
    const operation: Operation = {
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

    operation.operator = "Web2Certification" // FIXME New method bls
    operation.nonce = 0 // TODO Get it from chain or gcr or whatever it is
    operation.timestamp = transaction.content.timestamp
    operation.params = transaction.content.data
    operation.status = true // TODO Get it from the content itself somehow

    const { networkFee, rpcFee } = resolveDynamicFees()
    operation.fees.network_fee = networkFee
    operation.fees.rpc_fee = rpcFee
    operation.fees.additional_fee = 0

    return operation
}

// Reads governance-driven fees from sharedState.networkParameters. Falls back
// to 0 / legacy flat sharedState.rpcFee if the loader hasn't run yet.
export function resolveDynamicFees(): {
    networkFee: number
    rpcFee: number
} {
    const params = (
        getSharedState as unknown as {
            networkParameters?: { networkFee?: number; rpcFee?: number }
        }
    ).networkParameters
    const networkFee =
        typeof params?.networkFee === "number" ? params.networkFee : 0
    const rpcFee =
        typeof params?.rpcFee === "number"
            ? params.rpcFee
            : getSharedState.rpcFee ?? 0
    return { networkFee, rpcFee }
}

async function createTransactionProxy(data: any): Promise<Transaction> {
    return await createTransaction(data)
}

export async function createTransaction(
    derivable: DerivableNative,
): Promise<Transaction> {
    const transaction: Transaction = {
        content: {
            type: null,
            from: null,
            to: null,
            amount: null,
            from_ed25519_address: null,
            data: ["demoswork", null], // type as string and content in hex string
            gcr_edits: [],
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
        status: null,
        blockNumber: null,
        ed25519_signature: null,
    }
    // Setting the type
    transaction.content.type = derivable.type
    // REVIEW Why? Should be done differently I guess
    // Setting us as the sender
    transaction.content.from = getSharedState.publicKeyHex
    transaction.content.to = derivable.to
    transaction.content.amount = 0
    transaction.content.nonce = 0
    // Prefer governance-driven fees from sharedState.networkParameters; fall
    // back to whatever the caller passed in `derivable.fees`. This keeps the
    // signed transaction in sync with the same fees the node would deduct.
    const dynamic = resolveDynamicFees()
    transaction.content.transaction_fee.network_fee =
        dynamic.networkFee ?? derivable.fees.networkFee
    transaction.content.transaction_fee.rpc_fee =
        dynamic.rpcFee ?? derivable.fees.rpcFee
    transaction.content.transaction_fee.additional_fee =
        derivable.fees.additionalFee
    // Adding data
    transaction.content.data = derivable.data
    transaction.content.timestamp = derivable.timestamp
    // Hashing the content and signing the transaction
    transaction.hash = Hashing.sha256(JSON.stringify(transaction.content))
    const signature = await ucrypto.sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(transaction.hash),
    )
    transaction.signature = signature as any // REVIEW Should be correct but it was transaction.signature = signature before
    // TODO See how to be general purpose but specific (a shared format?)
    return transaction
}
