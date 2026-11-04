/**
 * Safety of the committeeBinding verifier: any two signer sets that sync
 * accepts at one height share at least 2q - shardSize members, which is
 * more than the floor((shardSize - 1) / 3) faulty validators the quorum
 * tolerates, so two conflicting blocks need an honest validator to sign
 * both. Runs the real verifyBlock and committee draw; only signature
 * verification is replaced by a lookup, the real ed25519 path has its own
 * suite next to verifyBlock.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import {
    type StubChain,
    mockCommitteeChain,
} from "../../../../testing/consensus/committeeTestKit"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 10,
    publicKeyHex: "",
    lastBlockNumber: 9,
    lastBlockHash: "hash-9",
    forkConfig: {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
    },
    getBlockTimestampMinDelta: () => 1,
    getBlockTimestampTolerance: () => 60,
}

const chain: StubChain = { peerlist: [], staked: null, tip: 9 }
mockCommitteeChain(sharedState, chain)

jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 2000,
}))
jest.mock("src/libs/debug/nonceTrace", () => ({
    debugAssertionsEnabled: () => false,
}))
jest.mock("src/libs/blockchain/validation/verifyBlockTxSignatures", () => ({
    verifyBlockTxSignatures: async () => ({ valid: true }),
}))

const toHex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex")
jest.mock("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async ({ message, signature, publicKey }: Record<string, Uint8Array>) =>
                Buffer.from(signature).toString() ===
                `${toHex(publicKey)}:${new TextDecoder().decode(message)}`,
        }),
    },
}))

const { verifyBlock } = await import("src/libs/blockchain/validation/verifyBlock")
const { getBoundCommittee, __resetValidatorCache: resetPoolCache } = await import(
    "./routines/getShard"
)
const { quorumThreshold } = await import("./quorum")
const { PINNED_SHARD_IDENTITIES } = await import("src/utilities/constants")
const sha256 = (await import("src/libs/crypto/hashing")).default.sha256

const identity = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")

/** A block at height 10 whose hash is real and whose signers sign that hash. */
function blockSignedBy(variant: string, signers: string[]) {
    const content = { previousHash: "hash-9", timestamp: 1500, variant }
    const hash = sha256(JSON.stringify(content))
    const signatures: Record<string, string> = {}
    for (const id of signers) {
        signatures[id] = toHex(new TextEncoder().encode(`${id}:${hash}`))
    }
    return { number: 10, hash, content, validation_data: { signatures } } as any
}

const accepted = async (variant: string, signers: string[]) =>
    (await verifyBlock(blockSignedBy(variant, signers))).valid

function setPool(size: number): string[] {
    chain.peerlist = Array.from({ length: size }, (_, i) => identity(i))
    resetPoolCache()
    return chain.peerlist
}

/** Deterministic PRNG so a failing sample is reproducible. */
function mulberry32(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const overlap = (a: string[], b: string[]) => {
    const set = new Set(a)
    return b.filter(id => set.has(id)).length
}

beforeEach(() => {
    sharedState.forkConfig.committeeBinding.activationHeight = 0
    chain.staked = null
})

/**
 * The two accepted signer sets sharing the fewest committee members: a
 * quorum from either end of the committee, each padded with every signer
 * outside it. Returns how many members they share.
 */
async function minimalOverlap(committee: string[], outside: string[]): Promise<number> {
    const q = quorumThreshold(sharedState.shardSize)
    const low = [...committee.slice(0, q), ...outside]
    const high = [...committee.slice(committee.length - q), ...outside]
    expect(await accepted("low", low)).toBe(true)
    expect(await accepted("high", high)).toBe(true)
    expect(await accepted("short", [...committee.slice(0, q - 1), ...outside])).toBe(false)
    return overlap(low, high) - outside.length
}

describe("committeeBinding verifier safety", () => {
    for (const shardSize of [4, 7, 10]) {
        const q = quorumThreshold(shardSize)
        const faults = Math.floor((shardSize - 1) / 3)

        it(`shardSize ${shardSize}: two accepted signer sets overlap in at least 2q - n, for pools up to 2n + 4`, async () => {
            sharedState.shardSize = shardSize
            expect(2 * q - shardSize).toBeGreaterThan(faults)
            let pairsChecked = 0

            for (let poolSize = 1; poolSize <= 2 * shardSize + 4; poolSize++) {
                const pool = setPool(poolSize)
                const committee = await getBoundCommittee(9)
                const outside = pool.filter(id => !committee.includes(id))
                expect(committee).toHaveLength(Math.min(poolSize, shardSize))

                if (committee.length < q) {
                    // No committee can reach the bar: even every pool member signing fails.
                    expect(await accepted("all", pool)).toBe(false)
                    continue
                }

                // The two accepted sets sharing the fewest members: the quorum
                // from either end of the committee, each padded with every
                // signer outside it.
                const low = [...committee.slice(0, q), ...outside]
                const high = [...committee.slice(committee.length - q), ...outside]
                expect(await accepted("low", low)).toBe(true)
                expect(await accepted("high", high)).toBe(true)
                const shared = overlap(low, high) - outside.length
                expect(shared).toBe(2 * q - committee.length)
                expect(shared).toBeGreaterThanOrEqual(2 * q - shardSize)
                expect(shared).toBeGreaterThan(faults)

                // One committee signature short of the bar fails, however many
                // pool members outside the committee sign.
                expect(await accepted("short", [...committee.slice(0, q - 1), ...outside])).toBe(
                    false,
                )

                // Random signer sets: every accepted pair overlaps enough.
                const random = mulberry32(shardSize * 1000 + poolSize)
                const acceptedSets: string[][] = []
                for (let sample = 0; sample < 60; sample++) {
                    const signers = pool.filter(() => random() < 0.6)
                    if (await accepted(`r${sample}`, signers)) acceptedSets.push(signers)
                }
                for (let i = 0; i < acceptedSets.length; i++) {
                    for (let j = i + 1; j < acceptedSets.length; j++) {
                        expect(overlap(acceptedSets[i], acceptedSets[j])).toBeGreaterThanOrEqual(
                            2 * q - shardSize,
                        )
                        pairsChecked++
                    }
                }
            }
            expect(pairsChecked).toBeGreaterThan(1000)
        })

        it(`shardSize ${shardSize}: before the fork, two disjoint quorums from a pool of 2q are both accepted`, async () => {
            sharedState.shardSize = shardSize
            sharedState.forkConfig.committeeBinding.activationHeight = null
            const pool = setPool(2 * q)

            expect(await accepted("A", pool.slice(0, q))).toBe(true)
            expect(await accepted("B", pool.slice(q))).toBe(true)
        })
    }
})

describe("disjoint signer groups of 7 from a pool of 14 at shardSize 10", () => {
    function* halves(pool: string[], size: number, start = 0, picked: string[] = []): Generator<string[]> {
        if (picked.length === size) {
            yield picked
            return
        }
        for (let i = start; i <= pool.length - (size - picked.length); i++) {
            yield* halves(pool, size, i + 1, [...picked, pool[i]])
        }
    }

    it("passes both blocks before the fork and never both under it, for every split", async () => {
        sharedState.shardSize = 10
        const pool = setPool(14)
        let splits = 0
        let oneAccepted = 0

        for (const groupA of halves(pool, 7)) {
            const groupB = pool.filter(id => !groupA.includes(id))
            splits++

            sharedState.forkConfig.committeeBinding.activationHeight = null
            expect(await accepted("A", groupA)).toBe(true)
            expect(await accepted("B", groupB)).toBe(true)

            sharedState.forkConfig.committeeBinding.activationHeight = 0
            const verdicts = [await accepted("A", groupA), await accepted("B", groupB)]
            expect(verdicts).not.toEqual([true, true])
            if (verdicts.includes(true)) oneAccepted++
        }

        expect(splits).toBe(3432)
        // A side holding 7 of the 10 committee members keeps its block.
        expect(oneAccepted).toBeGreaterThan(0)
    })
})

describe("committeeBinding safety with a pinned identity in the pool", () => {
    for (const shardSize of [4, 7]) {
        it(`shardSize ${shardSize}: the pin takes a seat and accepted sets still overlap in 2q - n`, async () => {
            sharedState.shardSize = shardSize
            const q = quorumThreshold(shardSize)
            const pin = PINNED_SHARD_IDENTITIES[0]
            const pool = [...Array.from({ length: 2 * shardSize }, (_, i) => identity(i)), pin]
            chain.peerlist = pool
            resetPoolCache()

            const committee = await getBoundCommittee(9)
            expect(committee).toHaveLength(shardSize)
            expect(committee[0]).toBe(pin)

            const outside = pool.filter(id => !committee.includes(id))
            const shared = await minimalOverlap(committee, outside)
            expect(shared).toBe(2 * q - shardSize)
            expect(shared).toBeGreaterThan(Math.floor((shardSize - 1) / 3))

            // The pin alone with outsiders cannot carry a block.
            expect(await accepted("pin", [pin, ...committee.slice(1, q - 1), ...outside])).toBe(
                false,
            )
        })
    }
})

describe("committeeBinding safety when the committee falls back to the staked set", () => {
    for (const shardSize of [4, 7]) {
        it(`shardSize ${shardSize}: a peerlist below q draws from the staked set, with the same overlap`, async () => {
            sharedState.shardSize = shardSize
            const q = quorumThreshold(shardSize)
            const staked = Array.from({ length: 2 * shardSize }, (_, i) => identity(i))
            const peerlist = staked.slice(0, q - 1)
            chain.staked = staked
            chain.peerlist = peerlist
            resetPoolCache()

            const committee = await getBoundCommittee(9)
            expect(committee).toHaveLength(shardSize)
            expect(committee.every(id => staked.includes(id))).toBe(true)
            expect(committee.some(id => !peerlist.includes(id))).toBe(true)

            // Every committed peer signing is still short of the bar.
            expect(await accepted("peerlist", peerlist)).toBe(false)

            const outside = staked.filter(id => !committee.includes(id))
            const shared = await minimalOverlap(committee, outside)
            expect(shared).toBe(2 * q - shardSize)
            expect(shared).toBeGreaterThan(Math.floor((shardSize - 1) / 3))
        })
    }
})
