/**
 * Boot checks for the l2psSettlement fork. The verification key and the
 * prover are otherwise loaded on first use, so a node missing them would
 * boot clean and fail at the first settlement batch: a validator halting
 * block apply, a member never settling its subnet's transfers.
 */
import { getSharedState } from "@/utilities/sharedState"
import { getErrorMessage } from "@/utilities/errorMessage"

/** Scheduled at any height, not only active: a node must be ready before the fork arrives. */
export function settlementScheduled(): boolean {
    return (getSharedState.forkConfig?.l2psSettlement?.activationHeight ?? null) !== null
}

/** Why this node cannot verify settlement proofs, or null. Every validator verifies them. */
export function settlementVerifierProblem(scheduled: boolean, loadVerificationKey: () => unknown): string | null {
    if (!scheduled) return null
    try {
        loadVerificationKey()
        return null
    } catch (error) {
        return `the l2psSettlement fork is scheduled but this node cannot verify settlement proofs: ${getErrorMessage(error)}`
    }
}

export interface SettlementProverCheck {
    scheduled: boolean
    /** Joined at least one L2PS subnet: it proves its subnet's batches. */
    member: boolean
    built(): boolean
    /** Starts one prover subprocess and resolves once it is ready. */
    probe(): Promise<void>
}

/** Why this subnet member cannot prove settlement batches, or null. */
export async function settlementProverProblem(check: SettlementProverCheck): Promise<string | null> {
    if (!check.scheduled || !check.member) return null
    if (!check.built()) {
        return "this node is an L2PS subnet member but its settlement proving key or circuit is missing; use an image built with the settlement keys or run the setup"
    }
    try {
        await check.probe()
        return null
    } catch (error) {
        return `this node is an L2PS subnet member but its settlement prover does not start: ${getErrorMessage(error)}`
    }
}
