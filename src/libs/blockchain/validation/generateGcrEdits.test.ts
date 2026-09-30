import { describe, expect, it } from "bun:test"

import { atomicWorkEdits, generateGcrEdits } from "./generateGcrEdits"

/**
 * The node derives a Work's edits itself, so admission and apply do not
 * depend on the SDK release it is built with.
 */
const SENDER = "0x" + "aa".repeat(32)
const PAYEE = "0x" + "bb".repeat(32)

const attempt = { type: "work-attempt", workId: "w", attemptId: "a", canonicalBytesHash: "h" }
const slot = {
    type: "resource-slot-cas",
    resourceKey: "k",
    expected: { state: "vacant", generation: 0 },
    transition: "settle",
    workId: "w",
    conflictDigest: "c",
}

const workTx = (payload: unknown, type = "atomicWork"): any => ({
    hash: "ab".repeat(32),
    content: {
        type,
        from: SENDER,
        from_ed25519_address: SENDER,
        to: SENDER,
        amount: 0,
        nonce: 7,
        timestamp: 1,
        transaction_fee: { network_fee: 1, rpc_fee: 0, additional_fee: 0 },
        data: [type, payload],
        gcr_edits: [],
    },
})

describe("generateGcrEdits for an atomicWork transaction", () => {
    it("puts the Work edits first, transfers right after the attempt, then the envelope", async () => {
        const edits = await generateGcrEdits(workTx({ intent: {}, edits: [attempt, slot], transfers: [{ to: PAYEE, amount: "25" }] }))
        const shape = edits.map(e => (e.type as string) + ((e as any).operation ? ":" + (e as any).operation : ""))
        expect(shape.slice(0, 4)).toEqual(["work-attempt", "balance:remove", "balance:add", "resource-slot-cas"])
        expect(edits[1]).toMatchObject({ account: SENDER, amount: "25" })
        expect(edits[2]).toMatchObject({ account: PAYEE, amount: "25" })
        expect(edits.every(e => e.txhash === "ab".repeat(32) && e.isRollback === false)).toBe(true)
        // The SDK's universal edits follow: gas, then the nonce spend.
        expect(shape.at(-1)).toBe("nonce:add")
    })

    it("refuses what the node could not apply", () => {
        expect(() => atomicWorkEdits(workTx({ edits: [] }))).toThrow("non-empty")
        expect(() => atomicWorkEdits(workTx({ edits: [slot, attempt] }))).toThrow("start with its work-attempt")
        expect(() => atomicWorkEdits(workTx({ edits: [attempt, { type: "balance" }] }))).toThrow("not a Work edit")
        expect(() => atomicWorkEdits(workTx({ edits: [attempt], transfers: [{ to: "nobody", amount: "1" }] }))).toThrow(
            "32-byte hex address",
        )
        expect(() => atomicWorkEdits(workTx({ edits: [attempt], transfers: [{ to: PAYEE, amount: "0" }] }))).toThrow(
            "positive integer",
        )
    })

    it("refuses a replay that carries transfers", () => {
        const replay = { ...attempt, attemptClass: "replay" }
        expect(() => atomicWorkEdits(workTx({ edits: [replay], transfers: [{ to: PAYEE, amount: "20" }] }))).toThrow(
            "replay carries no transfers",
        )
        expect(atomicWorkEdits(workTx({ edits: [replay], transfers: [] }))).toHaveLength(1)
    })

    it("leaves every other transaction type to the SDK", async () => {
        const edits = await generateGcrEdits(workTx({ edits: [attempt] }, "native"))
        expect(edits.some(e => (e.type as string) === "work-attempt")).toBe(false)
    })
})
