/**
 * Resource-slot compare-and-swap state machine.
 *
 * A slot is the reservation over one contended resource. Its key is derived by
 * the profile — the substrate never chooses it, and never accepts one chosen
 * by the caller — and it carries a monotone `generation`. It moves through a
 * fixed lifecycle:
 *
 *   vacant ──reserve──▶ in-flight ──settle────▶ settled
 *                              └────rollback───▶ rolled-back ──reserve(retry)─▶ …
 *
 * The node applies a slot edit exactly like the nonce precondition
 * (`expectedPrior` compare-and-reject): the stored slot must equal the edit's
 * signed `expected` {state, generation}, or the edit is rejected. This module is
 * the pure state machine; wiring into the GCR routine/edit is the consensus layer.
 *
 * Generation arithmetic: a terminal
 * transition bumps the generation by one ONLY on a retry — i.e. when the prior
 * state was `rolled-back` — and leaves it unchanged on a first attempt from
 * `vacant`. Reserve never changes the generation.
 */

export type SlotStateName = "vacant" | "in-flight" | "settled" | "rolled-back"

export interface VacantSlot {
    state: "vacant"
    generation: number
}
export interface InFlightSlot {
    state: "in-flight"
    generation: number
    workId: string
    conflictDigest: string
}
export interface SettledSlot {
    state: "settled"
    generation: number
    workId: string
    conflictDigest: string
    receiptCommitment: string
}
export interface RolledBackSlot {
    state: "rolled-back"
    generation: number
    workId: string
    conflictDigest: string
    failureReceiptCommitment: string
}
export type SlotState = VacantSlot | InFlightSlot | SettledSlot | RolledBackSlot

/** The signed CAS precondition carried by a slot edit. */
export interface SlotCasExpectation {
    state: "vacant" | "rolled-back"
    generation: number
}

export class SlotCasError extends Error {
    constructor(
        message: string,
        readonly reason:
            | "state-mismatch"
            | "generation-mismatch"
            | "not-in-flight",
    ) {
        super(message)
        this.name = "SlotCasError"
    }
}

/**
 * Compare-and-reject the stored slot against the edit's signed expectation.
 * Mirrors the nonce `expectedPrior` guard: any divergence is a hard reject, so
 * a stale or double-spending reservation cannot advance the slot.
 */
export function assertCasPrecondition(
    stored: SlotState,
    expected: SlotCasExpectation,
): void {
    if (stored.state !== expected.state)
        throw new SlotCasError(
            `slot CAS: expected state ${expected.state}, stored ${stored.state}`,
            "state-mismatch",
        )
    if (stored.generation !== expected.generation)
        throw new SlotCasError(
            `slot CAS: expected generation ${expected.generation}, stored ${stored.generation}`,
            "generation-mismatch",
        )
}

/**
 * Reserve the slot for a Work attempt (vacant|rolled-back @ G → in-flight @ G).
 * The generation is preserved; the retry generation bump happens at settle/
 * rollback time, not here.
 */
export function reserveSlot(
    stored: SlotState,
    expected: SlotCasExpectation,
    workId: string,
    conflictDigest: string,
): InFlightSlot {
    assertCasPrecondition(stored, expected)
    return {
        state: "in-flight",
        generation: stored.generation,
        workId,
        conflictDigest,
    }
}

/** A retry is any terminal transition out of a `rolled-back` prior state. */
function terminalGeneration(before: SlotState): number {
    return before.generation + (before.state === "rolled-back" ? 1 : 0)
}

/** Settle an in-flight slot after a committed Work receipt. */
export function settleSlot(
    before: SlotState,
    workId: string,
    conflictDigest: string,
    receiptCommitment: string,
): SettledSlot {
    return {
        state: "settled",
        generation: terminalGeneration(before),
        workId,
        conflictDigest,
        receiptCommitment,
    }
}

/** Roll the slot back after a rolled-back Work receipt (retry-eligible). */
export function rollbackSlot(
    before: SlotState,
    workId: string,
    conflictDigest: string,
    failureReceiptCommitment: string,
): RolledBackSlot {
    return {
        state: "rolled-back",
        generation: terminalGeneration(before),
        workId,
        conflictDigest,
        failureReceiptCommitment,
    }
}
