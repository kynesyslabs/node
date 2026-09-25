import {
    computeInputHash,
    computeOperationReceiptRoot,
    computeOutputHash,
} from "@/libs/atomic-work/operationReceipt"
import type { AtomicWorkProfile } from "@/libs/atomic-work/profile"
import { computeReceiptCommitment } from "@/libs/atomic-work/receiptCommitment"

/**
 * The receipt a node builds for a Work it has just executed.
 *
 * Built from the intent and from the effects actually applied, never taken
 * from the sender: the receipt commits to the block the Work lands in, which
 * no sender can know when signing, and a receipt someone else wrote is a
 * claim, not evidence.
 *
 * `blockRef` carries the height only. The block's timestamp is settled after
 * its transactions are applied, so no node could commit to it here; the block
 * at that height is the timestamp's authority.
 */

export interface AppliedStorageWrite {
    target: string
    writer: string
    valueDigest: string
}

export interface ReceiptInputs {
    intent: Record<string, unknown>
    profile: AtomicWorkProfile
    workId: string
    attemptId: string
    txHash: string
    height: number
    nonce: number | string
    /** The Work's storage writes, in the order its operations declare them. */
    writes: AppliedStorageWrite[]
}

export interface BuiltReceipt {
    receipt: Record<string, unknown>
    receiptCommitment: string
    operationReceiptRoot: string
}

interface IntentOperation {
    operationId: string
    kind: string
    payload?: { logicalAddress?: unknown } & Record<string, unknown>
}

export function buildWorkReceipt(inputs: ReceiptInputs): BuiltReceipt {
    const operations = (inputs.intent.operations ?? []) as IntentOperation[]
    let write = 0

    const operationResults = operations.map((op, operationIndex) => {
        const result: Record<string, unknown> = {
            operationId: op.operationId,
            operationIndex,
            operationKind: op.kind,
            inputHash: computeInputHash(op.payload ?? null),
            status: "committed",
        }
        if (op.kind === "storage-program-put") {
            const applied = inputs.writes[write++]
            if (!applied) {
                throw new Error(`operation ${op.operationId} declares a write the Work did not make`)
            }
            result.storageOutput = {
                logicalAddress: op.payload?.logicalAddress ?? null,
                nativeAddress: applied.target,
                contentHash: applied.valueDigest,
                writer: applied.writer,
                nonce: String(inputs.nonce),
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
    if (write !== inputs.writes.length) {
        throw new Error("the Work made writes its operations do not declare")
    }

    const operationReceiptRoot = computeOperationReceiptRoot(
        operationResults,
        inputs.profile.domains.operationReceipt,
    )
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
        blockRef: { height: String(inputs.height) },
        outcome: "committed",
        operationResults,
        operationReceiptRoot,
    }
    const receiptCommitment = computeReceiptCommitment(receipt, inputs.profile.domains.workReceipt)
    return { receipt: { ...receipt, receiptCommitment }, receiptCommitment, operationReceiptRoot }
}
