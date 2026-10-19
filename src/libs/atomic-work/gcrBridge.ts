import type { CommitPlan, StagedClaim, StagedEffect, StagedWrite } from "@/libs/atomic-work/overlay"

/**
 * Turning a committed overlay plan into the edits a block applies.
 *
 * The node's existing path applies each edit as it goes and, on failure,
 * replays the applied edits backwards. That is a compensation, not a rollback:
 * between the apply and the reversal the intermediate state is real, so
 * anything reading concurrently sees effects that are about to be undone, and
 * a reversal that itself fails leaves the state somewhere neither side
 * intended. The overlay exists so the block sees one set of edits or none, and
 * this is the seam where it hands them over.
 *
 * The mapping is deliberately total and order-preserving. A plan whose effects
 * arrive in a different order is a different plan: a write and the claim that
 * authorizes it are only safe in the order they were staged.
 */

/** The edit kinds an atomic plan produces. Names match the operation kinds. */
export type AtomicEditKind = "storage-program-put" | "resource-slot-cas"

export interface AtomicEdit {
    kind: AtomicEditKind
    /** Position in the plan; applying out of order is not safe. */
    index: number
    /** The operation this edit came from, for the receipt. */
    operationId: string
    payload: Record<string, unknown>
}

export class PlanTranslationError extends Error {
    constructor(message: string, readonly reason: "unknown-effect" | "empty-plan" | "not-committed") {
        super(message)
        this.name = "PlanTranslationError"
    }
}

function writeEdit(effect: StagedWrite, index: number): AtomicEdit {
    return {
        kind: "storage-program-put",
        index,
        operationId: effect.operationId,
        payload: { domain: effect.domain, key: effect.key, value: effect.value },
    }
}

function claimEdit(effect: StagedClaim, index: number): AtomicEdit {
    return {
        kind: "resource-slot-cas",
        index,
        operationId: effect.operationId,
        payload: {
            resourceKey: effect.resourceKey,
            expected: effect.expected,
            next: effect.next,
        },
    }
}

/**
 * The edits a plan becomes.
 *
 * An empty plan is refused rather than translated into nothing: a Work that
 * staged no effect either did nothing or lost its effects on the way here, and
 * both deserve to be noticed rather than committed as a successful no-op.
 */
export function planToAtomicEdits(plan: CommitPlan): AtomicEdit[] {
    if (!plan || !Array.isArray(plan.effects)) {
        throw new PlanTranslationError(
            "a commit plan is required; this one has no effects array",
            "not-committed",
        )
    }
    if (plan.effects.length === 0) {
        throw new PlanTranslationError(
            "a Work that staged no effects has nothing to commit",
            "empty-plan",
        )
    }

    return plan.effects.map((effect: StagedEffect, index) => {
        if (effect.kind === "write") return writeEdit(effect, index)
        if (effect.kind === "claim") return claimEdit(effect, index)
        throw new PlanTranslationError(
            `a plan carried an effect this bridge cannot translate: ${(effect as { kind: string }).kind}`,
            "unknown-effect",
        )
    })
}

/**
 * Refuse to hand a plan to a path that unwinds by replaying edits backwards.
 *
 * Kept as an explicit guard because the two models look interchangeable from
 * the call site and are not: reversal is visible to concurrent readers and can
 * fail halfway, which is the failure the overlay was built to remove. A caller
 * that wants compensation semantics has to say so, and then it is not an
 * atomic Work.
 */
export function assertAtomicApplication(mode: "all-or-nothing" | "apply-then-reverse"): void {
    if (mode !== "all-or-nothing") {
        throw new PlanTranslationError(
            "an atomic Work cannot be applied through the reversal path: between apply and " +
                "reverse the intermediate state is visible, and a failed reversal strands it",
            "not-committed",
        )
    }
}
