import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether a web2 identity proof judged now falls under `web2ProofBinding`.
 *
 * Judged for the block the proof would land in (tip + 1), the same height
 * `signatureDomain` and `getNetworkInfo` use, so a client that reads the
 * network's state sees the rule the node applies.
 *
 * This is an admission policy only: it is consulted when a web2 proof is
 * verified for the mempool and nowhere at block validation, and the Telegram
 * path returns before it. A legacy-shaped proof admitted at a lagging tip, or
 * included by a proposer that ignores the gate, is not re-judged at an explicit
 * height the way `signatureDomain` is (txSignatureContext(block.number)).
 */
export function web2ProofBindingActiveForPendingBlock(): boolean {
    return isForkActive(
        "web2ProofBinding",
        (getSharedState.lastBlockNumber ?? 0) + 1,
    )
}
