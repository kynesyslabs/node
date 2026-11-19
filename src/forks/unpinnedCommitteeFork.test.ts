/**
 * The `unpinnedCommittee` fork ships dormant: the testnet's committees keep
 * the pinned identities first until a height is agreed. A launch genesis sets
 * it to 0, so mainnet never seats them by rule.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { MAINNET_FORKS } from "../../scripts/launch-go-no-go"

describe("unpinnedCommittee fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.unpinnedCommittee.activationHeight).toBeNull()
        expect(isForkActive("unpinnedCommittee", 0)).toBe(false)
        expect(isForkActive("unpinnedCommittee", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.unpinnedCommittee.activationHeight = 5
        expect(cloneDefaultForkConfig().unpinnedCommittee.activationHeight).toBeNull()
    })

    it("activates from a genesis height", () => {
        loadForkConfigFromGenesis({ forks: { unpinnedCommittee: { activationHeight: 100 } } })
        expect(isForkActive("unpinnedCommittee", 99)).toBe(false)
        expect(isForkActive("unpinnedCommittee", 100)).toBe(true)
    })

    it("stays inactive on the testnet genesis, which does not mention it", () => {
        loadForkConfigFromGenesis(JSON.parse(readFileSync("data/genesis.json", "utf8")))
        expect(isForkActive("unpinnedCommittee", 1_000_000)).toBe(false)
    })

    it("refuses a malformed activation height", () => {
        for (const activationHeight of [-1, 1.5, "0"]) {
            expect(() =>
                loadForkConfigFromGenesis({ forks: { unpinnedCommittee: { activationHeight } } }),
            ).toThrow(ForkConfigValidationError)
        }
    })

    it("is required at block 0 in the mainnet genesis and set there by the template", () => {
        expect(MAINNET_FORKS).toContain("unpinnedCommittee")
        const template = JSON.parse(readFileSync("docs/mainnet/genesis.template.json", "utf8"))
        expect(template.forks.unpinnedCommittee).toEqual({ activationHeight: 0 })
    })
})
