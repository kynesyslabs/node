import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { assertOsCanonicalAmount } from "@/libs/atomic-work/amountGuard"

/** Domain separation tag — normative (Binding-Pass §5, AWS-1/7). */
export const PAYMENT_SLOT_DOMAIN = "dacs-atomic-payment-slot:v1:"

/**
 * The exact, normative field set of a payment-slot conflict digest.
 * The CAS key is the first four fields; the digest binds the full commitment.
 */
export interface PaymentSlotConflictFields {
    networkId: string
    railId: string
    jobId: string
    phaseIndex: number
    agreementHash: string
    commitmentLogicalAddress: string
    payer: string
    payee: string
    asset: string
    amount: string
}

/**
 * conflictDigest = SHA-256("dacs-atomic-payment-slot:v1:" ‖ JCS({...10 fields})).
 * Field SET and names are normative; JCS sorts keys so literal order is irrelevant.
 */
export function computeConflictDigest(f: PaymentSlotConflictFields): string {
    assertOsCanonicalAmount(f.amount, "amount")
    const canonical = jcsCanonicalize({
        networkId: f.networkId,
        railId: f.railId,
        jobId: f.jobId,
        phaseIndex: f.phaseIndex,
        agreementHash: f.agreementHash,
        commitmentLogicalAddress: f.commitmentLogicalAddress,
        payer: f.payer,
        payee: f.payee,
        asset: f.asset,
        amount: f.amount,
    })
    return Hashing.sha256(PAYMENT_SLOT_DOMAIN + canonical)
}
