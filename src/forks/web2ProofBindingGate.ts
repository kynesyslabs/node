import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether a web2 identity proof judged now falls under `web2ProofBinding`.
 *
 * Judged for the block the proof would land in (tip + 1), the same height
 * `signatureDomain` and `getNetworkInfo` use, so a client that reads the
 * network's state sees the rule the node applies.
 *
 * For proofs this is an admission policy: it is consulted when a web2 proof
 * is verified for the mempool and nowhere at block validation, and the
 * Telegram path returns before it. A legacy-shaped proof admitted at a lagging tip, or
 * included by a proposer that ignores the gate, is not re-judged at an explicit
 * height. Transaction signatures under `signatureDomain` can be: `verifyBlock`
 * re-checks them at the block's own height (txSignatureContext(block.number))
 * when it is given the block's transactions. This fork has no such check.
 */
export function web2ProofBindingActiveForPendingBlock(): boolean {
    return isForkActive(
        "web2ProofBinding",
        (getSharedState.lastBlockNumber ?? 0) + 1,
    )
}

/**
 * Whether block application compares web2 account ids in canonical form
 * (the number 42 and the string "42" as one account) in its duplicate,
 * first-connection and points checks. Apply-time rules may only change at a
 * fork height, or a node replaying old blocks would store different state;
 * judged at the tip like the other apply-time gates.
 */
export function web2CanonicalIdsActiveAtApply(): boolean {
    return isForkActive("web2ProofBinding", getSharedState.lastBlockNumber ?? 0)
}
