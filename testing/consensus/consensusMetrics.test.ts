import { beforeAll, describe, expect, it } from "bun:test"
import { getMetricsService } from "src/features/metrics/MetricsService"
import {
    countBlockHashMismatch,
    countMissedSignature,
    setConsensusAbstaining,
    setForkScheduleMismatch,
} from "src/features/metrics/consensusMetrics"
import { broadcastBlockHash } from "src/libs/consensus/v2/routines/broadcastBlockHash"
import { getSharedState } from "src/utilities/sharedState"

async function sample(name: string): Promise<number> {
    const text = await getMetricsService().getMetrics()
    const line = text
        .split("\n")
        .find(l => l.startsWith(`demos_${name} `))
    if (!line) throw new Error(`metric ${name} is not exported`)
    return Number(line.split(" ")[1])
}

beforeAll(async () => {
    await getMetricsService().initialize()
})

describe("consensus health metrics", () => {
    it("exports the two counters and two gauges from zero", async () => {
        expect(await sample("consensus_block_hash_mismatch_total")).toBe(0)
        expect(await sample("consensus_missed_signatures_total")).toBe(0)
        expect(await sample("fork_schedule_mismatch")).toBe(0)
        expect(await sample("consensus_abstaining")).toBe(0)
    })

    it("counts and sets through the helpers", async () => {
        countMissedSignature()
        countMissedSignature()
        setForkScheduleMismatch(true)
        setConsensusAbstaining(true)
        expect(await sample("consensus_missed_signatures_total")).toBe(2)
        expect(await sample("fork_schedule_mismatch")).toBe(1)
        expect(await sample("consensus_abstaining")).toBe(1)
        setForkScheduleMismatch(false)
        setConsensusAbstaining(false)
        expect(await sample("fork_schedule_mismatch")).toBe(0)
        expect(await sample("consensus_abstaining")).toBe(0)
    })

    it("a block hash counter bump cannot throw", () => {
        expect(() => countBlockHashMismatch()).not.toThrow()
    })
})

describe("block hash disagreement in the vote", () => {
    const block = {
        hash: "ours",
        number: 8,
        content: { ordered_transactions: ["t1"] },
        validation_data: { signatures: {} },
    }
    const disagree = (id: string, hash: string, number = 8) => ({
        identity: id,
        longCall: async () => ({
            result: 401,
            extra: {
                message: "Hash does not correspond to our candidate block",
                ourBlock: { hash, number, txHashes: ["t1"] },
            },
        }),
    })

    it("counts once per peer that holds a different hash for this height", async () => {
        const before = await sample("consensus_block_hash_mismatch_total")
        getSharedState.candidateBlock = block as never
        await broadcastBlockHash(block as never, [
            disagree("p1", "theirs"),
            disagree("p2", "other"),
        ] as never)
        expect(await sample("consensus_block_hash_mismatch_total")).toBe(before + 2)
    })

    it("does not count a refusal that is not about the hash, or a peer for another height", async () => {
        const before = await sample("consensus_block_hash_mismatch_total")
        getSharedState.candidateBlock = block as never
        const notInShard = {
            identity: "p3",
            longCall: async () => ({ result: 401, extra: "Validator is not in the shard" }),
        }
        await broadcastBlockHash(block as never, [
            notInShard,
            disagree("p4", "theirs", 9),
            disagree("p5", "ours"),
        ] as never)
        expect(await sample("consensus_block_hash_mismatch_total")).toBe(before)
    })
})
