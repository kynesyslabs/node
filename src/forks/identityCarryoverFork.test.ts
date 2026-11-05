/**
 * The `identityCarryover` fork ships dormant, so testnet and devnet restores
 * of a funded snapshot keep working; a mainnet genesis sets it to 0. Its
 * genesis rules read height 0, its apply rules the chain tip.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import {
    identityCarryoverActiveAtApply,
    identityCarryoverActiveAtGenesis,
} from "@/forks/identityCarryoverGate"
import { getSharedState } from "@/utilities/sharedState"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"
import template from "../../docs/mainnet/genesis.template.json"

describe("identityCarryover fork config", () => {
    let saved: { forkConfig: ForkConfigByName; lastBlockNumber: number }

    beforeEach(() => {
        saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = saved.forkConfig
        getSharedState.lastBlockNumber = saved.lastBlockNumber
    })

    it("is inactive by default, and on the devnet genesis", () => {
        expect(DEFAULT_FORK_CONFIG.identityCarryover.activationHeight).toBeNull()
        expect(identityCarryoverActiveAtGenesis()).toBe(false)
        loadForkConfigFromGenesis(devnetGenesis)
        expect(isForkActive("identityCarryover", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.identityCarryover.activationHeight = 5
        expect(cloneDefaultForkConfig().identityCarryover.activationHeight).toBeNull()
    })

    it("is scheduled at 0 by the mainnet genesis template", () => {
        expect((template.forks as Record<string, { activationHeight: unknown }>).identityCarryover.activationHeight).toBe(0)
    })

    it("judges genesis at height 0 and apply at the tip", () => {
        loadForkConfigFromGenesis({ forks: { identityCarryover: { activationHeight: 0 } } })
        getSharedState.lastBlockNumber = 0
        expect(identityCarryoverActiveAtGenesis()).toBe(true)
        expect(identityCarryoverActiveAtApply()).toBe(true)

        getSharedState.forkConfig = cloneDefaultForkConfig()
        loadForkConfigFromGenesis({ forks: { identityCarryover: { activationHeight: 100 } } })
        expect(identityCarryoverActiveAtGenesis()).toBe(false)
        getSharedState.lastBlockNumber = 99
        expect(identityCarryoverActiveAtApply()).toBe(false)
        getSharedState.lastBlockNumber = 100
        expect(identityCarryoverActiveAtApply()).toBe(true)
    })

    it("refuses a malformed activation height", () => {
        for (const activationHeight of [-1, 1.5, "0"]) {
            expect(() =>
                loadForkConfigFromGenesis({ forks: { identityCarryover: { activationHeight } } }),
            ).toThrow(ForkConfigValidationError)
        }
    })
})
