/**
 * The first committee the go/no-go tool computes offline from the genesis
 * file must be the committee the node itself binds to block 1. Runs the
 * node's seed and committee code against a stubbed chain holding block 0
 * and the genesis staked set, and compares.
 */

import { describe, expect, it } from "bun:test"
import { type StubChain, mockCommitteeChain } from "../testing/consensus/committeeTestKit"
import { PINNED_SHARD_IDENTITIES } from "src/utilities/constants"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 10,
    publicKeyHex: "",
    lastBlockNumber: 0,
    lastBlockHash: "hash-0",
    forkConfig: { committeeBinding: { activationHeight: 0 } },
}
const chain: StubChain = { peerlist: [], staked: [], tip: 0 }
mockCommitteeChain(sharedState, chain)

const { default: getCommonValidatorSeed } = await import(
    "src/libs/consensus/v2/routines/getCommonValidatorSeed"
)
const { getBoundCommittee, __resetValidatorCache } = await import(
    "src/libs/consensus/v2/routines/getShard"
)
const { firstCommittee, firstCommitteeSeed } = await import("./launch-go-no-go")

const address = (i: number) => "0x" + (i * 2654435761).toString(16).padStart(64, "ab")

function genesisRows(count: number) {
    const rows: Array<{ address: string; status: string; valid_at: number }> = []
    for (let i = 1; i <= count; i++) {
        // Mixed case, as genesis files are hand-edited
        const id = i % 3 === 0 ? address(i).toUpperCase().replace(/^0X/, "0x") : address(i)
        rows.push({ address: id, status: "2", valid_at: 0 })
    }
    return rows
}

async function nodeCommittee(rows: Array<{ address: string; status: string; valid_at: number }>, shardSize: number) {
    const active = rows.filter(r => r.status === "2" && r.valid_at <= 0).map(r => r.address)
    chain.staked = active
    sharedState.shardSize = shardSize
    __resetValidatorCache()
    const { commonValidatorSeed } = await getCommonValidatorSeed({ number: 0, hash: "hash-0" } as any)
    return { seed: commonValidatorSeed, committee: await getBoundCommittee(0, commonValidatorSeed) }
}

describe("first committee", () => {
    it("uses the node's seed for block 1", async () => {
        const { seed } = await nodeCommittee(genesisRows(4), 10)
        expect(firstCommitteeSeed("hash-0")).toBe(seed)
    })

    for (const [count, shardSize] of [
        [13, 10],
        [10, 10],
        [25, 10],
        [9, 7],
    ] as const) {
        it(`matches the node's bound committee for ${count} validators, shardSize ${shardSize}`, async () => {
            const rows = genesisRows(count)
            const { committee } = await nodeCommittee(rows, shardSize)
            expect(committee).toHaveLength(Math.min(count, shardSize))
            expect(firstCommittee(rows, "hash-0", shardSize)).toEqual(committee.map(id => id.toLowerCase()))
        })
    }

    it("puts a pinned identity first, as the node does", async () => {
        const rows = [...genesisRows(14), { address: PINNED_SHARD_IDENTITIES[1], status: "2", valid_at: 0 }]
        const { committee } = await nodeCommittee(rows, 10)
        const ours = firstCommittee(rows, "hash-0", 10)
        expect(ours[0]).toBe(PINNED_SHARD_IDENTITIES[1])
        expect(ours).toEqual(committee.map(id => id.toLowerCase()))
    })

    it("leaves out validators that are not active at block 0", async () => {
        const rows = [
            ...genesisRows(12),
            { address: address(90), status: "1", valid_at: 0 },
            { address: address(91), status: "2", valid_at: 5 },
        ]
        const { committee } = await nodeCommittee(rows, 10)
        const ours = firstCommittee(rows, "hash-0", 10)
        expect(ours).toEqual(committee.map(id => id.toLowerCase()))
        expect(ours).not.toContain(address(90))
        expect(ours).not.toContain(address(91))
    })

    it("does not depend on the genesis hash's case or 0x prefix", () => {
        const rows = genesisRows(13)
        const hash = "cd".repeat(32)
        expect(firstCommittee(rows, "0x" + hash.toUpperCase(), 10)).toEqual(firstCommittee(rows, hash, 10))
    })
})
