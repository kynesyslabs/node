/**
 * Points are awarded in block apply, on every node and again by every node
 * that syncs the block. A call to an outside service there (the Twitter
 * follow check) answers differently per node and per time, so the same
 * block left different points behind.
 */

import { beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { dirname, join } from "node:path"

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
const datasource = () => ({
    __esModule: true,
    dataSource: { getRepository: () => repository },
    default: { getInstance: async () => ({ getDataSource: () => ({ getRepository: () => repository }) }) },
})
mock.module("src/model/datasource", datasource)
mock.module("@/model/datasource", datasource)
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))
// The package barrel loads the Tron module, which does not initialise under
// bun test; the chain modules are loaded one by one instead.
const LOCALSDK = dirname(require.resolve("@kynesyslabs/demosdk/xm-localsdk"))
const localsdk = (file: string) => require(join(LOCALSDK, file))
mock.module("@kynesyslabs/demosdk/xm-localsdk", () => ({
    XRPL: localsdk("xrp.js").XRPL,
    EVM: localsdk("evm.js").EVM,
    IBC: localsdk("ibc.js").IBC,
    TON: localsdk("ton.js").TON,
    SOLANA: localsdk("solana.js").SOLANA,
    MULTIVERSX: localsdk("multiversx.js").MULTIVERSX,
    NEAR: localsdk("near.js").NEAR,
    BTC: localsdk("btc.js").BTC,
    APTOS: localsdk("aptos.js").APTOS,
}))

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
