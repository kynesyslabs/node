import {
    assertCasPrecondition,
    rollbackSlot,
    settleSlot,
    SlotCasError,
    type SlotCasExpectation,
    type SlotState,
} from "@/libs/atomic-work/resourceSlot"

/**
 * Applying Work edits to block state.
 *
 * A Work commits in one transaction, so a slot never rests in `in-flight` on
 * chain: it goes from vacant (or rolled-back) straight to settled or
 * rolled-back. The in-flight state exists only inside the overlay while the
 * Work runs.
 *
 * The receipt is not an edit. It commits to the block the Work lands in,
 * which the sender cannot know when signing, so the node builds it once
 * every edit has passed (`sealWork`) and writes its commitment into the Work
 * record and every slot the Work moved, in the same transition.
 *
 * Every forward transition records what it replaced, so a block rollback can
 * put back exactly the prior state instead of inferring it.
 */

export interface WorkRecord {
    workId: string
    winnerAttemptId: string
    canonicalBytesHash: string
    attemptClass: "normal" | "replacement"
    replacementFor: string | null
    txHash: string
    receiptCommitment: string | null
    operationReceiptRoot: string | null
    /** The receipt the node built, exactly as committed to. */
    receipt: Record<string, unknown> | null
}

export type SlotRecord = SlotState & {
    resourceKey: string
    txHash: string
    /** The record this one replaced; null when the slot was vacant. */
    previous: SlotRecord | null
}

export interface WorkAttemptEdit {
    type: "work-attempt"
    isRollback?: boolean
    txhash?: string
    workId: string
    attemptId: string
    canonicalBytesHash: string
    attemptClass?: "normal" | "replacement" | "replay"
    replacementFor?: string | null
}

export interface SlotCasEdit {
    type: "resource-slot-cas"
    isRollback?: boolean
    txhash?: string
    resourceKey: string
    expected: SlotCasExpectation
    transition: "settle" | "rollback"
    workId: string
    conflictDigest: string
}

export type WorkEdit = WorkAttemptEdit | SlotCasEdit

export interface WorkEditOutcome {
    success: boolean
    message: string
}

const ok = (message: string): WorkEditOutcome => ({ success: true, message })
const refuse = (message: string): WorkEditOutcome => ({ success: false, message })

const VACANT: SlotState = { state: "vacant", generation: 0 }

/** Placeholder until `sealWork` writes the receipt the move was made under. */
const PENDING_RECEIPT = ""

export function applyWorkAttempt(
    edit: WorkAttemptEdit,
    works: Map<string, WorkRecord | null>,
    isRollback: boolean,
): WorkEditOutcome {
    const attemptClass = edit.attemptClass ?? "normal"
    const stored = works.get(edit.workId) ?? null

    if (attemptClass === "replay") {
        // A replay recovers the winner's receipt; it writes nothing, so
        // there is nothing to undo either.
        if (isRollback) return ok("replay leaves no state")
        if (!stored) return refuse(`replay of Work ${edit.workId}, which has not run`)
        if (stored.canonicalBytesHash !== edit.canonicalBytesHash) {
            return refuse("a replay must carry the same Work bytes as the attempt that ran")
        }
        if (stored.winnerAttemptId === edit.attemptId) {
            return refuse("a replay needs its own attempt id")
        }
        return ok("replay accepted")
    }

    if (isRollback) {
        if (!stored || stored.winnerAttemptId !== edit.attemptId) {
            return refuse(`cannot undo attempt ${edit.attemptId}: it is not the recorded winner`)
        }
        works.set(edit.workId, null)
        return ok("attempt undone")
    }

    // Single winner: an attempt that reaches the ledger is the one that won,
    // so a second one for the same Work is by definition a double execution.
    if (stored) return refuse(`Work ${edit.workId} already has a winning attempt`)

    const replacementFor = edit.replacementFor ?? null
    if (attemptClass === "replacement") {
        if (!replacementFor || replacementFor === edit.attemptId) {
            return refuse("a replacement must name the attempt it replaces")
        }
    } else if (replacementFor) {
        return refuse("only a replacement may name a replaced attempt")
    }

    works.set(edit.workId, {
        workId: edit.workId,
        winnerAttemptId: edit.attemptId,
        canonicalBytesHash: edit.canonicalBytesHash,
        attemptClass,
        replacementFor,
        txHash: edit.txhash ?? "",
        receiptCommitment: null,
        operationReceiptRoot: null,
        receipt: null,
    })
    return ok("attempt recorded")
}

function slotState(record: SlotRecord | null): SlotState {
    if (!record) return VACANT
    const { resourceKey: _k, txHash: _t, previous: _p, ...state } = record
    return state as SlotState
}

export function applySlotCas(
    edit: SlotCasEdit,
    slots: Map<string, SlotRecord | null>,
    isRollback: boolean,
): WorkEditOutcome {
    const stored = slots.get(edit.resourceKey) ?? null

    if (isRollback) {
        const expectedState = edit.transition === "settle" ? "settled" : "rolled-back"
        if (!stored || stored.state !== expectedState || stored.workId !== edit.workId) {
            return refuse(`cannot undo slot ${edit.resourceKey}: it was not moved by Work ${edit.workId}`)
        }
        slots.set(edit.resourceKey, stored.previous)
        return ok("slot restored")
    }

    if ((edit.transition as string) !== "settle" && (edit.transition as string) !== "rollback") {
        // Reserving leaves the slot in-flight with nothing on chain able to
        // move it on: a Work that commits in one transition never needs it.
        return refuse(`slot transition ${String(edit.transition)} cannot be committed on chain`)
    }
    const before = slotState(stored)
    try {
        assertCasPrecondition(before, edit.expected)
    } catch (error) {
        if (error instanceof SlotCasError) return refuse(error.message)
        throw error
    }

    const next =
        edit.transition === "settle"
            ? settleSlot(before, edit.workId, edit.conflictDigest, PENDING_RECEIPT)
            : rollbackSlot(before, edit.workId, edit.conflictDigest, PENDING_RECEIPT)

    slots.set(edit.resourceKey, {
        ...next,
        resourceKey: edit.resourceKey,
        txHash: edit.txhash ?? "",
        // One level is enough: a block moves a slot at most once
        // (`contendedWorkTxs`), and a rollback only ever undoes that block.
        previous: stored ? { ...stored, previous: null } : null,
    })
    return ok(`slot ${edit.transition === "settle" ? "settled" : "rolled back"}`)
}

/**
 * The shape a transaction's Work edits must have, checked before any runs.
 *
 * One attempt per transaction, so one transaction is one Work. A replay
 * carries nothing else from the Work family: its effects already happened
 * with the winner. A receipt is never accepted from the sender: the node
 * builds it. Every slot names this Work.
 */
export function assertWorkEditSet(
    edits: ReadonlyArray<{ type: string }>,
    sender: string,
): WorkEditOutcome {
    const attempts = edits.filter(e => e.type === "work-attempt") as WorkAttemptEdit[]
    const receipts = edits.filter(e => e.type === "work-receipt")
    const slotEdits = edits.filter(e => e.type === "resource-slot-cas") as SlotCasEdit[]
    const puts = edits.filter(e => e.type === "storage-program-put")

    if (attempts.length !== 1) {
        return refuse(`a Work transaction carries exactly one attempt, not ${attempts.length}`)
    }
    const attempt = attempts[0]
    const firstWorkEdit = edits.findIndex(e =>
        ["work-attempt", "work-receipt", "resource-slot-cas", "storage-program-put"].includes(e.type),
    )
    if (edits[firstWorkEdit] !== attempt) {
        return refuse("the attempt must come before the Work's other edits")
    }

    if (receipts.length) {
        return refuse("a receipt is built by the node, not carried by the sender")
    }
    if (attempt.attemptClass === "replay") {
        if (slotEdits.length || puts.length) {
            return refuse("a replay produces no effects of its own")
        }
        return ok("replay shape")
    }

    for (const slot of slotEdits) {
        if (slot.workId !== attempt.workId) {
            return refuse(`slot ${slot.resourceKey} names a different Work`)
        }
    }
    const keys = new Set(slotEdits.map(s => s.resourceKey))
    if (keys.size !== slotEdits.length) {
        return refuse("a Work moves each slot at most once")
    }
    const targets = new Set<string>()
    for (const put of puts as unknown as { target: string; writer: string }[]) {
        // The address is derived from the writer, so the writer has to be
        // the one who signed; otherwise anyone could derive and fill it.
        if (put.writer?.toLowerCase() !== sender.toLowerCase()) {
            return refuse(`storage write to ${put.target} is not by the sender`)
        }
        if (targets.has(put.target)) return refuse("a Work writes each address at most once")
        targets.add(put.target)
    }
    return ok("Work shape")
}

/** The state a transaction's Work edits touch, as block-wide keys. */
export function workKeys(edits: ReadonlyArray<{ type: string }> | undefined): string[] {
    const keys: string[] = []
    for (const e of edits ?? []) {
        const edit = e as unknown as Record<string, string>
        if (e.type === "work-attempt" || e.type === "work-receipt") keys.push("work:" + edit.workId)
        else if (e.type === "resource-slot-cas") keys.push("slot:" + edit.resourceKey)
        else if (e.type === "storage-program-put") keys.push("sp:" + edit.target)
    }
    return [...new Set(keys)]
}

/**
 * Transactions a block cannot apply because an earlier one in the same
 * block already touches the same Work, slot or storage address.
 *
 * Decided from inclusion order alone, so every node reaches the same answer
 * from the same block. The payoff is at rollback: each record then changed
 * at most once in the block being undone, so the single record it keeps of
 * what it replaced is always the right one to restore.
 */
export function contendedWorkTxs<T extends { hash: string; content: { gcr_edits?: ReadonlyArray<{ type: string }> } }>(
    txs: ReadonlyArray<T>,
): Set<string> {
    const claimed = new Set<string>()
    const contended = new Set<string>()
    for (const tx of txs) {
        const keys = workKeys(tx.content.gcr_edits)
        if (keys.some(k => claimed.has(k))) {
            contended.add(tx.hash)
            continue
        }
        for (const k of keys) claimed.add(k)
    }
    return contended
}

/**
 * Record the receipt the node built for a Work, in the same transition as
 * its effects: on the Work record, and on every slot it moved so the slot
 * says which receipt justified the move.
 */
export function sealWork(
    workId: string,
    receipt: Record<string, unknown>,
    receiptCommitment: string,
    operationReceiptRoot: string,
    slotKeys: string[],
    works: Map<string, WorkRecord | null>,
    slots: Map<string, SlotRecord | null>,
): WorkEditOutcome {
    const record = works.get(workId)
    if (!record || record.receiptCommitment !== null) {
        return refuse(`Work ${workId} has no unsealed winning attempt`)
    }
    // Check every slot before touching anything, so a refusal changes nothing.
    const moved: SlotRecord[] = []
    for (const key of slotKeys) {
        const slot = slots.get(key)
        if (!slot || !("workId" in slot) || slot.workId !== workId) {
            return refuse(`slot ${key} was not moved by Work ${workId}`)
        }
        if (slot.state !== "settled" && slot.state !== "rolled-back") {
            return refuse(`slot ${key} is ${slot.state}, not terminal`)
        }
        moved.push(slot)
    }

    works.set(workId, { ...record, receipt, receiptCommitment, operationReceiptRoot })
    for (const slot of moved) {
        slots.set(
            slot.resourceKey,
            (slot.state === "settled"
                ? { ...slot, receiptCommitment }
                : { ...slot, failureReceiptCommitment: receiptCommitment }) as SlotRecord,
        )
    }
    return ok("Work sealed")
}
