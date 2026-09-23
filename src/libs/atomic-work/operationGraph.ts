import { atomicWorkProfile, type ExpectedOperation } from "@/libs/atomic-work/profile"

/**
 * Atomic Work fixed operation-graph validator.
 *
 * A profile binds itself to ONE fixed operation graph. The node rejects any
 * intent whose operations deviate in count, id, kind, dependency edges or
 * required roles before it expands the intent into state edits — the fixed
 * shape is what makes that expansion deterministic, and therefore safe to
 * roll back as a unit.
 *
 * An intent naming a profile nobody registered is rejected outright: an
 * unknown shape cannot be checked, so it cannot be admitted.
 */

export interface OperationView {
    operationId?: string
    kind?: string
    dependsOn?: string[]
    requiredRoles?: string[]
}
export interface IntentGraphView {
    profile?: string
    operations?: OperationView[]
}

export class OperationGraphError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "OperationGraphError"
    }
}

function arrayEquals(a: unknown, b: string[]): boolean {
    return (
        Array.isArray(a) &&
        a.length === b.length &&
        a.every((v, i) => v === b[i])
    )
}

/** The graph a registered profile declares. */
export function expectedGraphFor(profile: string | undefined): ExpectedOperation[] {
    const registered = atomicWorkProfile(profile)
    if (!registered) {
        throw new OperationGraphError(
            `unknown atomic work profile: ${profile ?? "(none)"}`,
        )
    }
    return registered.operationGraph
}

/**
 * Validate an intent's operation graph against its profile's fixed shape.
 * Throws OperationGraphError on the first deviation (count, id, kind,
 * dependsOn, or requiredRoles) — matching the reference fail-closed behavior.
 */
export function validateOperationGraph(intent: IntentGraphView): void {
    const expected = expectedGraphFor(intent.profile)
    const operations = intent.operations ?? []
    if (operations.length !== expected.length)
        throw new OperationGraphError(
            `profile operation count mismatch: expected ${expected.length}, got ${operations.length}`,
        )
    for (let i = 0; i < expected.length; i++) {
        const op = operations[i]
        const e = expected[i]
        if (
            op.operationId !== e.operationId ||
            op.kind === undefined ||
            !e.kinds.includes(op.kind) ||
            !arrayEquals(op.dependsOn, e.dependsOn) ||
            !arrayEquals(op.requiredRoles, e.requiredRoles)
        )
            throw new OperationGraphError(
                `profile operation order/dependencies/roles mismatch at index ${i} (${e.operationId})`,
            )
    }
}
