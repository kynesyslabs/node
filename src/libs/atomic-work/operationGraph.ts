/**
 * Atomic Work fixed operation-graph validator (DACS §A.6, `_profile_shape`).
 *
 * Approach A binds each Work profile to ONE fixed operation graph. The node
 * must reject any intent whose operations deviate in count, id, kind,
 * dependency edges, or required roles before it expands the intent into GCR
 * edits — the shape is what makes the expansion deterministic and safe.
 *
 * This is a byte-for-byte port of the reference `_profile_shape` predicate.
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

interface ExpectedOp {
    operationId: string
    kinds: string[]
    dependsOn: string[]
    requiredRoles: string[]
}

/** dacs-purchase-v1: six operations, buyer/seller vetting → agreement → commitment → slot → payment. */
export const PURCHASE_GRAPH: ExpectedOp[] = [
    { operationId: "buyer-vet", kinds: ["assert-artifact", "storage-program-put"], dependsOn: [], requiredRoles: ["orchestrator"] },
    { operationId: "seller-vet", kinds: ["assert-artifact", "storage-program-put"], dependsOn: [], requiredRoles: ["orchestrator"] },
    { operationId: "agreement", kinds: ["assert-artifact"], dependsOn: ["buyer-vet", "seller-vet"], requiredRoles: ["orchestrator"] },
    { operationId: "commitment", kinds: ["storage-program-put"], dependsOn: ["agreement"], requiredRoles: ["orchestrator"] },
    { operationId: "payment-slot", kinds: ["payment-slot-cas"], dependsOn: ["commitment"], requiredRoles: ["payer"] },
    { operationId: "payment", kinds: ["native-dem-transfer"], dependsOn: ["payment-slot"], requiredRoles: ["payer"] },
]

/** Any non-purchase profile (e.g. dacs-completion-v1): receipt → delivery. */
export const COMPLETION_GRAPH: ExpectedOp[] = [
    { operationId: "purchase-receipt", kinds: ["assert-work-receipt"], dependsOn: [], requiredRoles: ["orchestrator"] },
    { operationId: "delivery", kinds: ["storage-program-put"], dependsOn: ["purchase-receipt"], requiredRoles: ["seller"] },
]

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

/** The expected graph for a profile (purchase has its own; all others share completion). */
export function expectedGraphFor(profile: string | undefined): ExpectedOp[] {
    return profile === "dacs-purchase-v1" ? PURCHASE_GRAPH : COMPLETION_GRAPH
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
