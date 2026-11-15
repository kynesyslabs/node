/**
 * The age sweep's throttle against a host clock that steps back. It runs the
 * real `pruneExpiredByAge`, with only the repository's delete stubbed.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"
import { mockMempoolDeps } from "@/libs/blockchain/testSupport/mockMempoolDeps"

const NOW = 1_800_000_000_000

mockMempoolDeps()
const sharedState = {
    lastBlockNumber: 100,
    publicKeyHex: "0x" + "aa".repeat(32),
    inConsensusLoop: false,
}
const sharedStateModule = () => ({
    __esModule: true,
    getSharedState: sharedState,
    default: { getInstance: () => sharedState },
})
mock.module("src/utilities/sharedState", sharedStateModule)
mock.module("@/utilities/sharedState", sharedStateModule)
mock.module("src/libs/network/manageBridge", () => ({ __esModule: true, default: () => undefined }))

const { default: Mempool } = await import("./mempool")

let deletes: Array<{ cutoff: number }> = []

function stubRepo() {
    ;(Mempool as any).repo = {
        createQueryBuilder: () => {
            const query: any = {
                delete: () => query,
                from: () => query,
                where: (_sql: string, params: { cutoff: number }) => {
                    deletes.push(params)
                    return query
                },
                execute: async () => ({ affected: 0 }),
            }
            return query
        },
    }
}

beforeEach(() => {
    deletes = []
    ;(Mempool as any).lastAgeSweep = 0
    stubRepo()
})

describe("age sweep throttle", () => {
    it("skips a sweep inside the interval", async () => {
        await Mempool.pruneExpiredByAge(NOW)
        await Mempool.pruneExpiredByAge(NOW + 500)
        expect(deletes).toHaveLength(1)
    })

    it("sweeps again once the interval has passed", async () => {
        await Mempool.pruneExpiredByAge(NOW)
        await Mempool.pruneExpiredByAge(NOW + 2_000)
        expect(deletes).toHaveLength(2)
    })

    it("sweeps when the clock has stepped back behind the last sweep", async () => {
        await Mempool.pruneExpiredByAge(NOW)
        await Mempool.pruneExpiredByAge(NOW - 60_000)
        expect(deletes).toHaveLength(2)
    })

    it("times the next interval from the stepped-back clock", async () => {
        await Mempool.pruneExpiredByAge(NOW)
        await Mempool.pruneExpiredByAge(NOW - 60_000)
        await Mempool.pruneExpiredByAge(NOW - 60_000 + 500)
        expect(deletes).toHaveLength(2)
        await Mempool.pruneExpiredByAge(NOW - 60_000 + 2_000)
        expect(deletes).toHaveLength(3)
    })
})
