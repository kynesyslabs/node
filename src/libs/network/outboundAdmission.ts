import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Mempool from "src/libs/blockchain/mempool"
import { isReferenceBlockAllowed } from "src/libs/blockchain/referenceBlockWindow"
import { verifyRpcEdits } from "src/libs/blockchain/validation/editBinding"
import { clientTxTypeRefusal } from "src/libs/blockchain/validation/txTypes"
import { nftGatingAtTip } from "@/forks/nftValidatorGatingGate"
import GossipManager from "src/libs/gossip/GossipManager"
import { gossipSizeRefusal } from "./txSubmission"

/**
 * Why `submitValidatedTx` would refuse `transaction` for reasons known before
 * any outbound call runs, or null: the client type gate, the gossip size, the
 * edit binding, and the tx already on chain or in our mempool. The mempool's
 * own capacity and per-sender rules are judged at submission only. A failed
 * read refuses: the outbound call it guards cannot be taken back.
 */
export async function outboundAdmissionRefusal(
    validityData: ValidityData,
    transaction: Transaction,
): Promise<string | null> {
    const typeRefusal = clientTxTypeRefusal(transaction, nftGatingAtTip())
    if (typeRefusal) return typeRefusal

    if (GossipManager.isEnabled()) {
        const sizeRefusal = gossipSizeRefusal(validityData)
        if (sizeRefusal) return sizeRefusal
    }

    try {
        const edits = await verifyRpcEdits(transaction)
        if (!edits.ok) return edits.reason
        if (await Chain.checkTxExists(transaction.hash)) {
            return "Transaction already recorded on chain"
        }
        if (await Mempool.checkTransactionByHash(transaction.hash)) {
            return "Transaction already in mempool"
        }
    } catch (e) {
        return `Could not check admission before running the transaction: ${
            e instanceof Error ? e.message : String(e)
        }`
    }
    return null
}

// A claim is kept while its tx could still be admitted. Far above what a
// node sees in one reference window; past it the oldest claims go first.
export const OUTBOUND_CLAIMS_MAX = 50_000

const claims = new Map<string, number>()

function pruneClaims(head: number): void {
    for (const [hash, referenceBlock] of claims) {
        if (!isReferenceBlockAllowed(referenceBlock, head)) claims.delete(hash)
    }
    while (claims.size >= OUTBOUND_CLAIMS_MAX) {
        claims.delete(claims.keys().next().value)
    }
}

/**
 * Records that this node is about to run the outbound operations of the tx
 * `hash`, and returns false when it already did. Re-broadcasting a signed tx
 * must never send its external transactions again, whether the first run was
 * admitted, refused or is still running. A claim is dropped once the tx's
 * reference block leaves the window: broadcast refuses the tx from then on.
 */
export function claimOutboundRun(
    hash: string,
    referenceBlock: number,
    head: number,
): boolean {
    if (claims.has(hash)) return false
    if (claims.size >= OUTBOUND_CLAIMS_MAX) pruneClaims(head)
    claims.set(hash, referenceBlock)
    return true
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetOutboundClaims(): void {
    claims.clear()
}
