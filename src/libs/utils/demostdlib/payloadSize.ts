import sizeOf from "object-sizeof"
import Block from "src/libs/blockchain/block"
import Transaction from "src/libs/blockchain/transaction"
import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"

export function payloadSize(
    payload: any,
    is_object = true,
    type:
        | "object"
        | "transaction"
        | "block"
        | "comlink"
        | "transmission" = "object",
) {
    return sizeOf(payload)
    // TODO Implement remaining types
}

function transactionSize(transaction) {}

function blockSize(block) {}

function transmissionSize(transmission) {}

function comlinkSize(comlink) {}
