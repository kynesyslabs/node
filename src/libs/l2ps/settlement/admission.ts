import { canonicallyOrderable } from "@/libs/consensus/v2/routines/deterministicOrder"
import {
    nativeTransferFeeOs,
    parseSettlement,
    settlementChainId,
    settlementFeeCreditRefusal,
    settlementFeeRefusal,
    settlementSignatureRefusal,
} from "./validation"

function validatorKey(value: string): string {
    const lower = value.toLowerCase()
    return lower.startsWith("0x") ? lower : `0x${lower}`
}

/**
 * Why a settlement batch may not enter the pool, or null: the checks apply
 * makes before it reads state (record shape, fee, fee credits, every
 * transfer's signature), and a producer staked at the tip, ordered under its
 * own key. Apply only fails a batch, so a batch anyone can sign would ride
 * into blocks for free and fill the per-block cap ahead of real ones. The
 * proof is checked against the working state at apply alone: judged against
 * a tip that moved between members, it would split the merged pool.
 */
export async function settlementAdmissionRefusal(
    tx: { hash?: unknown; content?: unknown },
    validators: ReadonlySet<string>,
): Promise<string | null> {
    if (!canonicallyOrderable(tx as never)) return "settlement batch has no sender address to order it by"
    const content = tx.content as { from?: unknown; from_ed25519_address: string }
    if (typeof content.from !== "string" || validatorKey(content.from) !== validatorKey(content.from_ed25519_address)) {
        return "settlement batch is ordered under a key other than its signer's"
    }
    if (!validators.has(validatorKey(content.from))) {
        return "settlement batch is not signed by a validator staked at the tip"
    }
    const parsed = parseSettlement(tx as never)
    if (parsed.ok === false) return parsed.reason
    return (
        settlementFeeRefusal(parsed.value, await nativeTransferFeeOs()) ??
        settlementFeeCreditRefusal(parsed.value) ??
        settlementSignatureRefusal(parsed.value, settlementChainId())
    )
}
