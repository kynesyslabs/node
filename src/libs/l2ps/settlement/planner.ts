/**
 * Picks the transfers of one batch and computes its net changes against the
 * given balances. Implemented with the circuit (feat/l2ps-settlement-circuit).
 */
import type { DecryptedTransfer, SettlementPlan } from "./types"

export function planSettlement(
    _transfers: DecryptedTransfer[],
    _balances: Map<string, bigint>,
    _nonces: Map<string, bigint>,
): SettlementPlan {
    throw new Error("settlement planner not built yet")
}
