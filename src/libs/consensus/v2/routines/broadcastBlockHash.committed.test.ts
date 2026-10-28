/**
 * The proposal carries its height, and a member that already committed that
 * height is reported back to the round with its hash instead of being
 * counted as a plain refusal.
 */

import { describe, expect, it } from "bun:test"
import { broadcastBlockHash } from "./broadcastBlockHash"
import { COMMITTED_HEIGHT_RESULT } from "./committedBlock"
import { getSharedState } from "src/utilities/sharedState"

const block = {
    hash: "ours",
    number: 8,
    content: { ordered_transactions: [] },
    validation_data: { signatures: {} },
}

const member = (identity: string, reply: (params: any[]) => any) => {
    const seen: any[][] = []
    return {
        identity,
        seen,
        longCall: async (req: any, _auth: boolean, opts: any) => {
            seen.push(req.params[0].params)
            const res = reply(req.params[0].params)
            // longCall only hands back codes the caller allows
            if (res.result !== 200 && !opts.allowedCodes.includes(res.result)) {
                return { result: 400, response: "Max retries reached", extra: res }
            }
            return res
        },
    }
}

const committedReply = (number: number, hash: string) => () => ({
    result: COMMITTED_HEIGHT_RESULT,
    response: "peer",
    extra: { message: "Height already committed", committedBlock: { number, hash } },
})

describe("broadcastBlockHash and committed members", () => {
    it("sends the block number as the fourth proposal param", async () => {
        getSharedState.candidateBlock = block as never
        const m = member("p1", () => ({ result: 404, extra: "not formed" }))
        await broadcastBlockHash(block as never, [m] as never)
        expect(m.seen[0][0]).toBe("ours")
        expect(m.seen[0][3]).toBe(8)
    })

    it("returns members that committed our height, counted as con", async () => {
        getSharedState.candidateBlock = block as never
        const a = member("a", committedReply(8, "theirs"))
        const b = member("b", () => ({ result: 404, extra: "not formed" }))
        const [pro, con, committed] = await broadcastBlockHash(
            block as never,
            [a, b] as never,
        )
        expect(pro).toBe(0)
        expect(con).toBe(2)
        expect(committed.map(c => [c.peer.identity, c.hash])).toEqual([
            ["a", "theirs"],
        ])
    })

    it("ignores a committed reply about another height", async () => {
        getSharedState.candidateBlock = block as never
        const a = member("a", committedReply(7, "older"))
        const [, con, committed] = await broadcastBlockHash(
            block as never,
            [a] as never,
        )
        expect(con).toBe(1)
        expect(committed).toEqual([])
    })
})
