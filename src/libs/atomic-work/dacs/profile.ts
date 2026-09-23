import {
    registerAtomicWorkProfile,
    type AtomicWorkProfile,
    type ExpectedOperation,
} from "@/libs/atomic-work/profile"
import { DACS_DOMAINS } from "@/libs/atomic-work/dacs/domains"

/**
 * The DACS Atomic Work profile binding.
 *
 * Everything DACS-shaped is here: the two operation graphs, the role names
 * those graphs refer to, and the one place a DACS receipt embeds its own
 * commitment. The substrate holds none of it, which is what keeps generic
 * atomic support from implying DACS support — registering this profile is a
 * deliberate act, and advertisement follows registration, not capability.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
}

export const DACS_ROLES = ["buyer", "seller", "orchestrator", "payer"] as const

/** Purchase: buyer and seller vetting, agreement, commitment, slot, payment. */
export const PURCHASE_GRAPH: ExpectedOperation[] = [
    { operationId: "buyer-vet", kinds: ["assert-artifact", "storage-program-put"], dependsOn: [], requiredRoles: ["orchestrator"] },
    { operationId: "seller-vet", kinds: ["assert-artifact", "storage-program-put"], dependsOn: [], requiredRoles: ["orchestrator"] },
    { operationId: "agreement", kinds: ["assert-artifact"], dependsOn: ["buyer-vet", "seller-vet"], requiredRoles: ["orchestrator"] },
    { operationId: "commitment", kinds: ["storage-program-put"], dependsOn: ["agreement"], requiredRoles: ["orchestrator"] },
    { operationId: "payment-slot", kinds: ["payment-slot-cas"], dependsOn: ["commitment"], requiredRoles: ["payer"] },
    { operationId: "payment", kinds: ["native-dem-transfer"], dependsOn: ["payment-slot"], requiredRoles: ["payer"] },
]

/** Completion: the purchase receipt, then delivery. */
export const COMPLETION_GRAPH: ExpectedOperation[] = [
    { operationId: "purchase-receipt", kinds: ["assert-work-receipt"], dependsOn: [], requiredRoles: ["orchestrator"] },
    { operationId: "delivery", kinds: ["storage-program-put"], dependsOn: ["purchase-receipt"], requiredRoles: ["seller"] },
]

export const DACS_PURCHASE_PROFILE: AtomicWorkProfile = {
    name: "dacs-purchase-v1",
    operationGraph: PURCHASE_GRAPH,
    roles: DACS_ROLES,
    domains: DACS_DOMAINS,
    /**
     * The slot's `after` state carries the very commitment being computed, so
     * committing to it would be circular.
     */
    projectReceiptCore(core) {
        if (!isPlainObject(core.paymentSlot)) return
        const after = (core.paymentSlot as Record<string, unknown>).after
        if (isPlainObject(after)) {
            delete after.receiptCommitment
            delete after.failureReceiptCommitment
        }
    },
}

export const DACS_COMPLETION_PROFILE: AtomicWorkProfile = {
    name: "dacs-completion-v1",
    operationGraph: COMPLETION_GRAPH,
    roles: DACS_ROLES,
    domains: DACS_DOMAINS,
}

/** Register both DACS profiles. Idempotent. */
export function registerDacsAtomicWorkProfiles(): void {
    registerAtomicWorkProfile(DACS_PURCHASE_PROFILE)
    registerAtomicWorkProfile(DACS_COMPLETION_PROFILE)
}
