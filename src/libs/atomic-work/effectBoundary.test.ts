import { beforeEach, describe, expect, it } from "bun:test"

import {
    assertRollbackBoundary,
    clearOperationKindsForTesting,
    declareNativeOperationKinds,
    declareOperationKind,
    declaredOperationKinds,
    EffectBoundaryError,
} from "@/libs/atomic-work/effectBoundary"

/**
 * A Work that reports a clean rollback while a transfer on another chain stands
 * is worse than a Work that was never admitted. These cover the refusal that
 * keeps the first case from existing.
 */

beforeEach(() => {
    clearOperationKindsForTesting()
    declareNativeOperationKinds()
})

describe("the rollback boundary", () => {
    it("admits a Work whose effects are all node-owned state", () => {
        expect(() =>
            assertRollbackBoundary([
                { operationId: "commitment", kind: "storage-program-put" },
                { operationId: "payment-slot", kind: "payment-slot-cas" },
                { operationId: "payment", kind: "native-dem-transfer" },
            ]),
        ).not.toThrow()
    })

    it("refuses an effect that leaves the node", () => {
        let thrown: EffectBoundaryError | undefined
        try {
            assertRollbackBoundary([
                { operationId: "commitment", kind: "storage-program-put" },
                { operationId: "settle", kind: "crosschain-transfer" },
            ])
        } catch (error) {
            thrown = error as EffectBoundaryError
        }

        expect(thrown?.reason).toBe("external-effect")
        expect(thrown?.operationId).toBe("settle")
        expect(thrown?.message).toMatch(/cannot be rolled back by consensus/)
    })

    it("refuses a kind nobody declared, rather than assuming it is safe", () => {
        // Fail-closed is the whole design: a new operation kind has to say
        // which side of the boundary it is on before it can execute.
        let thrown: EffectBoundaryError | undefined
        try {
            assertRollbackBoundary([{ operationId: "new-op", kind: "quantum-teleport" }])
        } catch (error) {
            thrown = error as EffectBoundaryError
        }

        expect(thrown?.reason).toBe("unknown-kind")
    })

    it("refuses before anything downstream can stage an effect", () => {
        // The check takes only the declared operations, so it can run at
        // admission — there is no overlay to unwind if it fails.
        expect(() =>
            assertRollbackBoundary([{ operationId: "x", kind: "web2-request" }]),
        ).toThrow(EffectBoundaryError)
    })

    it("treats every cross-boundary kind as external, not just the obvious one", () => {
        for (const kind of ["crosschain-transfer", "web2-request", "bridge-transfer", "instant-message"]) {
            expect(() => assertRollbackBoundary([{ operationId: "op", kind }])).toThrow(
                /cannot be rolled back/,
            )
        }
    })

    it("refuses to redeclare a kind on the other side of the boundary", () => {
        expect(() => declareOperationKind("native-dem-transfer", "external")).toThrow(
            /already declared as 'state'/,
        )
        expect(() => declareOperationKind("native-dem-transfer", "state")).not.toThrow()
    })

    it("lists what it knows, for capability advertisement", () => {
        expect(declaredOperationKinds()).toContain("storage-program-put")
        expect(declaredOperationKinds()).toContain("crosschain-transfer")
    })
})
