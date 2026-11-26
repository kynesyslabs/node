/**
 * `peerlistFloor` is a consensus fork: it changes which identities a block's
 * peerlist holds and which committee signs a refresh block, so it ships
 * dormant and only a genesis (or a coordinated release) schedules it. The
 * rules themselves are covered next to the code: peerlistMerge.floor.test.ts
 * and getShard.refresh.test.ts.
 */
import { describe, expect, it } from "bun:test"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "src/utilities/sharedState"
import { MAINNET_FORKS } from "../../scripts/launch-go-no-go"
import template from "../../docs/mainnet/genesis.template.json"
import devnet from "../../testing/devnet/genesis.devnet.json"
import { peerlistFloorThreshold, quorumThreshold } from "src/libs/consensus/v2/quorum"

describe("peerlistFloor config", () => {
    it("ships dormant, copied per clone, and is scheduled at 0 by the mainnet template and the devnet", () => {
        expect(DEFAULT_FORK_CONFIG.peerlistFloor.activationHeight).toBeNull()
        const a = cloneDefaultForkConfig()
        a.peerlistFloor.activationHeight = 5
        expect(cloneDefaultForkConfig().peerlistFloor.activationHeight).toBeNull()
        expect((template.forks as any).peerlistFloor).toEqual({ activationHeight: 0 })
        expect((devnet.forks as any).peerlistFloor).toEqual({ activationHeight: 0 })
        expect(MAINNET_FORKS).toContain("peerlistFloor")
    })

    it("loads null from a genesis that does not declare it, and a declared height as given", () => {
        loadForkConfigFromGenesis({ forks: {} })
        expect(getSharedState.forkConfig.peerlistFloor.activationHeight).toBeNull()
        loadForkConfigFromGenesis({ forks: { peerlistFloor: { activationHeight: 10 } } })
        expect(getSharedState.forkConfig.peerlistFloor.activationHeight).toBe(10)
    })
})

describe("the floor", () => {
    it("is one more than the members a block can do without", () => {
        expect(peerlistFloorThreshold(10)).toBe(4)
        expect(quorumThreshold(10)).toBe(7)
        for (const n of [1, 3, 4, 7, 10, 13, 30]) {
            expect(peerlistFloorThreshold(n)).toBe(n - quorumThreshold(n) + 1)
            expect(peerlistFloorThreshold(n)).toBeGreaterThanOrEqual(1)
        }
    })
})
