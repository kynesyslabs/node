/**
 * Applying a Work's edits to block state as one step: all of them or none.
 *
 * The node's ordinary path mutates the block's entity caches edit by edit and,
 * when one fails, replays the applied ones backwards. For a Work that is the
 * wrong model: the intermediate state is real while the reversal runs, and a
 * reversal that fails itself strands it. Here the edits run against a shadow
 * of the caches instead. The shadow copies an entity the first time an edit
 * reads it, so the real caches are never touched until every edit has
 * succeeded, and a failure is handled by throwing the shadow away.
 */

/** Whatever set of per-kind entity maps the host keeps for a block. */
export type EntityCaches<C> = { [K in keyof C]: Map<string, any> }

export interface EditOutcome {
    success: boolean
    message: string
    sideEffect?: () => Promise<void>
}

export interface AtomicApplyResult {
    success: boolean
    message: string
    /** Index of the edit that failed; absent on success. */
    failedAt?: number
    /** Deferred effects, returned only when the whole set committed. */
    sideEffects: (() => Promise<void>)[]
    appliedEditsCount: number
}

/**
 * Edit kinds whose handlers change nothing but the caches passed to them.
 *
 * This is an allow-list on purpose. A handler that persists directly (stake,
 * governance) or reaches another store (some identity proofs) would escape
 * the shadow: its write lands even when a later edit fails, which is the
 * partial state this path exists to prevent. Such an edit is refused before
 * anything runs rather than half-honoured.
 */
export const CACHE_CONFINED_EDIT_TYPES: ReadonlySet<string> = new Set([
    "balance",
    "nonce",
    "storageProgram",
    "storage-program-put",
    "resource-slot-cas",
    "work-attempt",
    "work-receipt",
])

/** Edit kinds that exist only for atomic Works. */
export const ATOMIC_ONLY_EDIT_TYPES: ReadonlySet<string> = new Set([
    "storage-program-put",
    "resource-slot-cas",
    "work-attempt",
    "work-receipt",
])

/**
 * Whether a transaction's edits must be applied all-or-nothing.
 *
 * Decided by the edits rather than a flag on the transaction, so a
 * transaction cannot carry Work edits and opt out of the guarantee.
 */
export function requiresAtomicApplication(
    edits: ReadonlyArray<{ type: string }> | undefined,
): boolean {
    return (
        Array.isArray(edits) &&
        edits.some(e => ATOMIC_ONLY_EDIT_TYPES.has(e.type))
    )
}

/**
 * Whether a transaction is a Work or carries Work edits under another type.
 * Either way its edits must be regenerated from the signed body and matched
 * before anything admits or applies them.
 */
export function carriesWorkEdits(tx: {
    content?: { type?: string; gcr_edits?: ReadonlyArray<{ type: string }> }
}): boolean {
    return (
        tx.content?.type === "atomicWork" ||
        requiresAtomicApplication(tx.content?.gcr_edits)
    )
}

function detach<T>(value: T): T {
    if (value === null || typeof value !== "object") return value
    // Handlers may rely on the entity's class, which structuredClone drops.
    return Object.assign(
        Object.create(Object.getPrototypeOf(value)),
        structuredClone(value),
    )
}

/**
 * A map that reads through to a base map but keeps every change to itself.
 *
 * Enumeration is refused: it would have to merge two views, and no edit
 * handler needs it. Failing loudly beats a handler quietly seeing only the
 * entries it had already touched.
 */
class ShadowMap<V> extends Map<string, V> {
    private readonly removed = new Set<string>()

    constructor(private readonly base: Map<string, V>) {
        super()
    }

    override get(key: string): V | undefined {
        if (super.has(key)) return super.get(key)
        if (this.removed.has(key) || !this.base.has(key)) return undefined
        const copy = detach(this.base.get(key) as V)
        super.set(key, copy)
        return copy
    }

    override has(key: string): boolean {
        if (super.has(key)) return true
        return !this.removed.has(key) && this.base.has(key)
    }

    override set(key: string, value: V): this {
        this.removed.delete(key)
        return super.set(key, value)
    }

    override delete(key: string): boolean {
        const existed = this.has(key)
        super.delete(key)
        this.removed.add(key)
        return existed
    }

    override get size(): number {
        throw new Error("a shadow map cannot be sized; read entries by key")
    }

    override forEach(): void {
        throw new Error(
            "a shadow map cannot be enumerated; read entries by key",
        )
    }

    override entries(): MapIterator<[string, V]> {
        throw new Error(
            "a shadow map cannot be enumerated; read entries by key",
        )
    }

    override keys(): MapIterator<string> {
        throw new Error(
            "a shadow map cannot be enumerated; read entries by key",
        )
    }

    override values(): MapIterator<V> {
        throw new Error(
            "a shadow map cannot be enumerated; read entries by key",
        )
    }

    override [Symbol.iterator](): MapIterator<[string, V]> {
        throw new Error(
            "a shadow map cannot be enumerated; read entries by key",
        )
    }

    /** Write every change into the base. Only called once all edits passed. */
    flush(): void {
        for (const key of this.removed) this.base.delete(key)
        for (const [key, value] of super.entries()) this.base.set(key, value)
    }
}

function shadowOf<C extends EntityCaches<C>>(
    base: C,
): { view: C; commit: () => void } {
    const shadows: ShadowMap<unknown>[] = []
    const view: Record<string, Map<string, unknown>> = {}
    for (const name of Object.keys(base) as (keyof C & string)[]) {
        const shadow = new ShadowMap<unknown>(base[name])
        shadows.push(shadow)
        view[name] = shadow
    }
    return {
        view: view as unknown as C,
        commit: () => {
            for (const shadow of shadows) shadow.flush()
        },
    }
}

/**
 * Apply every edit against a shadow of the caches, then commit the shadow.
 *
 * On any failure the base caches are exactly as they were: no entity is
 * restored because none was changed, and no side effect is returned because
 * side effects belong to a committed set. `applyOne` is the host's per-edit
 * handler; it must only change the caches it is given.
 */
export async function applyAllOrNothing<
    C extends EntityCaches<C>,
    E extends { type: string },
>(
    base: C,
    edits: ReadonlyArray<E>,
    applyOne: (edit: E, caches: C) => Promise<EditOutcome>,
    /**
     * Runs on the shadow after every edit passed and before anything is
     * committed, for state derived from the whole set (a Work's receipt).
     * Its failure discards the set like any edit's would.
     */
    finalize?: (caches: C) => EditOutcome | Promise<EditOutcome>,
): Promise<AtomicApplyResult> {
    const refused = edits.findIndex(e => !CACHE_CONFINED_EDIT_TYPES.has(e.type))
    if (refused !== -1) {
        return {
            success: false,
            message: `edit ${refused} (${edits[refused].type}) writes outside block state and cannot be applied all-or-nothing`,
            failedAt: refused,
            sideEffects: [],
            appliedEditsCount: 0,
        }
    }

    const shadow = shadowOf(base)
    const sideEffects: (() => Promise<void>)[] = []

    for (let i = 0; i < edits.length; i++) {
        let outcome: EditOutcome
        try {
            outcome = await applyOne(edits[i], shadow.view)
        } catch (error) {
            outcome = {
                success: false,
                message: `edit handler threw: ${error}`,
            }
        }
        if (!outcome.success) {
            return {
                success: false,
                message: outcome.message,
                failedAt: i,
                sideEffects: [],
                appliedEditsCount: 0,
            }
        }
        if (outcome.sideEffect) sideEffects.push(outcome.sideEffect)
    }

    if (finalize) {
        let outcome: EditOutcome
        try {
            outcome = await finalize(shadow.view)
        } catch (error) {
            outcome = { success: false, message: `finalizing the set failed: ${error}` }
        }
        if (!outcome.success) {
            return {
                success: false,
                message: outcome.message,
                failedAt: edits.length,
                sideEffects: [],
                appliedEditsCount: 0,
            }
        }
    }

    shadow.commit()
    return {
        success: true,
        message: "applied all edits",
        sideEffects,
        appliedEditsCount: edits.length,
    }
}
