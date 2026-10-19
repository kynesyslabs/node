/**
 * Tests for the dormant `atomicWork` fork (DACS §A.6).
 *
 * The fork must ship configured-but-never-active: `activationHeight: null`,
 * so `isForkActive("atomicWork", h)` is false at every height until an
 * operator pins a real activation height. Every new Atomic Work apply/verify
 * path gates on this, so a regression that flips it active would silently
 * enable the (not-yet-conformant) substrate.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import {
    DEFAULT_FORK_CONFIG,
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("atomicWork fork config", () => {
    it("is configured inactive by default (activationHeight null)", () => {
        expect(DEFAULT_FORK_CONFIG.atomicWork.activationHeight).toBeNull()
        expect(cloneDefaultForkConfig().atomicWork.activationHeight).toBeNull()
    })

    it("cloneDefaultForkConfig deep-copies atomicWork (no shared ref)", () => {
        const a = cloneDefaultForkConfig()
        const b = cloneDefaultForkConfig()
        expect(a.atomicWork).not.toBe(b.atomicWork)
        expect(a.atomicWork).not.toBe(DEFAULT_FORK_CONFIG.atomicWork)
    })

    it("does not disturb the existing height-0 forks", () => {
        expect(DEFAULT_FORK_CONFIG.osDenomination.activationHeight).toBe(0)
        expect(DEFAULT_FORK_CONFIG.nonceEnforcement.activationHeight).toBe(0)
        expect(DEFAULT_FORK_CONFIG.gasFeeSeparation.activationHeight).toBe(0)
    })
})

describe("isForkActive('atomicWork', …)", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is false at every height while dormant (null)", () => {
        expect(isForkActive("atomicWork", 0)).toBe(false)
        expect(isForkActive("atomicWork", 1_000_000)).toBe(false)
        expect(isForkActive("atomicWork", Number.MAX_SAFE_INTEGER)).toBe(false)
    })

    it("activates only at/after a pinned height when an operator sets one", () => {
        getSharedState.forkConfig.atomicWork.activationHeight = 100
        expect(isForkActive("atomicWork", 99)).toBe(false)
        expect(isForkActive("atomicWork", 100)).toBe(true)
        expect(isForkActive("atomicWork", 101)).toBe(true)
    })
})
