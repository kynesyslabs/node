/**
 * Proving runs in the prover subprocess only; verification runs in the
 * node. Implemented with the circuit (feat/l2ps-settlement-circuit).
 */
import type { SettlementPlan, SettlementProof, SettlementProofResult } from "./types"

export async function proveSettlement(
    _plan: SettlementPlan,
): Promise<SettlementProofResult> {
    throw new Error("settlement prover not built yet")
}

export async function verifySettlementProof(
    _publicSignals: bigint[],
    _proof: SettlementProof,
): Promise<boolean> {
    throw new Error("settlement verifier not built yet")
}
