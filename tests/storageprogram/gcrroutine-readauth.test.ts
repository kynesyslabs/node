import { describe, expect, it, jest, beforeAll } from "@jest/globals"

// `gcr_routine` storage reads must ACL-filter on the VERIFIED `sender` the RPC
// layer passed in — never a caller-supplied `params` value. Trivial stubs for
// the dispatcher's unrelated import chain; the storage routines are spied so we
// can assert exactly which requester reached the SQL filter.
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("@kynesyslabs/demosdk/types", () => ({ __esModule: true }))
jest.mock("@/libs/network/server_rpc", () => ({ __esModule: true, emptyResponse: { result: 200, response: null, require_reply: false, extra: null } }))
jest.mock("@/libs/blockchain/gcr/gcr_routines/identityManager", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/blockchain/gcr/gcr_routines/IncentiveManager", () => ({ __esModule: true, IncentiveManager: {} }))
jest.mock("@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({ __esModule: true, default: {} }))
jest.mock("@/features/incentive/referrals", () => ({ __esModule: true, Referrals: {} }))
jest.mock("@/libs/blockchain/gcr/gcr", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/identity/providers/nomisIdentityProvider", () => ({ __esModule: true, NomisIdentityProvider: {} }))
jest.mock("@/libs/identity/tools/humanpassport", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/identity/providers/ethosIdentityProvider", () => ({ __esModule: true, EthosIdentityProvider: {} }))
jest.mock("@/libs/communications/broadcastManager", () => ({ __esModule: true, BroadcastManager: {} }))
jest.mock("@/model/entities/GCRv2/GCR_StorageProgram", () => ({ __esModule: true, GCRStorageProgram: class {} }))
jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: async () => ({ getDataSource: () => ({ getRepository: () => ({}) }) }) },
}))

const listSpy = jest.fn(async () => [])
const searchSpy = jest.fn(async () => [])
jest.mock("@/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines", () => ({
    __esModule: true,
    GCRStorageProgramRoutines: {
        getStorageProgramsByOwner: listSpy,
        searchStorageProgramsByName: searchSpy,
    },
}))

let manageGCRRoutines: typeof import("@/libs/network/manageGCRRoutines")["default"]
const VERIFIED = "aa".repeat(32)
const ATTACKER = "bb".repeat(32) // an allowlisted address the caller merely names

beforeAll(async () => {
    ;({ default: manageGCRRoutines } = await import("@/libs/network/manageGCRRoutines"))
})

describe("gcr_routine storage reads: ACL requester = verified sender", () => {
    it("getStorageProgramsByOwner filters on the verified sender, not params", async () => {
        await manageGCRRoutines(VERIFIED, {
            method: "getStorageProgramsByOwner",
            params: ["owner-x", ATTACKER, {}],
        } as never)
        // 3rd arg to the routine is the requesterAddress that hits the SQL ACL.
        expect(listSpy).toHaveBeenCalled()
        expect(listSpy.mock.calls[0][2]).toBe(VERIFIED)
        expect(listSpy.mock.calls[0][2]).not.toBe(ATTACKER)
    })

    it("searchStoragePrograms filters on the verified sender, not params", async () => {
        await manageGCRRoutines(VERIFIED, {
            method: "searchStoragePrograms",
            params: ["query", {}, ATTACKER],
        } as never)
        expect(searchSpy).toHaveBeenCalled()
        const opts = searchSpy.mock.calls[0][2] as { requesterAddress?: string }
        expect(opts.requesterAddress).toBe(VERIFIED)
        expect(opts.requesterAddress).not.toBe(ATTACKER)
    })

    it("an anonymous (empty) sender reads as undefined even if params name an address", async () => {
        await manageGCRRoutines("", {
            method: "getStorageProgramsByOwner",
            params: ["owner-x", ATTACKER, {}],
        } as never)
        expect(listSpy.mock.calls.at(-1)?.[2]).toBeUndefined()
    })
})
