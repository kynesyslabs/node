import { describe, expect, it } from "bun:test"

import {
    assertAtomicApplication,
    planToAtomicEdits,
    PlanTranslationError,
} from "@/libs/atomic-work/gcrBridge"
import { AtomicOverlay, type OverlayBackend } from "@/libs/atomic-work/overlay"

const WORK = "9f".repeat(32)
const DIGEST = "ab".repeat(32)

const backend: OverlayBackend = {
    async read() {
        return undefined
    },
    async readSlot() {
        return undefined
    },
}

async function planWithBothEffects() {
    const overlay = new AtomicOverlay(backend)
    overlay.write("storage", "stor-1", { paid: true }, "commitment")
    await overlay.claim("slot-1", { state: "vacant", generation: 0 }, WORK, DIGEST, "payment-slot")
    overlay.write("storage", "stor-2", { note: "x" }, "delivery")
    return overlay.commit()
}

describe("translating a plan", () => {
    it("keeps the order the effects were staged in", async () => {
        // A write and the claim that authorizes it are only safe in the order
        // they were staged; reordering is a different plan.
        const edits = planToAtomicEdits(await planWithBothEffects())

        expect(edits.map(e => e.operationId)).toEqual([
            "commitment", "payment-slot", "delivery",
        ])
        expect(edits.map(e => e.index)).toEqual([0, 1, 2])
    })

    it("maps each staged effect to its edit kind", async () => {
        const edits = planToAtomicEdits(await planWithBothEffects())

        expect(edits[0].kind).toBe("storage-program-put")
        expect(edits[1].kind).toBe("resource-slot-cas")
        expect(edits[1].payload.resourceKey).toBe("slot-1")
    })

    it("refuses a plan that staged nothing", async () => {
        // Either the Work did nothing or its effects were lost on the way
        // here. Both deserve noticing rather than committing as a no-op.
        const overlay = new AtomicOverlay(backend)
        let thrown: PlanTranslationError | undefined
        try {
            planToAtomicEdits(await overlay.commit())
        } catch (error) {
            thrown = error as PlanTranslationError
        }

        expect(thrown?.reason).toBe("empty-plan")
    })

    it("refuses something that is not a plan", () => {
        expect(() => planToAtomicEdits(undefined as never)).toThrow(/commit plan is required/)
    })
})

describe("how a plan may be applied", () => {
    it("accepts all-or-nothing", () => {
        expect(() => assertAtomicApplication("all-or-nothing")).not.toThrow()
    })

    it("refuses the reversal path", () => {
        // The two look interchangeable at the call site and are not: between
        // apply and reverse the intermediate state is visible to concurrent
        // readers, and a reversal that fails strands it.
        expect(() => assertAtomicApplication("apply-then-reverse")).toThrow(
            /intermediate state is visible/,
        )
    })
})
