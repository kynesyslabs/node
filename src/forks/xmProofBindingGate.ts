import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether an xm identity proof judged now falls under `xmProofBinding`.
 *
 * Judged for the block the proof would land in (tip + 1), the same height
 * `web2ProofBinding` uses, so a client that reads the network's state sees
 * the rule the node applies. An admission policy only: it is consulted when
 * the proof is verified for the mempool and nowhere at block validation.
 */
export function xmProofBindingActiveForPendingBlock(): boolean {
    return isForkActive(
        "xmProofBinding",
        (getSharedState.lastBlockNumber ?? 0) + 1,
    )
}
