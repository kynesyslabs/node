import { describe, expect, it } from "bun:test"

import {
    AtomicOverlay,
    OverlayClosedError,
    OverlayConflictError,
    type OverlayBackend,
} from "@/libs/atomic-work/overlay"
import type { SlotState } from "@/libs/atomic-work/resourceSlot"

/**
 * The overlay is where "all of it or none of it" is actually kept. These cover
 * the three ways that promise breaks in practice: something escaping to the
 * backing state early, a Work reading another Work's uncommitted effects, and
 * a claim that quietly stops holding between execution and inclusion.
 */

const WORK = "9f".repeat(32)
const DIGEST = "ab".repeat(32)

function backend(overrides: {
    values?: Record<string, unknown>
    slots?: Record<string, SlotState>
} = {}) {
    const writes: string[] = []
    const store: OverlayBackend = {
        async read(domain, key) {
            writes.push(`read:${domain}/${key}`)
            return overrides.values?.[`${domain}/${key}`]
        },
        async readSlot(resourceKey) {
            return overrides.slots?.[resourceKey]
        },
    }
    return { store, writes }
}

const vacant: SlotState = { state: "vacant", generation: 0 }

describe("isolation", () => {
    it("writes nothing to the backing state before the plan is applied", async () => {
        const { store } = backend()
        const overlay = new AtomicOverlay(store)

        overlay.write("storage", "stor-1", { a: 1 }, "commitment")
        await overlay.claim("slot-1", { state: "vacant", generation: 0 }, WORK, DIGEST, "payment-slot")

        // The backend exposes no mutation at all; the only way anything lands
        // is the plan the caller gets back.
        const plan = await overlay.commit()
        expect(plan.effects).toHaveLength(2)
        expect(Object.keys(store).sort()).toEqual(["read", "readSlot"])
    })

    it("reads back what this Work wrote, so dependent operations see it", async () => {
        const { store } = backend({ values: { "storage/stor-1": { committed: true } } })
        const overlay = new AtomicOverlay(store)

        expect(await overlay.read("storage", "stor-1")).toEqual({ committed: true })
        overlay.write("storage", "stor-1", { staged: true }, "commitment")
        expect(await overlay.read("storage", "stor-1")).toEqual({ staged: true })
    })

    it("keeps two Works from seeing each other's staged writes", async () => {
        const { store } = backend()
        const first = new AtomicOverlay(store)
        const second = new AtomicOverlay(store)

        first.write("storage", "stor-1", { from: "first" }, "op")

        expect(await second.read("storage", "stor-1")).toBeUndefined()
    })
})

describe("joint commit and rollback", () => {
    it("hands back every effect in staging order", async () => {
        const { store } = backend()
        const overlay = new AtomicOverlay(store)

        overlay.write("storage", "a", 1, "op-1")
        await overlay.claim("slot-1", { state: "vacant", generation: 0 }, WORK, DIGEST, "op-2")
        overlay.write("storage", "b", 2, "op-3")

        const plan = await overlay.commit()

        expect(plan.effects.map(e => e.operationId)).toEqual(["op-1", "op-2", "op-3"])
        expect(plan.effectsDigestInput).toContain("op-2")
    })

    it("discards everything on rollback, with nothing to undo", () => {
        const { store } = backend()
        const overlay = new AtomicOverlay(store)
        overlay.write("storage", "a", 1, "op-1")

        const record = overlay.rollback("payment refused")

        expect(record.reason).toBe("payment refused")
        expect(record.discarded).toHaveLength(1)
        expect(overlay.effects()).toEqual([])
        expect(overlay.state).toBe("rolled-back")
    })

    it("refuses the whole plan when a claim stopped holding before commit", async () => {
        // The slot moved while this Work was being assembled. Landing the
        // storage write without the payment would be exactly the partial
        // outcome the overlay exists to prevent.
        const slots: Record<string, SlotState> = { "slot-1": vacant }
        const store: OverlayBackend = {
            async read() {
                return undefined
            },
            async readSlot(key) {
                return slots[key]
            },
        }
        const overlay = new AtomicOverlay(store)

        overlay.write("storage", "stor-1", { paid: true }, "commitment")
        await overlay.claim("slot-1", { state: "vacant", generation: 0 }, WORK, DIGEST, "payment-slot")

        slots["slot-1"] = { state: "in-flight", generation: 0, workId: "other", conflictDigest: DIGEST }

        await expect(overlay.commit()).rejects.toThrow(OverlayConflictError)
        expect(overlay.state).toBe("open")
    })

    it("refuses a second claim on the same resource by the same Work", async () => {
        const { store } = backend()
        const overlay = new AtomicOverlay(store)
        await overlay.claim("slot-1", { state: "vacant", generation: 0 }, WORK, DIGEST, "op-1")

        await expect(
            overlay.claim("slot-1", { state: "vacant", generation: 0 }, WORK, DIGEST, "op-2"),
        ).rejects.toThrow(/claimed twice/)
    })

    it("fails the claim immediately when the slot is already taken", async () => {
        const { store } = backend({
            slots: { "slot-1": { state: "in-flight", generation: 0, workId: "other", conflictDigest: DIGEST } },
        })
        const overlay = new AtomicOverlay(store)

        await expect(
            overlay.claim("slot-1", { state: "vacant", generation: 0 }, WORK, DIGEST, "op"),
        ).rejects.toThrow(/expected state vacant/)
    })
})

describe("a closed overlay", () => {
    it("cannot be written to, claimed in, or committed twice", async () => {
        const { store } = backend()
        const overlay = new AtomicOverlay(store)
        await overlay.commit()

        expect(() => overlay.write("storage", "a", 1, "op")).toThrow(OverlayClosedError)
        expect(() => overlay.rollback("late")).toThrow(/already committed/)
        await expect(overlay.commit()).rejects.toThrow(OverlayClosedError)
    })

    it("cannot be committed after a rollback", async () => {
        const { store } = backend()
        const overlay = new AtomicOverlay(store)
        overlay.rollback("failed")

        await expect(overlay.commit()).rejects.toThrow(/already rolled-back/)
    })
})
