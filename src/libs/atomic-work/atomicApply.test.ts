import { describe, expect, it } from "bun:test"

import {
    applyAllOrNothing,
    requiresAtomicApplication,
    type EditOutcome,
} from "@/libs/atomic-work/atomicApply"

class Account {
    constructor(
        public pubkey: string,
        public balance: bigint,
    ) {}
    credit(amount: bigint) {
        this.balance += amount
    }
}

type Caches = {
    accounts: Map<string, Account>
    slots: Map<string, { generation: number } | null>
}

type Edit =
    | { type: "balance"; account: string; amount: bigint }
    | { type: "resource-slot-cas"; key: string; expected: number }
    | { type: "validatorStake" }

function caches(): Caches {
    return {
        accounts: new Map([
            ["a", new Account("a", 100n)],
            ["b", new Account("b", 5n)],
        ]),
        slots: new Map([["s1", { generation: 0 }]]),
    }
}

async function handler(edit: Edit, c: Caches): Promise<EditOutcome> {
    if (edit.type === "balance") {
        const acc = c.accounts.get(edit.account)
        if (!acc) return { success: false, message: "no account" }
        if (acc.balance + edit.amount < 0n)
            return { success: false, message: "insufficient" }
        acc.credit(edit.amount)
        return { success: true, message: "ok" }
    }
    if (edit.type === "resource-slot-cas") {
        const slot = c.slots.get(edit.key)
        if (!slot || slot.generation !== edit.expected) {
            return { success: false, message: "cas mismatch" }
        }
        c.slots.set(edit.key, { generation: slot.generation + 1 })
        return { success: true, message: "ok", sideEffect: async () => {} }
    }
    return { success: true, message: "persisted elsewhere" }
}

describe("applyAllOrNothing", () => {
    it("commits every change when all edits succeed", async () => {
        const base = caches()
        const result = await applyAllOrNothing<Caches, Edit>(
            base,
            [
                { type: "balance", account: "a", amount: -30n },
                { type: "balance", account: "b", amount: 30n },
                { type: "resource-slot-cas", key: "s1", expected: 0 },
            ],
            handler,
        )

        expect(result.success).toBe(true)
        expect(result.appliedEditsCount).toBe(3)
        expect(result.sideEffects.length).toBe(1)
        expect(base.accounts.get("a")!.balance).toBe(70n)
        expect(base.accounts.get("b")!.balance).toBe(35n)
        expect(base.slots.get("s1")).toEqual({ generation: 1 })
    })

    it("leaves the caches untouched, object for object, when a late edit fails", async () => {
        const base = caches()
        const a = base.accounts.get("a")!
        const result = await applyAllOrNothing<Caches, Edit>(
            base,
            [
                { type: "balance", account: "a", amount: -30n },
                { type: "balance", account: "b", amount: 30n },
                { type: "resource-slot-cas", key: "s1", expected: 7 },
            ],
            handler,
        )

        expect(result.success).toBe(false)
        expect(result.failedAt).toBe(2)
        expect(result.sideEffects).toEqual([])
        // Not restored: never changed. The same object is still in place.
        expect(base.accounts.get("a")).toBe(a)
        expect(a.balance).toBe(100n)
        expect(base.accounts.get("b")!.balance).toBe(5n)
        expect(base.slots.get("s1")).toEqual({ generation: 0 })
    })

    it("treats a throwing handler as a failure of the whole set", async () => {
        const base = caches()
        const result = await applyAllOrNothing<Caches, Edit>(
            base,
            [
                { type: "balance", account: "a", amount: -1n },
                { type: "resource-slot-cas", key: "s1", expected: 0 },
            ],
            async (edit, c) => {
                if (edit.type === "resource-slot-cas") throw new Error("boom")
                return handler(edit, c)
            },
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("boom")
        expect(base.accounts.get("a")!.balance).toBe(100n)
    })

    it("refuses an edit whose handler writes outside block state, before running anything", async () => {
        const base = caches()
        let ran = 0
        const result = await applyAllOrNothing<Caches, Edit>(
            base,
            [
                { type: "balance", account: "a", amount: -1n },
                { type: "validatorStake" },
            ],
            async (edit, c) => {
                ran++
                return handler(edit, c)
            },
        )

        expect(result.success).toBe(false)
        expect(result.failedAt).toBe(1)
        expect(ran).toBe(0)
    })

    it("keeps the entity's class so handlers can call its methods", async () => {
        const base = caches()
        const result = await applyAllOrNothing<Caches, Edit>(
            base,
            [{ type: "balance", account: "a", amount: 1n }],
            handler,
        )

        expect(result.success).toBe(true)
        expect(base.accounts.get("a")).toBeInstanceOf(Account)
    })

    it("lets later edits see earlier ones inside the same set", async () => {
        const base = caches()
        const result = await applyAllOrNothing<Caches, Edit>(
            base,
            [
                { type: "resource-slot-cas", key: "s1", expected: 0 },
                { type: "resource-slot-cas", key: "s1", expected: 1 },
            ],
            handler,
        )

        expect(result.success).toBe(true)
        expect(base.slots.get("s1")).toEqual({ generation: 2 })
    })

    it("commits a deletion only with the rest of the set", async () => {
        const del = async (edit: Edit, c: Caches): Promise<EditOutcome> => {
            if (edit.type === "resource-slot-cas") {
                c.slots.delete(edit.key)
                return { success: true, message: "ok" }
            }
            return handler(edit, c)
        }

        const failed = caches()
        await applyAllOrNothing<Caches, Edit>(
            failed,
            [
                { type: "resource-slot-cas", key: "s1", expected: 0 },
                { type: "balance", account: "b", amount: -999n },
            ],
            del,
        )
        expect(failed.slots.has("s1")).toBe(true)

        const passed = caches()
        await applyAllOrNothing<Caches, Edit>(
            passed,
            [{ type: "resource-slot-cas", key: "s1", expected: 0 }],
            del,
        )
        expect(passed.slots.has("s1")).toBe(false)
    })

    it("refuses to enumerate a shadow rather than show a partial view", async () => {
        const result = await applyAllOrNothing<Caches, Edit>(
            caches(),
            [{ type: "balance", account: "a", amount: 1n }],
            async (_edit, c) => {
                for (const _ of c.accounts) void _
                return { success: true, message: "ok" }
            },
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("cannot be enumerated")
    })
})

describe("requiresAtomicApplication", () => {
    it("is decided by the edits, not by the sender", () => {
        expect(
            requiresAtomicApplication([{ type: "balance" }, { type: "nonce" }]),
        ).toBe(false)
        expect(
            requiresAtomicApplication([
                { type: "balance" },
                { type: "work-receipt" },
            ]),
        ).toBe(true)
        expect(requiresAtomicApplication(undefined)).toBe(false)
    })
})
