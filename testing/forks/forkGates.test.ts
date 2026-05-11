/**
 * Truth-table tests for the fork gate.
 *
 * These tests verify the contract spelled out in
 * `decimal_planning/SPEC.md` §3 P2: a fork is active iff its
 * `activationHeight` is non-null AND `blockHeight >= activationHeight`. A
 * `null` activation height (the default for every fork in P2) means the
 * fork never activates.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("isForkActive — truth table", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        // REVIEW: Snapshot the singleton config so each test starts from
        // the clean default (all forks inactive).
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("returns false when activationHeight is null (default)", () => {
        // All P2 defaults: activationHeight === null.
        expect(isForkActive("osDenomination", 0)).toBe(false)
        expect(isForkActive("osDenomination", 1)).toBe(false)
        expect(isForkActive("osDenomination", 1_000_000)).toBe(false)
        expect(isForkActive("osDenomination", Number.MAX_SAFE_INTEGER)).toBe(
            false,
        )
    })

    it("returns false when blockHeight < activationHeight", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 100
        expect(isForkActive("osDenomination", 99)).toBe(false)
        expect(isForkActive("osDenomination", 0)).toBe(false)
    })

    it("returns true when blockHeight === activationHeight", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 100
        expect(isForkActive("osDenomination", 100)).toBe(true)
    })

    it("returns true when blockHeight > activationHeight", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 100
        expect(isForkActive("osDenomination", 101)).toBe(true)
        expect(isForkActive("osDenomination", 1_000_000)).toBe(true)
    })

    it("activates at genesis when activationHeight is 0", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 0
        expect(isForkActive("osDenomination", 0)).toBe(true)
        expect(isForkActive("osDenomination", 1)).toBe(true)
    })

    it("returns false for unknown fork names (defensive)", () => {
        // Cast through `any` to bypass the type system — this models the
        // case where a runtime caller has an unknown name (e.g. forwarded
        // from genesis JSON).
        expect(isForkActive("nonexistentFork" as any, 100)).toBe(false)
        expect(isForkActive("nonexistentFork" as any, 0)).toBe(false)
    })

    it("integrates: configured-but-inactive then active boundary", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 1000
        expect(isForkActive("osDenomination", 50)).toBe(false)
        expect(isForkActive("osDenomination", 999)).toBe(false)
        expect(isForkActive("osDenomination", 1000)).toBe(true)
        expect(isForkActive("osDenomination", 1500)).toBe(true)
    })
})
