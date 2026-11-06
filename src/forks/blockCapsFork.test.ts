/**
 * The `blockCaps` fork ships dormant: it changes which txs a block contains.
 * The mainnet genesis template and the devnet genesis schedule it at 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { blockCapsActive, blockCapsActiveForPendingBlock } from "@/forks/blockCapsGate"
import { getSharedState } from "@/utilities/sharedState"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"
import template from "../../docs/mainnet/genesis.template.json"

describe("blockCaps fork config", () => {
    let saved: { forkConfig: ForkConfigByName; lastBlockNumber: number }

    beforeEach(() => {
        saved = { forkConfig: getSharedState.forkConfig, lastBlockNumber: getSharedState.lastBlockNumber }
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = saved.forkConfig
        getSharedState.lastBlockNumber = saved.lastBlockNumber
    })

    it("is inactive by default", () => {
        expect(DEFAULT_FORK_CONFIG.blockCaps.activationHeight).toBeNull()
        expect(blockCapsActive(0)).toBe(false)
        expect(blockCapsActive(1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.blockCaps.activationHeight = 5
        expect(cloneDefaultForkConfig().blockCaps.activationHeight).toBeNull()
    })

    it("is scheduled at 0 by the mainnet template and the devnet genesis", () => {
        expect((template.forks as Record<string, { activationHeight: unknown }>).blockCaps.activationHeight).toBe(0)
        loadForkConfigFromGenesis(devnetGenesis)
        expect(isForkActive("blockCaps", 0)).toBe(true)
    })

    it("judges a block at its height and the merge at the block it prepares", () => {
        loadForkConfigFromGenesis({ forks: { blockCaps: { activationHeight: 100 } } })
        expect(blockCapsActive(99)).toBe(false)
        expect(blockCapsActive(100)).toBe(true)
        getSharedState.lastBlockNumber = 98
        expect(blockCapsActiveForPendingBlock()).toBe(false)
        getSharedState.lastBlockNumber = 99
        expect(blockCapsActiveForPendingBlock()).toBe(true)
    })

    it("refuses a malformed activation height", () => {
        for (const activationHeight of [-1, 1.5, "0"]) {
            expect(() =>
                loadForkConfigFromGenesis({ forks: { blockCaps: { activationHeight } } }),
            ).toThrow(ForkConfigValidationError)
        }
    })
})
