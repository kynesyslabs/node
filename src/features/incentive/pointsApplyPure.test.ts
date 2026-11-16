/**
 * Points are awarded in block apply, on every node and again by every node
 * that syncs the block. A call to an outside service there (the Twitter
 * follow check) answers differently per node and per time, so the same
 * block left different points behind.
 */

import { beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { mockDatasource, mockLogger, mockXmLocalSdk } from "@/utilities/testSupport/coreMocks"

const ACCOUNT = "0x" + "4a".repeat(32)
let stored: any
const save = jest.fn(async (row: any) => {
    stored = row
    return row
})
const repository = {
    findOne: async () => stored,
    findOneBy: async () => stored,
    find: async () => [],
    save,
}
mockDatasource(repository)
mockLogger()
mockXmLocalSdk()

// handleGCR first: it closes the import cycle PointSystem is part of.
const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")
const { Twitter } = await import("@/libs/identity/tools/twitter")
const { PointSystem } = await import("./PointSystem")

const checkFollow = spyOn(Twitter.prototype, "checkFollow").mockImplementation(async () => true)

beforeEach(async () => {
    checkFollow.mockClear()
    stored = await HandleGCR.createAccount(ACCOUNT, {}, true)
    stored.identities.web2.twitter = [{ username: "alice", userId: "42", proof: "p", proofHash: "h", timestamp: 1 }]
})

describe("points for a Twitter link", () => {
    it("asks no outside service, and are the same whoever applies the block", async () => {
        const reply = await PointSystem.getInstance().awardTwitterPoints(ACCOUNT, "42")

        expect(reply.result).toBe(200)
        expect(checkFollow).not.toHaveBeenCalled()
        expect(stored.points.breakdown.socialAccounts.twitter).toBeGreaterThan(0)
        expect(stored.points.breakdown.demosFollow).toBe(0)
    })
})
