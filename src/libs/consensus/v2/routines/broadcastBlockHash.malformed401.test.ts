/**
 * A member that refuses our hash attaches its own candidate for the tx-set
 * diagnostic. That payload is peer input: whatever shape it takes, the
 * refusal must stay one con vote and never reject the whole broadcast,
 * whose rejection ends the round for every honest proposer.
 */

import { describe, expect, it, spyOn } from "bun:test"
import { broadcastBlockHash } from "./broadcastBlockHash"
import Mempool from "@/libs/blockchain/mempool"
import { getSharedState } from "src/utilities/sharedState"

const block = {
    hash: "ours",
    number: 8,
    content: { ordered_transactions: ["tx-a"] },
    validation_data: { signatures: {} },
}

const refusing = (identity: string, ourBlock: unknown) => ({
    identity,
    longCall: async () => ({
        result: 401,
        response: identity,
        extra: { message: "Hash does not correspond to our candidate block", ourBlock },
    }),
})

const mismatch = (txHashes: unknown) => ({ hash: "theirs", number: 8, txHashes })

async function withMempool<T>(
    lookup: () => Promise<unknown>,
    run: () => Promise<T>,
): Promise<T> {
    const spy = spyOn(Mempool, "getTransactionsByHashes")
    spy.mockImplementation(lookup as never)
    try {
        return await run()
    } finally {
        spy.mockRestore()
    }
}

describe("broadcastBlockHash and malformed 401 replies", () => {
    const shapes: [string, unknown][] = [
        ["a number", 5],
        ["a string", "abc"],
        ["an object", { 0: "tx-b", length: 1 }],
        ["null", null],
    ]
    for (const [label, txHashes] of shapes) {
        it(`counts a 401 whose txHashes is ${label} as con`, async () => {
            getSharedState.candidateBlock = block as never
            const [pro, con] = await withMempool(
                async () => [],
                () => broadcastBlockHash(block as never, [refusing("bad", mismatch(txHashes))] as never),
            )
            expect(pro).toBe(0)
            expect(con).toBe(1)
        })
    }

    it("counts a 401 as con when the mempool lookup of its diff throws", async () => {
        getSharedState.candidateBlock = block as never
        const [pro, con] = await withMempool(
            async () => {
                throw new Error("db down")
            },
            () => broadcastBlockHash(block as never, [refusing("bad", mismatch(["tx-b"]))] as never),
        )
        expect(pro).toBe(0)
        expect(con).toBe(1)
    })

    it("still answers when our candidate was cleared during the broadcast", async () => {
        getSharedState.candidateBlock = null as never
        const [, con] = await withMempool(
            async () => [],
            () => broadcastBlockHash(block as never, [refusing("bad", mismatch(["tx-b"]))] as never),
        )
        expect(con).toBe(1)
    })

    it("keeps the other members' outcomes next to a malformed one", async () => {
        getSharedState.candidateBlock = block as never
        const busy = {
            identity: "other",
            longCall: async () => ({ result: 409, response: "other", extra: "busy" }),
        }
        const [pro, con] = await withMempool(
            async () => [],
            () => broadcastBlockHash(block as never, [refusing("bad", mismatch(5)), busy] as never),
        )
        expect(pro).toBe(0)
        expect(con).toBe(2)
    })

    it("counts a missing reply as con", async () => {
        getSharedState.candidateBlock = block as never
        const silent = { identity: "silent", longCall: async () => undefined }
        const [pro, con] = await broadcastBlockHash(block as never, [silent] as never)
        expect(pro).toBe(0)
        expect(con).toBe(1)
    })
})
