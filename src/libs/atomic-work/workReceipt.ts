import {
    computeInputHash,
    computeOperationReceiptRoot,
    computeOutputHash,
} from "@/libs/atomic-work/operationReceipt"
import type { AtomicWorkProfile } from "@/libs/atomic-work/profile"
import { computeReceiptCommitment } from "@/libs/atomic-work/receiptCommitment"
import { storageValueDigest } from "@/libs/atomic-work/storageWrite"
import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

/**
 * The receipt a node builds for a Work it has just executed.
 *
 * Built from the intent and from the effects actually applied, never taken
 * from the sender: the receipt commits to the block the Work lands in, which
 * no sender can know when signing, and a receipt someone else wrote is a
 * claim, not evidence.
 *
 * `blockRef` carries the block's height and, when the node applies the Work
 * as part of a block, its consensus timestamp. Both are fixed before the
 * block's transactions run and read back identically by every syncing node.
 */

export interface AppliedStorageWrite {
    target: string
    writer: string
    valueDigest: string
}

/** A slot the Work moved: what the edit expected, and what it left. */
export interface SlotMove {
    resourceKey: string
    before: { state: string; generation: number }
    after: { state: string; generation: number; workId: string; conflictDigest: string }
}

/** A payment the Work made from its sender. */
export interface AppliedTransfer {
    from: string
    to: string
    amount: string
}

export interface ReceiptInputs {
    intent: Record<string, unknown>
    profile: AtomicWorkProfile
    workId: string
    attemptId: string
    txHash: string
    height: number
    nonce: number | string
    /** The Work's storage writes, in any order; each is matched to its operation. */
    writes: AppliedStorageWrite[]
    /** The slots the Work moved. A slot left `rolled-back` rolls the Work back. */
    slots?: SlotMove[]
    /** The payments the Work made. */
    transfers?: AppliedTransfer[]
    /** The block's consensus time in ms; absent only in a simulation. */
    timestampMs?: number
}

export interface BuiltReceipt {
    receipt: Record<string, unknown>
    receiptCommitment: string
    operationReceiptRoot: string
}

interface IntentOperation {
    operationId: string
    kind: string
    payload?: { logicalAddress?: unknown; artifact?: unknown } & Record<string, unknown>
}

/**
 * Match each storage write to the operation that authorized it.
 *
 * An operation that names its value (`payload.artifact`) gets the write of
 * exactly that value: position alone would let a reordered set of writes
 * put one operation's value at another's address while the receipt still
 * reported them as declared. An operation that names no value takes the
 * next unmatched write in order.
 *
 * @returns One write per storage operation, in operation order.
 * @throws If a write is missing, unaccounted for, or its value is not the one
 * its operation declares.
 */
export function matchWritesToOperations(
    operations: ReadonlyArray<IntentOperation>,
    writes: ReadonlyArray<AppliedStorageWrite>,
): Map<string, AppliedStorageWrite> {
    const unused = [...writes]
    const matched = new Map<string, AppliedStorageWrite>()
    for (const op of operations) {
        if (op.kind !== "storage-program-put") continue
        let index: number
        if (op.payload && "artifact" in op.payload) {
            const digest = storageValueDigest(op.payload.artifact)
            index = unused.findIndex(w => w.valueDigest === digest)
            if (index < 0) {
                throw new Error(
                    `operation ${op.operationId} declares a write the Work did not make with its value`,
                )
            }
        } else {
            index = 0
            if (unused.length === 0) {
                throw new Error(`operation ${op.operationId} declares a write the Work did not make`)
            }
        }
        matched.set(op.operationId, unused.splice(index, 1)[0])
    }
    if (unused.length > 0) {
        throw new Error("the Work made writes its operations do not declare")
    }
    return matched
}

export function buildWorkReceipt(inputs: ReceiptInputs): BuiltReceipt {
    const operations = (inputs.intent.operations ?? []) as IntentOperation[]
    const slots = inputs.slots ?? []
    const transfers = inputs.transfers ?? []

    // A Work that moved a slot to rolled-back made no effects of its own
    // (the edit set is checked for that before anything applies), so its
    // receipt says so rather than reporting every operation committed.
    const rolledBack = slots.some(s => s.after.state === "rolled-back")
    if (rolledBack && (inputs.writes.length > 0 || transfers.length > 0)) {
        throw new Error("a rolled-back Work cannot have written storage or moved funds")
    }
    const writes = rolledBack ? new Map() : matchWritesToOperations(operations, inputs.writes)

    // Each write carries its own nonce, as the reference receipts assign
    // them: the transaction's nonce plus the operation's index.
    const baseNonce = BigInt(inputs.nonce)

    const operationResults = operations.map((op, operationIndex) => {
        const result: Record<string, unknown> = {
            operationId: op.operationId,
            operationIndex,
            operationKind: op.kind,
            inputHash: computeInputHash(op.payload ?? null),
        }
        if (rolledBack) {
            if (op.kind === "native-dem-transfer") {
                result.status = "not-executed"
            } else {
                result.status = "rolled-back"
                result.errorCode = SLOT_KINDS.has(op.kind) ? "slot-rolled-back" : "atomic-rollback"
            }
            return result
        }
        result.status = "committed"
        if (op.kind === "storage-program-put") {
            const applied = writes.get(op.operationId) as AppliedStorageWrite
            result.storageOutput = {
                logicalAddress: op.payload?.logicalAddress ?? null,
                nativeAddress: applied.target,
                contentHash: applied.valueDigest,
                writer: applied.writer,
                nonce: String(baseNonce + BigInt(operationIndex)),
            }
        }
        result.outputHash = computeOutputHash({
            kind: op.kind,
            payload: op.payload ?? null,
            storageOutput: result.storageOutput,
            operationId: op.operationId,
        })
        return result
    })

    const operationReceiptRoot = computeOperationReceiptRoot(
        operationResults,
        inputs.profile.domains.operationReceipt,
    )

    // What the Work actually changed, so a matching commitment establishes
    // its effects and not only its operation claims: every slot it moved
    // (before and after) and every payment and write it made.
    const effects = {
        slots: slots.map(s => ({ resourceKey: s.resourceKey, before: s.before, after: s.after })),
        transfers: transfers.map(t => ({ from: t.from, to: t.to, amount: t.amount })),
        writes: [...writes.values()].map(w => ({ nativeAddress: w.target, contentHash: w.valueDigest })),
    }

    const receipt: Record<string, unknown> = {
        receiptVersion: "1",
        executionProfile: inputs.intent.executionProfile ?? null,
        profile: inputs.profile.name,
        networkId: inputs.intent.networkId ?? null,
        workId: inputs.workId,
        winningAttempt: {
            attemptId: inputs.attemptId,
            nativeTransactionRef: { kind: "demos-transaction", value: inputs.txHash },
        },
        blockRef:
            inputs.timestampMs === undefined
                ? { height: String(inputs.height) }
                : { height: String(inputs.height), timestamp: inputs.timestampMs },
        outcome: rolledBack ? "rolled-back" : "committed",
        operationResults,
        operationReceiptRoot,
        effects,
        effectsRoot: Hashing.sha256(jcsCanonicalize(effects)),
        envelopeEffects: { nonceConsumed: true },
    }
    const receiptCommitment = computeReceiptCommitment(receipt, inputs.profile.domains.workReceipt)
    return { receipt: { ...receipt, receiptCommitment }, receiptCommitment, operationReceiptRoot }
}

const SLOT_KINDS = new Set(["resource-slot-cas", "payment-slot-cas"])
