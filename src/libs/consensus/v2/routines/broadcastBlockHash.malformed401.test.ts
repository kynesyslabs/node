/**
 * A member that refuses our hash attaches its own candidate for the tx-set
 * diagnostic. That payload is peer input: whatever shape it takes, the
 * refusal must stay one con vote and never reject the whole broadcast,
 * whose rejection ends the round for every honest proposer.
 */

import { describe, expect, it, spyOn } from "bun:test"
import { broadcastBlockHash } from "./broadcastBlockHash"
import Mempool from "@/libs/blockchain/mempool"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import * as forkScheduleWatch from "@/libs/peer/routines/forkScheduleWatch"

const block = {
    hash: "ours",
    number: 8,
    content: { ordered_transactions: ["tx-a"] },
    validation_data: { signatures: {} },
}

const refusing = (
    identity: string,
    ourBlock: unknown,
    message: unknown = "Hash does not correspond to our candidate block",
) => ({
    identity,
    longCall: async () => ({
        result: 401,
        response: identity,
        extra: { message, ourBlock },
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

    // JSON.parse yields these shapes from a peer's wire bytes.
    const messages: [string, unknown][] = [
        ["an object with a non-callable toString", JSON.parse('{"toString":1}')],
        ["an object with a null toString", JSON.parse('{"toString":null}')],
        ["an object with a non-callable valueOf", JSON.parse('{"valueOf":1,"toString":1}')],
        ["an array", [1, 2]],
        ["a number", 7],
    ]
    for (const [label, message] of messages) {
        it(`counts a 401 whose message is ${label} as con`, async () => {
            getSharedState.candidateBlock = block as never
            const [pro, con] = await withMempool(
                async () => [],
                () =>
                    broadcastBlockHash(
                        block as never,
                        [refusing("bad", mismatch(["tx-b"]), message)] as never,
                    ),
            )
            expect(pro).toBe(0)
            expect(con).toBe(1)
        })
    }

    it("logs a bounded prefix of an oversized refusal message", async () => {
        getSharedState.candidateBlock = block as never
        const spy = spyOn(log, "error")
        try {
            await withMempool(
                async () => [],
                () =>
                    broadcastBlockHash(
                        block as never,
                        [refusing("bad", undefined, "x".repeat(100_000))] as never,
                    ),
            )
            const refusalLine = spy.mock.calls
                .map(args => String(args[0]))
                .find(line => line.includes("not confirmed by validator bad"))
            expect(refusalLine).toBeDefined()
            expect(refusalLine!.length).toBeLessThan(400)
        } finally {
            spy.mockRestore()
        }
    })

    it("asks for a fork schedule comparison when a member refuses or does not answer", async () => {
        getSharedState.candidateBlock = block as never
        const spy = spyOn(forkScheduleWatch, "onShardMemberUnresponsive").mockResolvedValue(undefined)
        try {
            const silent = { identity: "silent", longCall: async () => undefined }
            const busy = {
                identity: "busy",
                longCall: async () => ({ result: 404, response: "busy", extra: null }),
            }
            await broadcastBlockHash(block as never, [silent, busy] as never)
            expect(spy).toHaveBeenCalledTimes(2)
        } finally {
            spy.mockRestore()
        }
    })
})
