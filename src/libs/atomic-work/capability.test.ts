import { beforeEach, describe, expect, it } from "bun:test"

import {
    advertisesProfile,
    atomicWorkCapability,
    capabilityDigest,
} from "@/libs/atomic-work/capability"
import { clearAtomicWorkProfilesForTesting } from "@/libs/atomic-work/profile"
import {
    clearOperationKindsForTesting,
    declareNativeOperationKinds,
} from "@/libs/atomic-work/effectBoundary"
import { DEFAULT_ATOMIC_WORK_LIMITS } from "@/libs/atomic-work/limits"
import { registerDacsAtomicWorkProfiles } from "@/libs/atomic-work/dacs/profile"

const DOMAIN = "test-capability:v1:"

beforeEach(() => {
    clearAtomicWorkProfilesForTesting()
    clearOperationKindsForTesting()
    declareNativeOperationKinds()
})

describe("what a node advertises", () => {
    it("claims no profile it has not registered", () => {
        // Generic atomic support is not DACS support. A node that never
        // registered the profile must not appear to run it.
        const capability = atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS)

        expect(capability.profiles).toEqual([])
        expect(advertisesProfile(capability, "dacs-purchase-v1")).toBe(false)
    })

    it("advertises a profile once it is registered", () => {
        registerDacsAtomicWorkProfiles()
        const capability = atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS)

        expect(advertisesProfile(capability, "dacs-purchase-v1")).toBe(true)
        expect(advertisesProfile(capability, "dacs-completion-v1")).toBe(true)
    })

    it("says which operation kinds cannot be rolled back", () => {
        const capability = atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS)
        const byKind = new Map(capability.operationKinds.map(k => [k.kind, k.effect]))

        expect(byKind.get("storage-program-put")).toBe("state")
        expect(byKind.get("crosschain-transfer")).toBe("external")
    })

    it("publishes the limits it actually enforces", () => {
        const capability = atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS)

        expect(capability.limits).toEqual(DEFAULT_ATOMIC_WORK_LIMITS)
        expect(capability.limits).not.toBe(DEFAULT_ATOMIC_WORK_LIMITS)
    })

    it("requires an engine version", () => {
        expect(() => atomicWorkCapability("", DEFAULT_ATOMIC_WORK_LIMITS)).toThrow()
        expect(() => atomicWorkCapability(" 0.9.9", DEFAULT_ATOMIC_WORK_LIMITS)).toThrow()
    })
})

describe("comparing advertisements", () => {
    it("gives two identical nodes the same digest", () => {
        registerDacsAtomicWorkProfiles()
        const a = capabilityDigest(atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS), DOMAIN)
        const b = capabilityDigest(atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS), DOMAIN)

        expect(a).toBe(b)
    })

    it("changes the digest when any enforced fact changes", () => {
        const base = capabilityDigest(atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS), DOMAIN)
        const otherVersion = capabilityDigest(atomicWorkCapability("0.9.10", DEFAULT_ATOMIC_WORK_LIMITS), DOMAIN)
        const tighter = capabilityDigest(
            atomicWorkCapability("0.9.9", { ...DEFAULT_ATOMIC_WORK_LIMITS, maxOperations: 8 }),
            DOMAIN,
        )
        registerDacsAtomicWorkProfiles()
        const withProfile = capabilityDigest(atomicWorkCapability("0.9.9", DEFAULT_ATOMIC_WORK_LIMITS), DOMAIN)

        expect(new Set([base, otherVersion, tighter, withProfile]).size).toBe(4)
    })
})
