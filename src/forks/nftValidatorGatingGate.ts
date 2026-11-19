import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/** Transaction types that exist only under `nftValidatorGating`. */
export const NFT_GATED_TX_TYPES: ReadonlySet<string> = new Set(["validatorChallenge"])

/** The seat transactions that pay no gas under `nftValidatorGating`. */
export const SEAT_TX_TYPES: ReadonlySet<string> = new Set([
    "validatorStake",
    "validatorUnstake",
    "validatorExit",
    "validatorChallenge",
])

/** Types that ship no gas edit on any chain. */
const ALWAYS_GASLESS: ReadonlySet<string> = new Set(["identity", "d402_payment"])

/** Whether validator NFT gating holds for the block applied on `tip`. */
export function nftGatingActive(tip: number): boolean {
    return isForkActive("nftValidatorGating", tip)
}

/** Whether validator NFT gating holds for the block applied on the current tip. */
export function nftGatingAtTip(): boolean {
    return nftGatingActive(getSharedState.lastBlockNumber ?? 0)
}

/** Whether this network schedules validator NFT gating at any height. */
export function nftGatingScheduled(): boolean {
    const config = getSharedState.forkConfig?.nftValidatorGating
    return !!config && config.activationHeight !== null
}

/** Whether block 0 seats its validators under validator NFT gating. */
export function nftGatingActiveAtGenesis(): boolean {
    return nftGatingActive(0)
}

/** Whether a transaction of `type` ships no gas edit. */
export function isGaslessTxType(type: string, nftGating: boolean): boolean {
    return ALWAYS_GASLESS.has(type) || (nftGating && SEAT_TX_TYPES.has(type))
}

type TxView = Pick<Transaction, "content"> | { content?: unknown }

function contentOf(tx: TxView): Record<string, unknown> {
    const content = (tx as { content?: unknown }).content
    return content && typeof content === "object"
        ? (content as Record<string, unknown>)
        : {}
}

/**
 * Why a transaction is refused under `nftValidatorGating`, or null. An evict
 * edit closes another account's seat, which only a challenge, judged on its
 * Solana evidence, may do; an NFT on a stake edit takes a seat, which only a
 * stake, judged on its proof, may do. Before the fork the node adds nothing:
 * a chain that has not scheduled it applies such edits as it always did.
 */
export function nftGatingRefusal(tx: TxView, nftGating: boolean): string | null {
    if (!nftGating) return null
    const content = contentOf(tx)
    const type = content.type
    const edits = Array.isArray(content.gcr_edits) ? content.gcr_edits : []
    for (const edit of edits as Array<Record<string, unknown> | null>) {
        if (!edit || edit.type !== "validatorStake") continue
        if (edit.operation === "evict" && type !== "validatorChallenge") {
            return "a validatorStake evict edit rides only in a validatorChallenge transaction"
        }
        if (edit.nft !== undefined && type !== "validatorStake") {
            return "a validatorStake edit carrying an NFT rides only in a validatorStake transaction"
        }
    }
    return null
}
