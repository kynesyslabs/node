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
 * rolled-back, with the receipt that justifies the move. The in-flight state
 * exists only inside the overlay while the Work runs.
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
    effectsRoot: string | null
    inputHash: string | null
    outputHash: string | null
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

export interface WorkReceiptEdit {
    type: "work-receipt"
    isRollback?: boolean
    txhash?: string
    workId: string
    receiptCommitment: string
    effectsRoot: string
    inputHash: string
    outputHash: string
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
    receiptCommitment: string
}

export type WorkEdit = WorkAttemptEdit | WorkReceiptEdit | SlotCasEdit

export interface WorkEditOutcome {
    success: boolean
    message: string
}

const ok = (message: string): WorkEditOutcome => ({ success: true, message })
const refuse = (message: string): WorkEditOutcome => ({ success: false, message })

const VACANT: SlotState = { state: "vacant", generation: 0 }

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
        effectsRoot: null,
        inputHash: null,
        outputHash: null,
    })
    return ok("attempt recorded")
}

export function applyWorkReceipt(
    edit: WorkReceiptEdit,
    works: Map<string, WorkRecord | null>,
    isRollback: boolean,
): WorkEditOutcome {
    const stored = works.get(edit.workId) ?? null
    if (!stored) return refuse(`no winning attempt for Work ${edit.workId}`)

    if (isRollback) {
        if (stored.receiptCommitment !== edit.receiptCommitment) {
            return refuse("cannot undo a receipt that is not the recorded one")
        }
        works.set(edit.workId, {
            ...stored,
            receiptCommitment: null,
            effectsRoot: null,
            inputHash: null,
            outputHash: null,
        })
        return ok("receipt undone")
    }

    if (stored.receiptCommitment !== null) {
        return refuse(`Work ${edit.workId} already has a receipt`)
    }
    works.set(edit.workId, {
        ...stored,
        receiptCommitment: edit.receiptCommitment,
        effectsRoot: edit.effectsRoot,
        inputHash: edit.inputHash,
        outputHash: edit.outputHash,
    })
    return ok("receipt recorded")
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
    if (!edit.receiptCommitment) {
        return refuse("a slot moves only with the receipt that justifies it")
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
            ? settleSlot(before, edit.workId, edit.conflictDigest, edit.receiptCommitment)
            : rollbackSlot(before, edit.workId, edit.conflictDigest, edit.receiptCommitment)

    slots.set(edit.resourceKey, {
        ...next,
        resourceKey: edit.resourceKey,
        txHash: edit.txhash ?? "",
        previous: stored,
    })
    return ok(`slot ${edit.transition === "settle" ? "settled" : "rolled back"}`)
}

/**
 * The shape a transaction's Work edits must have, checked before any runs.
 *
 * One attempt per transaction, so one transaction is one Work. A replay
 * carries nothing else from the Work family: its effects already happened
 * with the winner. Anything else commits its receipt in the same transition
 * as the slots it moves, and every slot names the receipt it moved with.
 */
export function assertWorkEditSet(edits: ReadonlyArray<{ type: string }>): WorkEditOutcome {
    const attempts = edits.filter(e => e.type === "work-attempt") as WorkAttemptEdit[]
    const receipts = edits.filter(e => e.type === "work-receipt") as WorkReceiptEdit[]
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

    if (attempt.attemptClass === "replay") {
        if (receipts.length || slotEdits.length || puts.length) {
            return refuse("a replay produces no effects of its own")
        }
        return ok("replay shape")
    }

    if (receipts.length !== 1) {
        return refuse("a Work commits exactly one receipt with its effects")
    }
    const receipt = receipts[0]
    if (receipt.workId !== attempt.workId) {
        return refuse("the receipt names a different Work than the attempt")
    }
    for (const slot of slotEdits) {
        if (slot.workId !== attempt.workId) {
            return refuse(`slot ${slot.resourceKey} names a different Work`)
        }
        if (slot.receiptCommitment !== receipt.receiptCommitment) {
            return refuse(`slot ${slot.resourceKey} moves with a receipt other than this Work's`)
        }
    }
    const keys = new Set(slotEdits.map(s => s.resourceKey))
    if (keys.size !== slotEdits.length) {
        return refuse("a Work moves each slot at most once")
    }
    return ok("Work shape")
}
