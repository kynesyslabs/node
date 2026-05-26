/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* NOTE
    executeTransaction is called BEFORE the transaction is reflected in the GCR, which happens AFTER the
    consensus has confirmed the transaction in the block.
*/

import GCR from "../gcr/gcr"
import Transaction from "../transaction"
import { Operation } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { denomination } from "@kynesyslabs/demosdk"
import { canonicalizeAmountToOs } from "@/forks/amountCanonical"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"

/* NOTE

Rationale: transactions arrives with a nonce and a timestamp.

The operations contained in a transaction are calculated by executeTransaction, the output is stored
as Operation objects in the GCR.

Each block, the nodes execute the Operation objects ordering them by their timestamp and nonce (see GCR).

*/

// INFO Given a transaction, use GCR to see if it is executable and return a result
export default async function executeNativeTransaction(
    transaction: Transaction,
): Promise<[boolean, string, Operation[]?]> {
    let success = true
    let message = ""
    const operations: Operation[] = []

    // ANCHOR Managing simple value transfer
    // REVIEW myc#76 / GH#3213223280: mirror the serializer's
    // canonicalization here so the bigint used for balance arithmetic
    // matches the bigint the serializerGate hashed under for signing.
    // The reference height is the chain head — same source as
    // `Transaction.hash`/`Transaction.isCoherent` and as the mempool
    // hash sites (`createTransaction`, `deriveMempoolOperation`,
    // `signalingServer`), so all four producers of the canonical bigint
    // agree on the same height when the tx is processed in mempool.
    //
    // myc#80 / GH#3213220466 — mempool activation-boundary canonicalization.
    // Canonicalization mirror with src/forks/serializerGate.ts via the
    // shared canonicalizeAmountToOs helper guarantees hash and balance
    // arithmetic agree on the same bigint. Mempool transactions
    // submitted pre-fork that land in a post-fork block are correctly
    // handled because the serializer gate uses the **persisted block
    // height**, not mempool-arrival height. Both this site
    // (`getSharedState.lastBlockNumber`) and the serializer's callers
    // (`Chain.getLastBlockNumber()` / the block's own number) read the
    // same persisted tip the moment the tx is processed, so a tx that
    // crosses the activation boundary is re-canonicalized under the
    // post-fork rules before its hash binding is verified. See myc#80.
    const referenceHeight = getSharedState.lastBlockNumber ?? 0
    const forkActive = isForkActive("osDenomination", referenceHeight)
    let amountCanonical: bigint
    try {
        amountCanonical = canonicalizeAmountToOs(
            transaction.content.amount,
            forkActive,
        )
    } catch (e) {
        return [false, `Invalid amount: ${(e as Error).message}`]
    }

    if (amountCanonical > 0n) {
        let operation: Operation
        // Handle both string and Buffer types for from/to fields
        const sender =
            typeof transaction.content.from === "string"
                ? transaction.content.from
                : forgeToHex(transaction.content.from)
        const senderBalance = await GCR.getAccountBalance(sender)
        const receiver =
            typeof transaction.content.to === "string"
                ? transaction.content.to
                : forgeToHex(transaction.content.to)
        // Refuse transaction if GCR is not in shape.
        // myc#76: comparison uses the canonicalised bigint so a
        // post-fork legacy `number` wire shape is scaled DEM→OS exactly
        // as the serializer's hash binding did.
        if (senderBalance < amountCanonical) {
            success = false
            message = "Insufficient funds"
            return [success, message]
        }
        // Emit operation params in the magnitude downstream subOperations
        // expects. Post-fork that's the OS string (matching the wire
        // shape the SDK 3.1.0+ produces). Pre-fork the legacy number is
        // preserved bit-identically.
        const paramsAmount: string | number = forkActive
            ? denomination.toOsString(amountCanonical)
            : (transaction.content.amount as number)
        // Add value to receiver's balance
        operation = {
            operator: "add_native",
            actor: receiver,
            params: { amount: paramsAmount },
            hash: transaction.hash,
            nonce: transaction.content.nonce,
            timestamp: transaction.content.timestamp,
            status: "pending",
            fees: transaction.content.transaction_fee,
        }
        // Adding the operation to the list of operations
        operations.push(operation)
        // Subtract value from sender's balance
        operation = {
            operator: "remove_native",
            actor: sender,
            params: { amount: paramsAmount },
            hash: transaction.hash,
            nonce: transaction.content.nonce,
            timestamp: transaction.content.timestamp,
            status: "pending",
            fees: transaction.content.transaction_fee,
        }
        // Adding the operation to the list of operations
        operations.push(operation)
        success = true
        message = "Transaction successful"
        return [success, message, operations]
    }

    // ANCHOR Managing complex operations
    if (transaction.content.data[0] === "demoswork") {
        // TODO Execute the code based on a currently not defined schema
    }

    return [success, message, operations]
}
