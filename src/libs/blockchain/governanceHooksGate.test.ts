import { beforeEach, describe, expect, it, mock } from "bun:test"

import { installFakeBlockDatabase, stubBlockInsertCollaborators } from "./blockInsert.fixtures"

/**
 * While networkGovernance is dormant no governance transaction applies, so
 * the only proposals a node holds are rows an older binary wrote. Tallying
 * and activating them from insertBlock would change the parameters of the
 * nodes that kept those rows and not of the ones that resynced.
 */

installFakeBlockDatabase(() => {})
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))

const tallied: number[] = []
const activated: number[] = []
const dropped: number[] = []
await stubBlockInsertCollaborators({
    "src/libs/blockchain/routines/dropPreGovernanceRows": {
        default: async (activationHeight: number) => {
            dropped.push(activationHeight)
            return { proposals: 0, votes: 0 }
        },
    },
    "src/libs/blockchain/routines/tallyUpgradeVotes": {
        default: async (height: number) => {
            tallied.push(height)
            return []
        },
    },
    "src/libs/blockchain/routines/applyNetworkUpgrade": {
        default: async (height: number) => {
            activated.push(height)
            return []
        },
    },
})
const { insertBlock } = await import("./chainBlocks")
const { getSharedState } = await import("src/utilities/sharedState")

function block(number: number): any {
    return {
        number,
        hash: `0xblock${number}`,
        proposer: "ab".repeat(32),
        next_proposer: "cd".repeat(32),
        status: "confirmed",
        validation_data: { signatures: {} },
        content: { ordered_transactions: [], timestamp: 1_700_000_000 },
        attrs: {},
    }
}

function governanceAt(activationHeight: number | null) {
    getSharedState.forkConfig = {
        ...getSharedState.forkConfig,
        osDenomination: { activationHeight: null },
        gasFeeSeparation: { activationHeight: null },
        networkGovernance: { activationHeight },
    } as any
}

beforeEach(() => {
    tallied.length = 0
    activated.length = 0
    dropped.length = 0
    getSharedState.fastSyncCount = 0
})

describe("governance hooks in insertBlock", () => {
    it("do not run while networkGovernance is dormant", async () => {
        governanceAt(null)
        getSharedState.lastBlockNumber = 19
        await insertBlock(block(20), [])
        expect(tallied).toEqual([])
        expect(activated).toEqual([])
        expect(dropped).toEqual([])
    })

    it("run from the block applied on the activation tip", async () => {
        governanceAt(30)
        getSharedState.lastBlockNumber = 29
        await insertBlock(block(30), [])
        expect(tallied).toEqual([])
        expect(activated).toEqual([])

        getSharedState.lastBlockNumber = 30
        await insertBlock(block(31), [])
        expect(tallied).toEqual([31])
        expect(activated).toEqual([31])
    })

    it("drop the rows an older binary left at the activation block only", async () => {
        governanceAt(30)
        for (const n of [29, 30, 31, 32]) {
            getSharedState.lastBlockNumber = n - 1
            await insertBlock(block(n), [])
        }
        // Block 30 still refuses governance edits; block 31 is the first to
        // admit them, so it must see no row the others lack.
        expect(dropped).toEqual([30])
        expect(tallied).toEqual([31, 32])
    })
})
