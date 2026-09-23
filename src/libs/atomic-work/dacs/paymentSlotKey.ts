import { assertOsCanonicalAmount } from "@/libs/atomic-work/amountGuard"
import { domainDigest } from "@/libs/atomic-work/digest"
import { DACS_DOMAINS } from "@/libs/atomic-work/dacs/domains"

/**
 * How the DACS profile derives the key of a payment slot.
 *
 * This lives in the binding, not the substrate: the substrate knows that a
 * slot is contended and must be claimed by compare-and-set, and nothing about
 * rails, jobs or phases. Deriving the key from authenticated fields — rather
 * than letting a caller name a slot — is what stops one payment from claiming
 * another's reservation.
 */
export const PAYMENT_SLOT_DOMAIN = DACS_DOMAINS.paymentSlot

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
    return domainDigest(PAYMENT_SLOT_DOMAIN, {
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
}
