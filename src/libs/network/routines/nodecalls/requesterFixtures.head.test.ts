/**
 * The requester's package for #1059 and #1060 (PATH-OS, 2026-10-15) against
 * getFinalizedHead: F01 and N04 found no finalized height in /info and no
 * head age, and #1059 describes a 9.5-hour testnet halt nothing in a read
 * showed. The head call answers both, and tells a lagging node apart from a
 * stalled chain.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { mockFinalizedHeadReads } from "./finalizedHeadMocks"

const { getLastBlock, getAheadValidatorPeers, getNetworkTimestamp, sharedState } = mockFinalizedHeadReads()

const { default: getFinalizedHead } = await import("./getFinalizedHead")

const FIXTURES = join(import.meta.dir, "../../../blockchain/finality/__fixtures__/requester-1059-1060")
const load = (path: string) => JSON.parse(readFileSync(join(FIXTURES, path), "utf8"))

const F01 = load("fixtures/F01_soak_height_reads_20261014.json")
const N04 = load("negative/N04_finality_not_exposed_info_20261014.json")

// #1059: block 529479 is stamped 07:19:40Z and 529480 16:49:45Z on 2026-10-14.
const HEAD = 529_479
const STAMPED = Date.UTC(2026, 9, 14, 7, 19, 40) / 1000
const READ_AT = Date.UTC(2026, 9, 14, 16, 49, 44) / 1000

const head = {
    number: HEAD,
    hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    content: { timestamp: STAMPED, ordered_transactions: [] },
    validation_data: { signatures: { "0xaa": "11", "0xbb": "22", "0xcc": "33" } },
}

beforeEach(() => {
    for (const fn of [getLastBlock, getAheadValidatorPeers, getNetworkTimestamp]) fn.mockReset()
    getAheadValidatorPeers.mockResolvedValue([])
    sharedState.syncStatus = true
    sharedState.inSyncLoop = false
    sharedState.forkConfig = undefined
})

describe("F01, N04: the finalized head, its age and nodeSynced", () => {
    it("records no parseable finalized height in any /info sample", () => {
        expect(N04.observed.with_parseable_finalized_height).toBe(0)
        expect(F01.samples.every((s: { finalized_height_parsed: boolean }) => !s.finalized_height_parsed)).toBe(true)
    })

    it("answers a safe-integer finalized height with its timestamp and age through the halt", async () => {
        getLastBlock.mockResolvedValue(head)
        getNetworkTimestamp.mockReturnValue(READ_AT)
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        // F01's parse rule: a non-negative safe integer.
        expect(Number.isSafeInteger(reply.response.number) && reply.response.number >= 0).toBe(true)
        expect(reply.response).toMatchObject({
            number: HEAD,
            timestamp: STAMPED,
            ageSeconds: READ_AT - STAMPED,
            nodeSynced: true,
            signatureCount: 3,
        })
        // About 9.5 hours: an old head on a synced node, so the chain stalled.
        expect(reply.response.ageSeconds).toBeGreaterThan(9 * 3600)
    })

    it("tells a lagging node apart from a stalled chain", async () => {
        getLastBlock.mockResolvedValue(head)
        getNetworkTimestamp.mockReturnValue(STAMPED + 5)
        getAheadValidatorPeers.mockResolvedValue([{ identity: "0xdd" }])
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        expect(reply.response).toMatchObject({ number: HEAD, ageSeconds: 5, nodeSynced: false })
    })

    it("answers 503 node_not_synced without a block, and 500 lookup_failed on a failed read (N01: a 502 says neither)", async () => {
        const empty = await getFinalizedHead()
        expect([empty.result, empty.extra, empty.response.nodeSynced]).toEqual([503, { reason: "node_not_synced" }, false])
        getLastBlock.mockRejectedValue(new Error("connection terminated"))
        const failed = await getFinalizedHead()
        expect([failed.result, failed.response.nodeSynced]).toEqual([500, false])
        expect(failed.extra).toMatchObject({ reason: "lookup_failed" })
    })
})
