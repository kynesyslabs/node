import {
    registerAtomicWorkProfile,
    type AtomicWorkProfile,
    type ExpectedOperation,
} from "@/libs/atomic-work/profile"
import { DACS_DOMAINS } from "@/libs/atomic-work/dacs/domains"
import { DACS_ROLES } from "@/libs/atomic-work/dacs/roles"
import {
    verifyAuthorizationCoverage,
    type AuthzIntent,
} from "@/libs/atomic-work/dacs/authorization"

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

export { DACS_ROLES }

/**
 * The payer's native account is the one the Work's payment debits, and the
 * node debits the submitter. So they must be the same account. A relayed
 * payment, submitted by someone else on the payer's behalf, needs a bundle
 * binding the node does not accept yet, and is refused rather than silently
 * charged to the relayer.
 */
const assertSubmitter: AtomicWorkProfile["assertSubmitter"] = (intent, submitter) => {
    const roster = (intent.roleRoster ?? []) as { role: string; signer?: unknown; nativeAccount?: unknown }[]
    const payer = roster.find(r => r.role === "payer")
    if (!payer) throw new Error("the intent names no payer")
    const account = typeof payer.nativeAccount === "string" ? payer.nativeAccount : payer.signer
    if (typeof account !== "string" || account.toLowerCase() !== submitter.toLowerCase()) {
        throw new Error(
            "the submitter is not the payer's native account; a relayed payment needs a bundle binding this node does not accept",
        )
    }
}

const verifyAuthorizations: AtomicWorkProfile["verifyAuthorizations"] = (
    intent,
    authorizations,
    workId,
    verifySignature,
) => verifyAuthorizationCoverage(intent as unknown as AuthzIntent, authorizations, workId, verifySignature)

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
    verifyAuthorizations,
    assertSubmitter,
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
    verifyAuthorizations,
}

/** Register both DACS profiles. Idempotent. */
export function registerDacsAtomicWorkProfiles(): void {
    registerAtomicWorkProfile(DACS_PURCHASE_PROFILE)
    registerAtomicWorkProfile(DACS_COMPLETION_PROFILE)
}
