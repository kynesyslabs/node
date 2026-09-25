/**
 * What a profile tells the atomic engine.
 *
 * The engine executes Works; it does not know what a Work is for. A profile
 * supplies the fixed operation shape, the roles that shape refers to, the
 * domain tags its digests are computed under, and — where its receipt embeds
 * its own commitment — which fields to project out before committing to it.
 *
 * Keeping this a registry rather than a set of imports is what lets the
 * substrate stay free of any particular profile: adding one is registration,
 * and generic atomic support alone advertises no profile at all.
 */

export interface ExpectedOperation {
    operationId: string
    kinds: string[]
    dependsOn: string[]
    requiredRoles: string[]
}

export interface AtomicWorkProfile {
    /** The name an intent carries, matched verbatim. */
    name: string
    /** The one operation graph an intent under this profile may have. */
    operationGraph: ExpectedOperation[]
    /** Role names, in the order signatures are expected to cover them. */
    roles: readonly string[]
    /** Domain tags this profile's digests are separated by. */
    domains: {
        workId: string
        authorization: string
        operationReceipt: string
        workReceipt: string
    }
    /**
     * Remove the fields this profile's receipt would otherwise commit to
     * circularly. Called on a clone; mutate it in place.
     */
    projectReceiptCore?(core: Record<string, unknown>): void
    /**
     * Check that every operation carries the authorizations its roles
     * require, each bound to this Work and validly signed. Throws on the
     * first failure. A profile without it cannot have its Works executed:
     * effects nobody authorized are not the profile's to commit.
     */
    verifyAuthorizations?(
        intent: Record<string, unknown>,
        authorizations: Record<string, unknown>[],
        workId: string,
        verifySignature: (input: { signer: unknown; signedBytes: string; signature: string }) => boolean,
    ): void
}

const profiles = new Map<string, AtomicWorkProfile>()

export function registerAtomicWorkProfile(profile: AtomicWorkProfile): void {
    const existing = profiles.get(profile.name)
    if (existing && existing !== profile) {
        throw new Error(`atomic work profile '${profile.name}' is already registered`)
    }
    profiles.set(profile.name, profile)
}

export function atomicWorkProfile(name: string | undefined): AtomicWorkProfile | undefined {
    return name === undefined ? undefined : profiles.get(name)
}

/** Every registered profile name, for capability advertisement. */
export function registeredAtomicWorkProfiles(): string[] {
    return [...profiles.keys()].sort()
}

/** Test seam: drop registrations so a suite cannot leak into the next. */
export function clearAtomicWorkProfilesForTesting(): void {
    profiles.clear()
}
