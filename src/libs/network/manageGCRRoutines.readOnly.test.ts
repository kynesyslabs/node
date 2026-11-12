import { beforeEach, describe, expect, it, mock } from "bun:test"

// Every account row lives here; a read RPC must never add one.
const rows = new Map<string, any>()
let saves = 0
const repository = {
    findOne: async ({ where }: any) => rows.get(where.pubkey) ?? null,
    findOneBy: async (where: any) => rows.get(where.pubkey) ?? null,
    save: async (row: any) => {
        saves++
        rows.set(row.pubkey, row)
        return row
    },
}
const datasource = {
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({ getRepository: () => repository }),
        }),
    },
    dataSource: { getRepository: () => repository },
}
mock.module("src/model/datasource", () => datasource)
mock.module("@/model/datasource", () => datasource)

const { default: manageGCRRoutines } = await import("./manageGCRRoutines")

const UNKNOWN = "0x" + "ab".repeat(32)

describe("GCR read routines on an address with no account", () => {
    beforeEach(() => {
        rows.clear()
        saves = 0
    })

    it("answers getIdentities with empty identities and stores nothing", async () => {
        const res = await manageGCRRoutines(UNKNOWN, {
            method: "getIdentities",
            params: [UNKNOWN],
        })
        expect(res.result).toBe(200)
        expect(res.response).toEqual({ xm: {}, web2: {}, pqc: {}, ud: [] })
        for (const method of [
            "getWeb2Identities",
            "getXmIdentities",
            "getUDIdentities",
        ]) {
            const r = await manageGCRRoutines(UNKNOWN, { method, params: [UNKNOWN] })
            expect(r.result).toBe(200)
        }
        expect(saves).toBe(0)
        expect(rows.size).toBe(0)
    })

    // validateReferralCode and identity admission look codes up among stored
    // rows, so a code handed out before the account exists would be refused.
    it("answers getReferralInfo with no code and stores nothing", async () => {
        const res = await manageGCRRoutines(UNKNOWN, {
            method: "getReferralInfo",
            params: [UNKNOWN],
        })
        expect(res.result).toBe(200)
        expect(res.response.referralCode).toBeNull()
        expect(saves).toBe(0)
        expect(rows.size).toBe(0)
    })

    it("answers getPoints with zero points and stores nothing", async () => {
        const res = await manageGCRRoutines(UNKNOWN, {
            method: "getPoints",
            params: [UNKNOWN],
        })
        expect(res.result).toBe(200)
        expect(res.response.response.totalPoints).toBe(0)
        expect(res.response.response.linkedWallets).toEqual([])
        expect(saves).toBe(0)
        expect(rows.size).toBe(0)
    })

    it("still reads an existing account's identities", async () => {
        rows.set(UNKNOWN, {
            pubkey: UNKNOWN,
            identities: { xm: {}, web2: { github: [{ userId: "1" }] }, pqc: {}, ud: [] },
        })
        const res = await manageGCRRoutines(UNKNOWN, {
            method: "getWeb2Identities",
            params: [UNKNOWN],
        })
        expect(res.response).toEqual({ github: [{ userId: "1" }] })
        expect(saves).toBe(0)
    })
})
