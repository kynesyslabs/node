import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import axios from "axios"
import { applyNomisIdentityUpsert } from "./nomisRoutines"
import { applyEthosIdentityUpsert } from "./ethosRoutines"
import { applyHumanPassportIdentityAdd } from "./humanpassportRoutines"
import { HumanPassportProvider } from "@/libs/identity/tools/humanpassport"
import { NomisApiClient } from "@/libs/identity/tools/nomis"
import { EthosApiClient } from "@/libs/identity/tools/ethos"

const ACCOUNT = "0x" + "11".repeat(32)
const ADDRESS = "0x" + "AB".repeat(20)

function account(): any {
    return { pubkey: ACCOUNT, identities: { xm: {}, nomis: {}, ethos: {}, humanpassport: [] } }
}

const passportEdit = (data: Record<string, unknown> = {}) => ({
    account: ACCOUNT,
    data: {
        address: ADDRESS,
        verificationMethod: "api",
        score: 25.5,
        threshold: 20,
        stamps: ["Google", "Discord"],
        lastScoreTimestamp: "2026-10-27T10:00:00.000Z",
        expirationTimestamp: "2027-01-27T10:00:00.000Z",
        ...data,
    },
})

const nomisEdit = (data: Record<string, unknown> = {}) => ({
    account: ACCOUNT,
    data: {
        chain: "evm",
        subchain: "mainnet",
        address: ADDRESS,
        score: 0.4237,
        scoreType: 0,
        mintedScore: 40,
        lastSyncedAt: "2026-10-27T10:00:00.000Z",
        metadata: { referralCode: "client-chosen" },
        ...data,
    },
})

const ethosEdit = (data: Record<string, unknown> = {}) => ({
    account: ACCOUNT,
    data: {
        chain: "evm",
        subchain: "mainnet",
        address: ADDRESS,
        score: 1450,
        profileId: 77,
        lastSyncedAt: "2026-10-27T10:00:00.000Z",
        metadata: { displayName: "Ann", username: "ann", extra: "dropped" },
        ...data,
    },
})

describe("score identity apply is a pure function of the edit", () => {
    const spies: Array<ReturnType<typeof spyOn>> = []
    const calls = () => spies.reduce((n, s) => n + s.mock.calls.length, 0)

    beforeEach(() => {
        const refuse = async () => {
            throw new Error("network access during apply")
        }
        spies.push(
            spyOn(globalThis, "fetch").mockImplementation(refuse as any),
            spyOn(axios.Axios.prototype, "request").mockImplementation(refuse as any),
            spyOn(NomisApiClient.getInstance(), "getWalletScore").mockImplementation(
                refuse as any,
            ),
            spyOn(EthosApiClient.getInstance(), "getScore").mockImplementation(
                refuse as any,
            ),
            spyOn(HumanPassportProvider.prototype, "verifyAddress").mockImplementation(
                refuse as any,
            ),
        )
    })
    afterEach(() => {
        while (spies.length) spies.pop()!.mockRestore()
    })

    it("stores the signed Nomis values without asking Nomis", async () => {
        const gcr = account()
        const r = await applyNomisIdentityUpsert(nomisEdit(), gcr)

        expect(r.success).toBe(true)
        expect(calls()).toBe(0)
        expect(gcr.identities.nomis.evm.mainnet).toEqual([
            {
                address: ADDRESS.toLowerCase(),
                score: 0.4237,
                scoreType: 0,
                mintedScore: 40,
                lastSyncedAt: "2026-10-27T10:00:00.000Z",
            },
        ])
    })

    it("stores the signed Ethos values without asking Ethos", async () => {
        const gcr = account()
        const r = await applyEthosIdentityUpsert(ethosEdit(), gcr)

        expect(r.success).toBe(true)
        expect(calls()).toBe(0)
        expect(gcr.identities.ethos.evm.mainnet).toEqual([
            {
                address: ADDRESS.toLowerCase(),
                score: 1450,
                profileId: 77,
                lastSyncedAt: "2026-10-27T10:00:00.000Z",
                metadata: { displayName: "Ann", username: "ann" },
            },
        ])
    })

    it("stores the signed Human Passport values without asking Human Passport", async () => {
        const gcr = account()
        const r = await applyHumanPassportIdentityAdd(passportEdit(), gcr)

        expect(r.success).toBe(true)
        expect(calls()).toBe(0)
        expect(gcr.identities.humanpassport).toEqual([
            {
                address: ADDRESS.toLowerCase(),
                score: 25.5,
                passingScore: true,
                threshold: 20,
                stamps: ["Discord", "Google"],
                verificationMethod: "api",
                verifiedAt: Date.parse("2026-10-27T10:00:00.000Z"),
                expiresAt: Date.parse("2027-01-27T10:00:00.000Z"),
            },
        ])
    })

    it("refuses a Human Passport edit without a passing signed score", async () => {
        for (const o of [
            { score: undefined },
            { threshold: undefined },
            { score: 19.9 },
            { threshold: 0 },
            { score: "25.5" },
            { lastScoreTimestamp: "soon" },
        ]) {
            const r = await applyHumanPassportIdentityAdd(passportEdit(o), account())
            expect({ o, ok: r.success }).toEqual({ o, ok: false })
        }
        expect(calls()).toBe(0)
    })

    it("produces identical state for identical edits, at any time", async () => {
        const runs = async () => {
            const n = account()
            const e = account()
            const h = account()
            await applyNomisIdentityUpsert(nomisEdit(), n)
            await applyEthosIdentityUpsert(ethosEdit(), e)
            await applyHumanPassportIdentityAdd(passportEdit(), h)
            return JSON.stringify([n.identities, e.identities, h.identities])
        }
        const first = await runs()
        await new Promise(resolve => setTimeout(resolve, 5))
        const second = await runs()

        expect(second).toBe(first)
        expect(calls()).toBe(0)
    })

    it("refuses an edit without a usable score instead of looking one up", async () => {
        for (const score of [undefined, 0, -1, "0.5", Number.NaN]) {
            const n = await applyNomisIdentityUpsert(nomisEdit({ score }), account())
            expect({ score, ok: n.success }).toEqual({ score, ok: false })
        }
        for (const score of [undefined, -1, "1450", Number.POSITIVE_INFINITY]) {
            const e = await applyEthosIdentityUpsert(ethosEdit({ score }), account())
            expect({ score, ok: e.success }).toEqual({ score, ok: false })
        }
        expect(calls()).toBe(0)
    })

    it("replaces an earlier record for the same wallet", async () => {
        const gcr = account()
        await applyNomisIdentityUpsert(nomisEdit({ score: 0.2 }), gcr)
        await applyNomisIdentityUpsert(
            nomisEdit({ address: ADDRESS.toLowerCase(), score: 0.3 }),
            gcr,
        )
        expect(gcr.identities.nomis.evm.mainnet).toHaveLength(1)
        expect(gcr.identities.nomis.evm.mainnet[0].score).toBe(0.3)
    })
})
