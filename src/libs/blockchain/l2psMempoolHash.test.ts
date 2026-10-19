/**
 * The queue refuses a key the consolidated digest could not order as defined.
 */

import { describe, expect, it, jest } from "bun:test"
import { mockMempoolDeps } from "@/libs/blockchain/testSupport/mockMempoolDeps"

mockMempoolDeps()

const { default: L2PSMempool } = await import("./l2ps_mempool")

describe("L2PSMempool.addTransaction", () => {
    it("refuses a malformed hash before touching the table", async () => {
        const touched = jest.fn()
        ;(L2PSMempool as any).repo = new Proxy({}, { get: () => touched })

        for (const hash of ["enc-1", "\u{1F600}".repeat(32), "A".repeat(64), undefined, ""]) {
            const result = await L2PSMempool.addTransaction("subnet_a", { hash } as any, "orig", "processed")
            expect(result.success).toBe(false)
            expect(result.error).toContain("Invalid transaction hash")
        }
        expect(touched).not.toHaveBeenCalled()
    })
})
