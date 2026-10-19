import { jcsCanonicalize } from "@/libs/crypto/jcs"
import {
    assertCasPrecondition,
    reserveSlot,
    type SlotCasExpectation,
    type SlotState,
} from "@/libs/atomic-work/resourceSlot"

/**
 * The one isolated overlay a Work executes in.
 *
 * Every read goes through it and every write stays in it. Nothing reaches the
 * backing state until `commit()` produces a plan and the caller applies it, so
 * a Work that fails halfway leaves no trace: there is nothing to undo, because
 * nothing was written.
 *
 * Isolation is the point. Two Works executing against the same tip each build
 * their own overlay and neither sees the other's staged writes, so a Work
 * cannot be made to depend on an effect that may never commit. What they do
 * share is the set of resource claims, and that is exactly where conflicts are
 * meant to surface — at claim time, by compare-and-set, rather than after both
 * have paid.
 *
 * `commit()` re-checks every claim against the state the plan will be applied
 * to. A claim that was valid when staged but is not at commit time fails the
 * whole plan: all of it lands, or none of it does.
 */

export interface OverlayBackend {
    /** The committed value, or undefined. Never sees staged writes. */
    read(domain: string, key: string): Promise<unknown | undefined>
    /** The committed slot, or a vacant slot when nothing has claimed it. */
    readSlot(resourceKey: string): Promise<SlotState | undefined>
}

export interface StagedWrite {
    kind: "write"
    domain: string
    key: string
    value: unknown
    operationId: string
}

export interface StagedClaim {
    kind: "claim"
    resourceKey: string
    expected: SlotCasExpectation
    next: SlotState
    operationId: string
}

export type StagedEffect = StagedWrite | StagedClaim

export class OverlayConflictError extends Error {
    constructor(
        message: string,
        readonly reason: "claim-conflict" | "double-claim",
        readonly resourceKey: string,
    ) {
        super(message)
        this.name = "OverlayConflictError"
    }
}

export class OverlayClosedError extends Error {
    constructor(action: string, state: "committed" | "rolled-back") {
        super(`cannot ${action} an overlay that was already ${state}`)
        this.name = "OverlayClosedError"
    }
}

export interface CommitPlan {
    /** Effects in the order they were staged; applying them out of order is not safe. */
    effects: StagedEffect[]
    /** Digest over the staged effects, for the receipt to commit to. */
    effectsDigestInput: string
}

export interface RollbackRecord {
    reason: string
    /** What would have been written, kept for the failure receipt. */
    discarded: StagedEffect[]
}

export class AtomicOverlay {
    private readonly writes = new Map<string, StagedWrite>()
    private readonly claims = new Map<string, StagedClaim>()
    private readonly order: StagedEffect[] = []
    private closed: "committed" | "rolled-back" | null = null

    constructor(private readonly backend: OverlayBackend) {}

    private assertOpen(action: string): void {
        if (this.closed) throw new OverlayClosedError(action, this.closed)
    }

    /**
     * Read through the overlay: a value this Work has already written wins over
     * the committed one, so an operation sees the effects of the operations it
     * depends on without those effects being visible to anyone else.
     */
    async read(domain: string, key: string): Promise<unknown | undefined> {
        this.assertOpen("read from")
        const staged = this.writes.get(`${domain}\u0000${key}`)
        if (staged) return staged.value
        return this.backend.read(domain, key)
    }

    write(domain: string, key: string, value: unknown, operationId: string): void {
        this.assertOpen("write to")
        const effect: StagedWrite = { kind: "write", domain, key, value, operationId }
        this.writes.set(`${domain}\u0000${key}`, effect)
        this.order.push(effect)
    }

    /**
     * Claim a contended resource.
     *
     * The claim is staged, not applied, but it is checked against the committed
     * slot immediately: a Work that cannot claim what it needs should fail here
     * rather than after doing the rest of its work. One Work may claim a given
     * resource once — a second claim on the same key is a bug in the profile's
     * graph, not a race, so it is rejected outright.
     */
    async claim(
        resourceKey: string,
        expected: SlotCasExpectation,
        workId: string,
        conflictDigest: string,
        operationId: string,
    ): Promise<void> {
        this.assertOpen("claim in")
        if (this.claims.has(resourceKey)) {
            throw new OverlayConflictError(
                `resource '${resourceKey}' is claimed twice by the same Work`,
                "double-claim",
                resourceKey,
            )
        }
        const current = (await this.backend.readSlot(resourceKey)) ?? {
            state: "vacant" as const,
            generation: expected.generation,
        }
        const next = reserveSlot(current, expected, workId, conflictDigest)

        const effect: StagedClaim = { kind: "claim", resourceKey, expected, next, operationId }
        this.claims.set(resourceKey, effect)
        this.order.push(effect)
    }

    /** What is staged, in staging order. */
    effects(): StagedEffect[] {
        return [...this.order]
    }

    /**
     * Re-check every claim against the state this plan will be applied to, then
     * hand back the whole plan.
     *
     * The re-check is what makes the overlay safe across the gap between
     * execution and inclusion: the slot may have moved while this Work was
     * being assembled, and a plan built on a claim that no longer holds must
     * not land partially.
     */
    async commit(): Promise<CommitPlan> {
        this.assertOpen("commit")
        for (const claim of this.claims.values()) {
            const current = (await this.backend.readSlot(claim.resourceKey)) ?? {
                state: "vacant" as const,
                generation: claim.expected.generation,
            }
            try {
                assertCasPrecondition(current, claim.expected)
            } catch (cause) {
                throw new OverlayConflictError(
                    `resource '${claim.resourceKey}' changed under this Work before commit: ` +
                        `${cause instanceof Error ? cause.message : String(cause)}`,
                    "claim-conflict",
                    claim.resourceKey,
                )
            }
        }
        this.closed = "committed"
        return {
            effects: [...this.order],
            effectsDigestInput: jcsCanonicalize(this.order),
        }
    }

    /** Discard everything. Nothing was applied, so there is nothing to undo. */
    rollback(reason: string): RollbackRecord {
        this.assertOpen("roll back")
        const discarded = [...this.order]
        this.closed = "rolled-back"
        this.writes.clear()
        this.claims.clear()
        this.order.length = 0
        return { reason, discarded }
    }

    get state(): "open" | "committed" | "rolled-back" {
        return this.closed ?? "open"
    }
}
