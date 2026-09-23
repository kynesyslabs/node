/**
 * What may sit inside an atomic boundary.
 *
 * A Work promises that its effects commit together or not at all. That promise
 * is only keepable for effects this node owns and can withhold until the block
 * commits. An effect that leaves the machine — a transfer on another chain, an
 * HTTP call, a bridge, a message — has already happened by the time anything
 * decides to roll back, and no amount of overlay bookkeeping undoes it.
 *
 * So such an effect is refused *before* admission rather than discovered
 * during execution. The alternative is worse than a rejection: a Work that
 * reports a clean rollback while an external transfer stands.
 *
 * The registry is fail-closed. An operation kind nobody declared cannot be
 * classified, so it cannot be admitted — a new kind has to say which side of
 * the boundary it is on before it can be executed at all.
 */

export type EffectClass =
    /** Node-owned state; staged in the overlay, committed or discarded as a unit. */
    | "state"
    /** Leaves this node and cannot be withheld or undone by consensus. */
    | "external"

export class EffectBoundaryError extends Error {
    constructor(
        message: string,
        readonly reason: "unknown-kind" | "external-effect",
        readonly operationId: string,
        readonly kind: string,
    ) {
        super(message)
        this.name = "EffectBoundaryError"
    }
}

const kinds = new Map<string, EffectClass>()

export function declareOperationKind(kind: string, effect: EffectClass): void {
    const existing = kinds.get(kind)
    if (existing && existing !== effect) {
        throw new Error(
            `operation kind '${kind}' is already declared as '${existing}'`,
        )
    }
    kinds.set(kind, effect)
}

export function effectClassOf(kind: string): EffectClass | undefined {
    return kinds.get(kind)
}

export function declaredOperationKinds(): string[] {
    return [...kinds.keys()].sort()
}

/** Test seam: drop declarations so a suite cannot leak into the next. */
export function clearOperationKindsForTesting(): void {
    kinds.clear()
}

/**
 * The native operation kinds the engine can stage.
 *
 * These are node operations, not a profile's: a profile maps its own
 * operations onto them. Cross-chain, web2 and messaging kinds are declared
 * external deliberately, so that a profile naming one inside an atomic Work is
 * refused rather than silently treated as rollback-safe.
 */
export function declareNativeOperationKinds(): void {
    for (const kind of [
        "assert-artifact",
        "assert-work-receipt",
        "storage-program-put",
        "resource-slot-cas",
        "payment-slot-cas",
        "native-dem-transfer",
    ]) {
        declareOperationKind(kind, "state")
    }
    for (const kind of [
        "crosschain-transfer",
        "web2-request",
        "bridge-transfer",
        "instant-message",
    ]) {
        declareOperationKind(kind, "external")
    }
}

export interface BoundedOperation {
    operationId: string
    kind: string
}

/**
 * Refuse a Work whose operations cannot all participate in its rollback.
 *
 * Checked before anything is staged, so a refusal costs nothing and leaves no
 * half-built overlay behind.
 */
export function assertRollbackBoundary(operations: BoundedOperation[]): void {
    for (const op of operations) {
        const effect = effectClassOf(op.kind)
        if (effect === undefined) {
            throw new EffectBoundaryError(
                `operation '${op.operationId}' has undeclared kind '${op.kind}'; ` +
                    "a kind must declare whether it can be rolled back before it can execute",
                "unknown-kind",
                op.operationId,
                op.kind,
            )
        }
        if (effect === "external") {
            throw new EffectBoundaryError(
                `operation '${op.operationId}' of kind '${op.kind}' leaves this node and ` +
                    "cannot be rolled back by consensus, so it cannot sit inside an atomic Work",
                "external-effect",
                op.operationId,
                op.kind,
            )
        }
    }
}
