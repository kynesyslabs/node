/**
 * A storage program transaction as its author builds it, and as a peer
 * receives it after the SDK wire serialisation.
 */

import { denomination } from "@kynesyslabs/demosdk"
import type { Transaction } from "@kynesyslabs/demosdk/types"

export const SENDER = "0x" + "ab".repeat(32)

export function storageTx(payload: unknown, to: string, nonce: number): Transaction {
    return {
        hash: "",
        content: {
            type: "storageProgram",
            from: SENDER,
            from_ed25519_address: SENDER,
            to,
            amount: 0,
            data: ["storageProgram", payload],
            gcr_edits: [],
            nonce,
            timestamp: 1_700_000_000_000,
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
                rpc_address: null,
            },
        },
    } as unknown as Transaction
}

/** What a peer receives: the author's tx after the SDK wire serialisation. */
export function onTheWire(tx: Transaction, postFork: boolean): Transaction {
    const copy = JSON.parse(JSON.stringify(tx)) as Transaction
    copy.content = JSON.parse(
        denomination.serializeTransactionContent(copy.content as any, postFork),
    )
    copy.hash = "de".repeat(32)
    return copy
}
