import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether a web2 identity proof judged now falls under `web2ProofBinding`.
 *
 * A proof admitted at tip H-1 lands in block H, and the rule of block H is the
 * one that applies. Judging at the tip would keep accepting the legacy shape
 * for the whole activation block, one block later than `signatureDomain`
 * (which answers for tip + 1, see signatureDomainGate.ts) and than
 * `getNetworkInfo` reports for this fork.
 */
export function web2ProofBindingActiveForPendingBlock(): boolean {
    return isForkActive(
        "web2ProofBinding",
        (getSharedState.lastBlockNumber ?? 0) + 1,
    )
}
