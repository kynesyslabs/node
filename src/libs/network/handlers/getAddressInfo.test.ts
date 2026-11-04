/**
 * getAddressInfo is a public read: asking about an address the node has
 * never seen must answer a fresh account without storing one.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const KNOWN = "0x" + "ab".repeat(32)
const UNKNOWN = "0x" + "cd".repeat(32)

const KNOWN_REFERRAL = { totalReferrals: 2, referralCode: "KNOWNCODE", referrals: [], referredBy: null }
const findOne = jest.fn(async ({ where }: { where: { pubkey: string } }) =>
    where.pubkey === KNOWN
        ? ({ pubkey: KNOWN, balance: 5n, nonce: 3, referralInfo: KNOWN_REFERRAL } as any)
        : null,
)
const save = jest.fn(async (row: unknown) => row)
const createAccount = jest.fn(async (pubkey: string, _fill: unknown = {}, skipSave = false) => {
    const row = {
        pubkey,
        balance: 0n,
        nonce: 0,
        referralInfo: { totalReferrals: 0, referralCode: "GENERATED", referrals: [], referredBy: null },
    }
    return skipSave ? row : await save(row)
})

mock.module("src/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({ getRepository: () => ({ findOne, save }) }),
        }),
    },
}))
mock.module("../../blockchain/gcr/handleGCR", () => ({ __esModule: true, default: { createAccount } }))
mock.module("../../identity/tools/twitter", () => ({ Twitter: {} }))
mock.module("../../identity/tools/discord", () => ({ Discord: {} }))
mock.module("../../abstraction/web2/domain", () => ({ fetchDomainProof: jest.fn(), DOMAIN_PROOF_PATH: "" }))
mock.module("../../blockchain/gcr/gcr_routines/udIdentityManager", () => ({ UDIdentityManager: {} }))
mock.module("@/libs/blockchain/gcr/gcr", () => ({ __esModule: true, default: {} }))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { identityHandlers } = await import("./identityHandlers")

async function addressInfo(data: Record<string, unknown>) {
    const response: any = { result: 200, response: null, require_reply: false, extra: null }
    return identityHandlers.getAddressInfo(data as any, response)
}

beforeEach(() => {
    findOne.mockClear()
    save.mockClear()
    createAccount.mockClear()
})

describe("getAddressInfo", () => {
    it("answers an unknown address with a fresh account and stores nothing", async () => {
        const reply = await addressInfo({ address: UNKNOWN })
        expect(reply.result).toBe(200)
        expect(reply.response).toMatchObject({ pubkey: UNKNOWN, nonce: 0 })
        expect(save).not.toHaveBeenCalled()
    })

    it("gives an unknown address no referral code, since an unstored code is refused", async () => {
        const reply = await addressInfo({ address: UNKNOWN })
        expect(reply.response.referralInfo).toEqual({
            totalReferrals: 0,
            referralCode: null,
            referrals: [],
            referredBy: null,
        })
    })

    it("answers a known address with its stored row", async () => {
        const reply = await addressInfo({ address: KNOWN })
        expect(reply.response).toEqual({ pubkey: KNOWN, balance: 5n, nonce: 3, referralInfo: KNOWN_REFERRAL })
        expect(createAccount).not.toHaveBeenCalled()
    })

    it("reads an address given without the 0x prefix", async () => {
        await addressInfo({ address: KNOWN.slice(2) })
        expect(findOne).toHaveBeenCalledWith({ where: { pubkey: KNOWN } })
    })

    it("refuses a malformed address", async () => {
        const reply = await addressInfo({ address: "0x12" })
        expect(reply.result).toBe(400)
        expect(findOne).not.toHaveBeenCalled()
    })
})
