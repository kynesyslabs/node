/**
 * L2PS proofs apply into the block's pending state, so what they stamp
 * (an account row created by a proof) commits with the block and must be
 * the block's timestamp, not the clock of the node applying it.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { mockDatasource, mockLogger, mockXmLocalSdk } from "@/utilities/testSupport/coreMocks"

mockDatasource({ findOne: async () => null })
mockLogger()
mockXmLocalSdk()

const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")
const { default: L2PSProofManager } = await import("./L2PSProofManager")
const { default: L2PSConsensus } = await import("./L2PSConsensus")
const { applyTime } = await import("@/libs/blockchain/gcr/applyTime")

const BLOCK_SEC = 1_794_700_800
const ACCOUNT = "0x" + "7d".repeat(32)

describe("L2PS proof apply time", () => {
    const spies: { mockRestore(): void }[] = []
    afterEach(() => spies.splice(0).forEach(s => s.mockRestore()))

    it("is the block's timestamp, for the edits and the mock transaction alike", async () => {
        let stamped: Date | null = null
        let txTimestamp: number | null = null
        spies.push(
            spyOn(L2PSProofManager, "getProofsForBlock").mockResolvedValue([
                {
                    id: 1,
                    l2ps_uid: "net",
                    transactions_hash: "ab".repeat(32),
                    affected_accounts_count: 1,
                    gcr_edits: [{ type: "balance", account: ACCOUNT, operation: "add", amount: 1 }],
                } as any,
            ]),
            spyOn(L2PSProofManager, "verifyProof").mockResolvedValue(true),
            spyOn(HandleGCR, "prepareEntities").mockResolvedValue({} as any),
            spyOn(HandleGCR, "applyTransaction").mockImplementation(async (_e: any, tx: any) => {
                stamped = applyTime()
                txTimestamp = tx.content.timestamp
                return { success: false, message: "stop here" } as any
            }),
        )

        await L2PSConsensus.applyPendingProofs(12, true, undefined, BLOCK_SEC)

        expect(stamped).toEqual(new Date(BLOCK_SEC * 1000))
        expect(txTimestamp).toBe(BLOCK_SEC * 1000)
    })
})
