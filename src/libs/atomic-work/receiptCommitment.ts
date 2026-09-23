import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

/** Domain separation tag — normative (matches DACS WORK_RECEIPT_DOMAIN). */
export const WORK_RECEIPT_DOMAIN = "dacs-atomic-work-receipt:v1:"

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * receiptCommitment = SHA-256("dacs-atomic-work-receipt:v1:" ‖ JCS(core)), where
 * `core` is the receipt with the non-committed / self-referential fields
 * projected out (a faithful port of the DACS reference `_receipt_commitment`):
 *
 *   - top-level `receiptCommitment` and `finalityEvidence` removed;
 *   - `blockRef.id`, `businessState.evidence`, and top-level `slotStateEvidence`
 *     removed (post-commit evidence the commitment must not bind);
 *   - for the `dacs-purchase-v1` profile only, the payment slot's `after`
 *     `receiptCommitment` / `failureReceiptCommitment` removed (they embed this
 *     very commitment and would be circular).
 *
 * The input receipt is not mutated (it is deep-cloned first).
 */
export function computeReceiptCommitment(receipt: Record<string, unknown>): string {
    const core = structuredClone(receipt) as Record<string, unknown>
    delete core.receiptCommitment
    delete core.finalityEvidence

    if (isPlainObject(core.blockRef)) delete core.blockRef.id
    if (isPlainObject(core.businessState)) delete core.businessState.evidence
    delete core.slotStateEvidence

    if (core.profile === "dacs-purchase-v1" && isPlainObject(core.paymentSlot)) {
        const after = (core.paymentSlot as Record<string, unknown>).after
        if (isPlainObject(after)) {
            delete after.receiptCommitment
            delete after.failureReceiptCommitment
        }
    }

    return Hashing.sha256(WORK_RECEIPT_DOMAIN + jcsCanonicalize(core))
}
