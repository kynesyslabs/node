import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

/** Domain separation tag — normative (Binding-Pass §5, AW-14/16/17/18). */
export const ATOMIC_WORK_ID_DOMAIN = "dacs-atomic-work:v1:"

/**
 * workId = SHA-256("dacs-atomic-work:v1:" ‖ JCS(unsignedIntent)).
 *
 * WHY: the node MUST recompute this from the unsigned intent and never trust a
 * caller-supplied value (AW-14/16/17/18).
 */
export function computeWorkId(unsignedIntent: unknown): string {
    return Hashing.sha256(ATOMIC_WORK_ID_DOMAIN + jcsCanonicalize(unsignedIntent))
}
