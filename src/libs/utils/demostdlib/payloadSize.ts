import sizeOf from "object-sizeof"
import Block from "src/libs/blockchain/block"
import Transaction from "src/libs/blockchain/transaction"
import Transmission from "src/libs/communications/transmission"

export function payloadSize(
    payload: any,
    isObject = true,
    type:
        /*| "object"
        | "transaction"
        | "block"
        | "transmission" */
        | "object"
        | "execute"
        | "hello_peer"
        | "consensus"
        | "proofOfConsensus"
        | "mempool"
        | "auth" = "object",
) {
    return sizeOf(payload)
    // TODO Implement remaining types
}

function transactionSize(transaction) {}

function blockSize(block) {}

function transmissionSize(transmission) {}

