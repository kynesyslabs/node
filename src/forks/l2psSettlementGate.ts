import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/**
 * Whether an `l2psBatch` settles through its proven settlement record and the
 * entry node's local L2PS proof path is off. Apply-time rules may only change
 * at a fork height, or a node replaying old blocks would store different
 * state; judged at the tip like the other apply-time gates, by block apply,
 * forging, admission and the aggregator alike.
 */
export function l2psSettlementActive(): boolean {
    return isForkActive("l2psSettlement", getSharedState.lastBlockNumber ?? 0)
}
