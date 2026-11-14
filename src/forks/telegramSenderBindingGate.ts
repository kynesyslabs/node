import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether a Telegram attestation must name the transaction sender. Judged at
 * the tip both when the proof is verified for the mempool and when a block
 * applies it: a transaction admitted on tip T lands in the block applied on
 * tip T, so the two agree on the rule.
 */
export function telegramSenderBindingActive(): boolean {
    return isForkActive(
        "telegramSenderBinding",
        getSharedState.lastBlockNumber ?? 0,
    )
}
