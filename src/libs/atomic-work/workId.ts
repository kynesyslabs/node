import { domainDigest } from "@/libs/atomic-work/digest"

/**
 * The identity of an atomic Work.
 *
 * workId = sha256(domain ‖ JCS(unsignedIntent)), where the domain belongs to
 * the profile. The node MUST recompute this from the unsigned intent and never
 * trust a caller-supplied value, or a Work could claim another's identity.
 */
export function computeWorkId(unsignedIntent: unknown, domain: string): string {
    return domainDigest(domain, unsignedIntent)
}
