/**
 * The `l2psSettlement` fork ships dormant in the code and is scheduled at 0
 * by the mainnet genesis template, the go/no-go fork list and the devnet
 * genesis: L2PS balances move only through settlement from mainnet block 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { l2psSettlementActive } from "@/forks/l2psSettlementGate"
import { getSharedState } from "@/utilities/sharedState"
import { MAINNET_FORKS } from "../../scripts/launch-go-no-go"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"
import template from "../../docs/mainnet/genesis.template.json"

describe("l2psSettlement fork config", () => {
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
        expect(DEFAULT_FORK_CONFIG.l2psSettlement.activationHeight).toBeNull()
        getSharedState.lastBlockNumber = 1_000_000
        expect(l2psSettlementActive()).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.l2psSettlement.activationHeight = 5
        expect(cloneDefaultForkConfig().l2psSettlement.activationHeight).toBeNull()
    })

    it("is scheduled at 0 by the mainnet template, the go/no-go list and the devnet genesis", () => {
        expect((template.forks as Record<string, { activationHeight: unknown }>).l2psSettlement.activationHeight).toBe(0)
        expect(MAINNET_FORKS).toContain("l2psSettlement")
        loadForkConfigFromGenesis(devnetGenesis)
        expect(isForkActive("l2psSettlement", 0)).toBe(true)
    })

    it("is judged at the tip", () => {
        loadForkConfigFromGenesis({ forks: { l2psSettlement: { activationHeight: 100 } } })
        getSharedState.lastBlockNumber = 99
        expect(l2psSettlementActive()).toBe(false)
        getSharedState.lastBlockNumber = 100
        expect(l2psSettlementActive()).toBe(true)
    })

    it("refuses a malformed activation height", () => {
        for (const activationHeight of [-1, 1.5, "0"]) {
            expect(() =>
                loadForkConfigFromGenesis({ forks: { l2psSettlement: { activationHeight } } }),
            ).toThrow(ForkConfigValidationError)
        }
    })
})
