/**
 * REHEARSAL-ONLY feature flag — `DEMOS_DISABLE_FORK_MACHINERY`.
 *
 * The flag exists so the rehearsal harness in `testing/forks/rehearsal/`
 * can spin up a node that behaves as if the P3 fork machinery had not
 * been merged (used for the validator-desync and genesis-hash-invariance
 * scenarios) without maintaining a separate pre-fork branch / image tag.
 *
 * When set the loader short-circuits and the in-block migration hook is
 * no-op'd. We verify the loader behaviour here directly; the migration
 * hook side is covered by reading the same predicate.
 *
 * THESE TESTS MUST FAIL LOUDLY IF THE FLAG STARTS LEAKING ELSEWHERE.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
    isForkMachineryDisabled,
    loadForkConfigFromGenesis,
} from "@/forks/loadForkConfig"
import {
    cloneDefaultForkConfig,
    type ForkConfig,
    type ForkName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("DEMOS_DISABLE_FORK_MACHINERY (rehearsal flag)", () => {
    let snapshot: Record<ForkName, ForkConfig>
    let priorEnv: string | undefined
    let priorNodeEnv: string | undefined
    let priorRehearsal: string | undefined

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
        priorEnv = process.env.DEMOS_DISABLE_FORK_MACHINERY
        priorNodeEnv = process.env.NODE_ENV
        priorRehearsal = process.env.DEMOS_REHEARSAL
        delete process.env.DEMOS_DISABLE_FORK_MACHINERY
        delete process.env.DEMOS_REHEARSAL
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
        if (priorEnv === undefined) {
            delete process.env.DEMOS_DISABLE_FORK_MACHINERY
        } else {
            process.env.DEMOS_DISABLE_FORK_MACHINERY = priorEnv
        }
        if (priorNodeEnv === undefined) {
            delete process.env.NODE_ENV
        } else {
            process.env.NODE_ENV = priorNodeEnv
        }
        if (priorRehearsal === undefined) {
            delete process.env.DEMOS_REHEARSAL
        } else {
            process.env.DEMOS_REHEARSAL = priorRehearsal
        }
    })

    it("defaults to disabled (production-safe)", () => {
        expect(isForkMachineryDisabled()).toBe(false)
    })

    it("recognises 'true', '1', 'yes' as truthy", () => {
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "true"
        expect(isForkMachineryDisabled()).toBe(true)
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "1"
        expect(isForkMachineryDisabled()).toBe(true)
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "YES"
        expect(isForkMachineryDisabled()).toBe(true)
    })

    it("treats unrelated strings as falsy", () => {
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "false"
        expect(isForkMachineryDisabled()).toBe(false)
        process.env.DEMOS_DISABLE_FORK_MACHINERY = ""
        expect(isForkMachineryDisabled()).toBe(false)
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "no"
        expect(isForkMachineryDisabled()).toBe(false)
    })

    it("loadForkConfigFromGenesis ignores `forks` when flag is set", () => {
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "true"
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: { activationHeight: 5 },
            },
        })
        // Default config retained: activation stays null (inactive).
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBeNull()
    })

    it("loadForkConfigFromGenesis still hydrates when flag is unset", () => {
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: { activationHeight: 42 },
            },
        })
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBe(42)
    })

    // myc#82 / GH#3213217875: production guard — a misconfigured production
    // validator with the flag set silently caused a consensus split when
    // peers crossed activation. Now we hard-throw at startup.
    it("hard-throws when set in NODE_ENV=production without DEMOS_REHEARSAL opt-in", () => {
        process.env.NODE_ENV = "production"
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "true"
        expect(() => isForkMachineryDisabled()).toThrow(
            /DEMOS_DISABLE_FORK_MACHINERY/,
        )
    })

    it("does not throw in production when DEMOS_REHEARSAL=true opt-in is set", () => {
        process.env.NODE_ENV = "production"
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "true"
        process.env.DEMOS_REHEARSAL = "true"
        // Still returns true (the flag is honored), but does not throw —
        // the operator has explicitly acknowledged the consensus risk.
        expect(isForkMachineryDisabled()).toBe(true)
    })

    it("does not throw in NODE_ENV=development (rehearsal default)", () => {
        process.env.NODE_ENV = "development"
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "true"
        expect(isForkMachineryDisabled()).toBe(true)
    })

    it("does not throw when NODE_ENV is unset (test default)", () => {
        delete process.env.NODE_ENV
        process.env.DEMOS_DISABLE_FORK_MACHINERY = "true"
        expect(isForkMachineryDisabled()).toBe(true)
    })
})
