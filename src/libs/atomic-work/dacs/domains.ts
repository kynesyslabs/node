/**
 * The domain tags the DACS Atomic Work profile computes its digests under.
 *
 * They are normative: the bytes have to match the DACS reference exactly, or a
 * receipt this node produces verifies nowhere else. They live here rather than
 * beside the code that hashes, because they belong to the profile — the
 * substrate takes a tag as an argument and never names one.
 */
export const DACS_DOMAINS: {
    workId: string
    authorization: string
    operationReceipt: string
    workReceipt: string
    paymentSlot: string
} = {
    workId: "dacs-atomic-work:v1:",
    authorization: "dacs-atomic-work-authorization:v1:",
    operationReceipt: "dacs-atomic-operation-receipt:v1:",
    workReceipt: "dacs-atomic-work-receipt:v1:",
    paymentSlot: "dacs-atomic-payment-slot:v1:",
}
