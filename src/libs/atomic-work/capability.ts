import { domainDigest } from "@/libs/atomic-work/digest"
import { declaredOperationKinds, effectClassOf } from "@/libs/atomic-work/effectBoundary"
import { type AtomicWorkLimits } from "@/libs/atomic-work/limits"
import { registeredAtomicWorkProfiles } from "@/libs/atomic-work/profile"

/**
 * What this node says it can do, in a form a submitter can check.
 *
 * A capability claim is only useful if it is exact and cannot drift from what
 * the node enforces. So it is assembled from the same registries admission
 * uses — the profiles registered, the operation kinds declared and which side
 * of the rollback boundary each sits on, the limits in force — rather than
 * written down separately and hoped to match.
 *
 * It advertises only what is registered. Generic atomic support is not
 * support for any particular profile, and a node that has not registered one
 * says nothing about it — which is how "the engine can do this" stays distinct
 * from "this node runs that profile".
 *
 * The digest makes the claim comparable: two nodes advertise the same
 * capability exactly when the digests match, and a submitter can pin one.
 */

export const ATOMIC_CAPABILITY_VERSION = "1"

export interface AtomicWorkCapability {
    capabilityVersion: typeof ATOMIC_CAPABILITY_VERSION
    engineVersion: string
    profiles: string[]
    operationKinds: { kind: string; effect: "state" | "external" }[]
    limits: AtomicWorkLimits
    canonicalization: "jcs-rfc8785+cf1-values"
    digestAlgorithm: "sha256"
}

export function atomicWorkCapability(
    engineVersion: string,
    limits: AtomicWorkLimits,
): AtomicWorkCapability {
    if (!engineVersion || engineVersion.trim() !== engineVersion) {
        throw new Error("an engine version is required and must carry no surrounding whitespace")
    }
    return {
        capabilityVersion: ATOMIC_CAPABILITY_VERSION,
        engineVersion,
        // Sorted, so the digest does not depend on registration order.
        profiles: registeredAtomicWorkProfiles(),
        operationKinds: declaredOperationKinds().map(kind => ({
            kind,
            effect: effectClassOf(kind)!,
        })),
        limits: { ...limits },
        canonicalization: "jcs-rfc8785+cf1-values",
        digestAlgorithm: "sha256",
    }
}

/** Two nodes advertise the same capability exactly when this matches. */
export function capabilityDigest(capability: AtomicWorkCapability, domain: string): string {
    return domainDigest(domain, capability)
}

/**
 * Does this node run the named profile?
 *
 * Asked of the advertisement rather than of the engine, because the question a
 * submitter has is what this node will accept, not what it could be made to.
 */
export function advertisesProfile(capability: AtomicWorkCapability, profile: string): boolean {
    return capability.profiles.includes(profile)
}
