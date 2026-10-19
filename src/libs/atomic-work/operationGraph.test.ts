import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    validateOperationGraph,
    OperationGraphError,
    type IntentGraphView,
} from "@/libs/atomic-work/operationGraph"
import { registerDacsAtomicWorkProfiles } from "@/libs/atomic-work/dacs/profile"

registerDacsAtomicWorkProfiles()

// Canonical operation graphs from #336 pass vectors (both profiles), each of
// which passes the reference `_profile_shape` predicate.
type GraphFixture = { cases: (IntentGraphView & { profile: string })[] }
const fx: GraphFixture = JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__/operation_graph.vectors.json"), "utf-8"),
)

describe("operation-graph validator — reconciliation vs #336 vectors", () => {
    it("covers both purchase and completion profiles", () => {
        const profiles = new Set(fx.cases.map(c => c.profile))
        expect(profiles.has("dacs-purchase-v1")).toBe(true)
        expect(profiles.has("dacs-completion-v1")).toBe(true)
    })

    for (const [i, c] of fx.cases.entries()) {
        it(`accepts the canonical ${c.profile} graph [case ${i}]`, () => {
            expect(() => validateOperationGraph(c)).not.toThrow()
        })
    }
})

describe("operation-graph validator — rejects deviations", () => {
    const purchase = (): IntentGraphView =>
        JSON.parse(JSON.stringify(fx.cases.find(c => c.profile === "dacs-purchase-v1")))

    it("rejects a wrong operation count", () => {
        const bad = purchase()
        bad.operations = bad.operations!.slice(0, 5)
        expect(() => validateOperationGraph(bad)).toThrow(OperationGraphError)
    })

    it("rejects a reordered graph", () => {
        const bad = purchase()
        ;[bad.operations![0], bad.operations![1]] = [bad.operations![1], bad.operations![0]]
        expect(() => validateOperationGraph(bad)).toThrow(/mismatch/)
    })

    it("rejects a wrong kind for a fixed slot", () => {
        const bad = purchase()
        bad.operations![4].kind = "storage-program-put" // payment-slot must be payment-slot-cas
        expect(() => validateOperationGraph(bad)).toThrow(OperationGraphError)
    })

    it("rejects tampered dependsOn edges", () => {
        const bad = purchase()
        bad.operations![5].dependsOn = ["commitment"] // payment must depend on payment-slot
        expect(() => validateOperationGraph(bad)).toThrow(OperationGraphError)
    })

    it("rejects a tampered requiredRoles set", () => {
        const bad = purchase()
        bad.operations![4].requiredRoles = ["orchestrator"] // payment-slot is the payer's
        expect(() => validateOperationGraph(bad)).toThrow(OperationGraphError)
    })

    it("accepts assert-artifact OR storage-program-put for the vetting slots", () => {
        const ok = purchase()
        ok.operations![0].kind = "assert-artifact"
        ok.operations![1].kind = "storage-program-put"
        expect(() => validateOperationGraph(ok)).not.toThrow()
    })
})
