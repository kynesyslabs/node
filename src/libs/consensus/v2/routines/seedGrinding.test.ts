/**
 * How many different committees a secretary can choose between by picking
 * the timestamp of the block it forges.
 *
 * The common validator seed hashes the last three block hashes, and a block
 * hash covers `content.timestamp`. So every timestamp the co-signers accept
 * for block h is a different seed for h + 1, hence a different draw of the
 * committee that signs h + 1. These counts document that grinding surface:
 * they are expected to change only when the seed rule changes, and a change
 * there should flip them on purpose, not by accident.
 */

import { describe, expect, it } from "bun:test"
import { type StubChain, mockCommitteeChain } from "../../../../../testing/consensus/committeeTestKit"

const sharedState: Record<string, any> = {
    shardSize: 10,
    publicKeyHex: "",
    lastBlockNumber: 0,
    lastBlockHash: "",
    forkConfig: { committeeBinding: { activationHeight: 0 } },
}

const HEIGHT = 100
const chain: StubChain = { peerlist: [], staked: null, tip: HEIGHT - 1 }
mockCommitteeChain(sharedState, chain)

const { serializeBlockContent } = await import("@/forks")
const { default: Hashing } = await import("src/libs/crypto/hashing")
const { default: getCommonValidatorSeed } = await import("./getCommonValidatorSeed")
const { drawBoundCommittee } = await import("./getShard")

const identity = (i: number) => Hashing.sha256(`seed-grinding-validator-${i}`)

/** Block HEIGHT on top of the stub chain, as a secretary would forge it at `timestamp`. */
function blockAt(timestamp: number, peerlist: string[]) {
    const content = {
        ordered_transactions: [] as string[],
        previousHash: `hash-${HEIGHT - 1}`,
        timestamp,
        peerlist,
        native_tables_hashes: { native_gcr: "gcr", native_subnets_txs: "subnets" },
    }
    return {
        number: HEIGHT,
        hash: Hashing.sha256(serializeBlockContent(content as any, HEIGHT)),
        content,
    }
}

/** Distinct committees (as member sets) for block HEIGHT + 1 over 60 consecutive timestamps. */
async function distinctCommittees(poolSize: number): Promise<number> {
    const pool = Array.from({ length: poolSize }, (_, i) => identity(i)).sort()
    const committees = new Set<string>()
    for (let offset = 0; offset < 60; offset++) {
        const block = blockAt(1_700_000_000 + offset, pool)
        const { commonValidatorSeed } = await getCommonValidatorSeed(block as any)
        const committee = drawBoundCommittee(commonValidatorSeed, pool, sharedState.shardSize)
        committees.add([...committee].sort().join(","))
    }
    return committees.size
}

describe("committee seed grinding through the block timestamp", () => {
    it("gives a different seed for every timestamp", async () => {
        const pool = [identity(0), identity(1)]
        const seeds = new Set<string>()
        for (let offset = 0; offset < 60; offset++) {
            const { commonValidatorSeed } = await getCommonValidatorSeed(blockAt(1_700_000_000 + offset, pool) as any)
            seeds.add(commonValidatorSeed)
        }
        expect(seeds.size).toBe(60)
    })

    it("leaves no choice when the pool is no larger than the committee", async () => {
        expect(await distinctCommittees(10)).toBe(1)
    })

    it("lets 60 timestamps reach nearly 60 committees from a pool of 14", async () => {
        // 1001 committees exist; 60 draws collide a few times.
        expect(await distinctCommittees(14)).toBe(57)
    })

    it("lets 60 timestamps reach 60 committees from a pool of 20 or more", async () => {
        expect(await distinctCommittees(20)).toBe(60)
        expect(await distinctCommittees(40)).toBe(60)
    })
})
