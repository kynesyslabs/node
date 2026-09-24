import { describe, expect, it } from "bun:test"

import type { GCREntityCaches } from "@/libs/blockchain/gcr/handleGCR"

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

function caches(): GCREntityCaches {
    return {
        accounts: new Map([
            ["0xaa", { pubkey: "0xaa", balance: 100n, nonce: 0 } as any],
            ["0xbb", { pubkey: "0xbb", balance: 5n, nonce: 0 } as any],
        ]),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
    }
}

function balance(account: string, operation: "add" | "remove", amount: bigint) {
    return { type: "balance", account, operation, amount, isRollback: false, txhash: "" }
}

function tx(hash: string, from: string, edits: unknown[]): any {
    // Not "native": the forged-edit guard re-derives native edits from the
    // signed body, which is not what these cases are about.
    return { hash, content: { type: "demoswork", from, from_ed25519_address: from, gcr_edits: edits } }
}

describe("HandleGCR.applyTransaction with Work edits", () => {
    it("leaves every account untouched when a Work edit cannot be applied", async () => {
        const entities = caches()
        const payer = entities.accounts.get("0xaa")
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x1", "0xaa", [
                balance("0xaa", "remove", 30n),
                balance("0xbb", "add", 30n),
                // No handler yet: must sink the whole set, not just itself.
                { type: "work-receipt", workId: "w1", isRollback: false, txhash: "" },
            ]),
            false,
            false,
        )

        expect(result.success).toBe(false)
        expect(result.sideEffects).toEqual([])
        expect(entities.accounts.get("0xaa")).toBe(payer)
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
        expect(entities.accounts.get("0xbb")!.balance).toBe(5n)
    })

    it("refuses a Work carrying an edit that persists outside block state, before applying anything", async () => {
        const entities = caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x2", "0xaa", [
                balance("0xaa", "remove", 30n),
                { type: "resource-slot-cas", resourceKey: "k", workId: "w2", isRollback: false, txhash: "" },
                { type: "validatorStake", isRollback: false, txhash: "" },
            ]),
            false,
            false,
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("validatorStake")
        expect(entities.accounts.get("0xaa")!.balance).toBe(100n)
    })

    it("keeps the ordinary path for transactions without Work edits", async () => {
        const entities = caches()
        const result = await HandleGCR.applyTransaction(
            entities,
            tx("0x3", "0xaa", [balance("0xaa", "remove", 30n), balance("0xbb", "add", 30n)]),
            false,
            false,
        )

        expect(result.success).toBe(true)
        expect(entities.accounts.get("0xaa")!.balance).toBe(70n)
        expect(entities.accounts.get("0xbb")!.balance).toBe(35n)
    })
})

describe("HandleGCR.partitionIndependentTxs with Work edits", () => {
    const slot = (key: string, workId: string) => ({
        type: "resource-slot-cas",
        resourceKey: key,
        workId,
        isRollback: false,
        txhash: "",
    })

    it("serializes Works from different senders that contend for one slot", () => {
        const groups = HandleGCR.partitionIndependentTxs([
            tx("0xa", "0x01", [slot("same", "w1")]),
            tx("0xb", "0x02", [slot("same", "w2")]),
        ])
        expect(groups.length).toBe(1)
        expect(groups[0].map(t => t.hash)).toEqual(["0xa", "0xb"])
    })

    it("lets Works on different slots run in separate groups", () => {
        const groups = HandleGCR.partitionIndependentTxs([
            tx("0xa", "0x01", [slot("one", "w1")]),
            tx("0xb", "0x02", [slot("two", "w2")]),
        ])
        expect(groups.length).toBe(2)
    })

    it("groups attempts and receipts of one Work together", () => {
        const groups = HandleGCR.partitionIndependentTxs([
            tx("0xa", "0x01", [{ type: "work-attempt", workId: "w", isRollback: false, txhash: "" }]),
            tx("0xb", "0x02", [{ type: "work-receipt", workId: "w", isRollback: false, txhash: "" }]),
        ])
        expect(groups.length).toBe(1)
    })
})
