import { jcsCanonicalize } from "@/libs/crypto/jcs"

/**
 * Atomic Work attempt ledger — single-winner selection and fencing.
 *
 * A Work may be attempted on the native ledger more than once (retries,
 * replacements). At most ONE attempt may carry an authenticated `included-*`
 * lifecycle state; that attempt is the winner, and only it may produce business
 * effects. This module is the pure selection/fence layer — it consumes lifecycle
 * states the authorization layer has already authenticated; it does not itself
 * verify signatures.
 *
 * Invariants enforced:
 *  - `nativeTransactionRef` is unique across attempts (the double-execution fence);
 *  - `attemptId` is unique;
 *  - at most one attempt is `included-*`;
 *  - the winner is that single included attempt (else there is no winner);
 *  - business effects come only from the winner, and at most one attempt has them;
 *  - a `replacement` attempt may only replace an `authoritative-non-inclusion` prior.
 */

export interface NativeTransactionRef {
    kind: string
    value: string
}

export interface AttemptView {
    attemptId: string
    /** Authenticated lifecycle state, e.g. "included-committed",
     *  "authoritative-non-inclusion", or null when the attempt has no evidence. */
    lifecycleState: string | null
    nativeTransactionRef: NativeTransactionRef
    attemptClass: "normal" | "replacement"
    replacementFor?: string | null
}

export type AttemptLedgerReason =
    | "duplicate-attempt-id"
    | "duplicate-native-ref"
    | "multiple-included"
    | "unfenced-business-effect"
    | "unknown-replacement-target"
    | "illegal-replacement"

export class AttemptLedgerError extends Error {
    constructor(message: string, readonly reason: AttemptLedgerReason) {
        super(message)
        this.name = "AttemptLedgerError"
    }
}

function isIncluded(state: string | null): boolean {
    return typeof state === "string" && state.startsWith("included-")
}

/**
 * Select the single winning attempt (or null). Rejects duplicate attemptIds,
 * duplicate nativeTransactionRefs (double-execution), and more than one included
 * attempt.
 */
export function selectWinner(attempts: AttemptView[]): string | null {
    const ids = new Set<string>()
    const nativeRefs = new Set<string>()
    const included: AttemptView[] = []

    for (const a of attempts) {
        if (ids.has(a.attemptId))
            throw new AttemptLedgerError(
                `duplicate attemptId ${a.attemptId}`,
                "duplicate-attempt-id",
            )
        ids.add(a.attemptId)

        const refKey = jcsCanonicalize(a.nativeTransactionRef)
        if (nativeRefs.has(refKey))
            throw new AttemptLedgerError(
                "duplicate nativeTransactionRef across Work attempts",
                "duplicate-native-ref",
            )
        nativeRefs.add(refKey)

        if (isIncluded(a.lifecycleState)) included.push(a)
    }

    if (included.length > 1)
        throw new AttemptLedgerError(
            "ledger selected more than one included attempt",
            "multiple-included",
        )
    return included.length === 1 ? included[0].attemptId : null
}

/**
 * Fence business effects to the winner: every effect must name the winner, and
 * there is at most one effect (none if there is no winner).
 */
export function assertBusinessEffectsFenced(
    winner: string | null,
    businessEffectAttempts: string[],
): void {
    const cap = winner ? 1 : 0
    if (
        businessEffectAttempts.length > cap ||
        businessEffectAttempts.some(id => id !== winner)
    )
        throw new AttemptLedgerError(
            "late/competing attempt was not fenced",
            "unfenced-business-effect",
        )
}

/**
 * A replacement attempt may only replace a prior that the ledger authenticated
 * as `authoritative-non-inclusion` (an included or unresolved prior is not
 * replaceable).
 */
export function assertReplacementsValid(attempts: AttemptView[]): void {
    const byId = new Map(attempts.map(a => [a.attemptId, a]))
    for (const a of attempts) {
        if (a.attemptClass !== "replacement") continue
        const prior = a.replacementFor ? byId.get(a.replacementFor) : undefined
        if (!prior)
            throw new AttemptLedgerError(
                "replacement names an unknown attempt",
                "unknown-replacement-target",
            )
        if (prior.lifecycleState !== "authoritative-non-inclusion")
            throw new AttemptLedgerError(
                "included or unresolved attempt cannot be replaced",
                "illegal-replacement",
            )
    }
}
