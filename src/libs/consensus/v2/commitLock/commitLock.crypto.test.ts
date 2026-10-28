/**
 * The commitLock vote domains, certificates and proofs of lock with real
 * ed25519: committee members sign with the SDK's unified crypto and every
 * check runs through a started TxValidatorPool. Only chain storage and the
 * validator set are stubbed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import {
    type Signer,
    type StubChain,
    makeBlock,
    makeSigner,
    mockCommitteeChain,
    signedBy,
} from "../../../../../testing/consensus/committeeTestKit"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 4,
    publicKeyHex: "",
    lastBlockNumber: 9,
    lastBlockHash: "hash-9",
    genesisBlockHash: "hash-0",
    forkConfig: {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
        commitLock: { activationHeight: 0 },
    },
    identity: { masterSeed: new Uint8Array(128).fill(7) },
    getBlockTimestampMinDelta: () => 1,
    getBlockTimestampTolerance: () => 60,
}

const chain: StubChain = { peerlist: [], staked: null, tip: 9 }
mockCommitteeChain(sharedState, chain)

const metrics = { equivocations: 0 }
jest.mock("@/features/metrics/consensusMetrics", () => ({
    countBlockHashMismatch: () => undefined,
    countConflictingBlock: () => undefined,
    countCommitLock: () => undefined,
    countLockMoved: () => undefined,
    countPrecommitEquivocation: () => {
        metrics.equivocations++
    },
    countMissedSignature: () => undefined,
    setForkScheduleMismatch: () => undefined,
    setConsensusAbstaining: () => undefined,
}))
jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 2000,
}))
jest.mock("src/libs/debug/nonceTrace", () => ({
    debugAssertionsEnabled: () => false,
}))
jest.mock("src/libs/blockchain/validation/verifyBlockTxSignatures", () => ({
    verifyBlockTxSignatures: async () => ({ valid: true }),
}))

const { verifyBlock } = await import("src/libs/blockchain/validation/verifyBlock")
const { getBoundCommittee, __resetValidatorCache: resetPoolCache } = await import(
    "src/libs/consensus/v2/routines/getShard"
)
const { committeeCommitShortfall } = await import(
    "src/libs/consensus/v2/routines/committeeCommit"
)
const validatorPool = (
    await import("src/libs/blockchain/validation/txValidatorPool")
).default.getInstance()
const domain = await import("./domain")
const votes = await import("./votes")

const H = 10
const R1 = 5000
const R2 = 5010

let signers: Signer[] = []
let committee: string[] = []
let members: Signer[] = []
let outsiders: Signer[] = []

async function prevotes(hash: string, round: number, by: Signer[], height = H) {
    const out: Record<string, string> = {}
    for (const s of by) out[s.identity] = await s.sign(domain.prevoteMessage(height, round, hash))
    return out
}

async function precommits(hash: string, round: number, by: Signer[], height = H) {
    const out: Record<string, string> = {}
    for (const s of by) out[s.identity] = await s.sign(domain.precommitMessage(height, round, hash))
    return out
}

/** A block carrying `signatures` as its certificate for `round`. */
function certified(nonce: string, round: unknown, signatures: Record<string, string>) {
    const block = makeBlock(nonce)
    block.validation_data = { signatures, round }
    return block
}

beforeAll(async () => {
    signers = await Promise.all(
        Array.from({ length: 6 }, (_, i) => makeSigner(`commit-lock-${i}`, i + 21)),
    )
    await validatorPool.start(1)
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    resetPoolCache()
    domain.__resetCommitLockDomain()
    metrics.equivocations = 0
    sharedState.shardSize = 4
    sharedState.forkConfig.committeeBinding.activationHeight = 0
    sharedState.forkConfig.commitLock.activationHeight = 0
    chain.peerlist = signers.map(s => s.identity)
    committee = await getBoundCommittee(9)
    members = committee.map(id => signers.find(s => s.identity === id) as Signer)
    outsiders = signers.filter(s => !committee.includes(s.identity))
})

describe("vote domains", () => {
    it("bind the height and the round into the signed message", () => {
        expect(domain.prevoteMessage(10, 5, "ab")).toBe("demos-prevote:10:5:ab")
        expect(domain.precommitMessage(10, 5, "ab")).toBe("demos-precommit:10:5:ab")
    })

    it("do not let a prevote count as a precommit, or the reverse", async () => {
        const hash = makeBlock("x").hash
        const pv = await prevotes(hash, R1, members)
        const pc = await precommits(hash, R1, members)

        expect((await votes.verifiedPrecommitters(H, R1, hash, pv, committee)).size).toBe(0)
        expect((await votes.verifiedPrevoters(H, R1, hash, pc, committee)).size).toBe(0)
        expect((await votes.verifiedPrevoters(H, R1, hash, pv, committee)).size).toBe(4)
        expect((await votes.verifiedPrecommitters(H, R1, hash, pc, committee)).size).toBe(4)
    })

    it("do not let a vote count in another round or at another height", async () => {
        const hash = makeBlock("x").hash
        const pc = await precommits(hash, R1, members)

        expect((await votes.verifiedPrecommitters(H, R2, hash, pc, committee)).size).toBe(0)
        expect((await votes.verifiedPrecommitters(H + 1, R1, hash, pc, committee)).size).toBe(0)
    })

    it("do not let a signature over the bare hash count as a vote", async () => {
        const block = await signedBy(makeBlock("x"), members)
        const sigs = block.validation_data.signatures

        expect((await votes.verifiedPrevoters(H, R1, block.hash, sigs, committee)).size).toBe(0)
        expect((await votes.verifiedPrecommitters(H, R1, block.hash, sigs, committee)).size).toBe(0)
    })
})

describe("certificate under commitLock", () => {
    it("accepts a quorum of committee precommits from one round", async () => {
        const hash = makeBlock("x").hash
        const block = certified("x", R1, await precommits(hash, R1, members.slice(0, 3)))
        expect(await verifyBlock(block)).toEqual({ valid: true })
        expect(await committeeCommitShortfall(block, committee, 4)).toBeNull()
    })

    it("rejects a quorum of prevotes", async () => {
        const hash = makeBlock("x").hash
        const block = certified("x", R1, await prevotes(hash, R1, members))
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("0 of a bound committee of 4")
    })

    it("rejects precommits mixed from two rounds, whichever round the block names", async () => {
        const hash = makeBlock("x").hash
        const mixed = {
            ...(await precommits(hash, R1, members.slice(0, 2))),
            ...(await precommits(hash, R2, members.slice(2, 3))),
        }
        for (const round of [R1, R2]) {
            const result = await verifyBlock(certified("x", round, mixed))
            expect(result.valid).toBe(false)
            expect(result.reason).toContain(`${round === R1 ? 2 : 1} of a bound committee of 4`)
        }
    })

    it("ignores a valid precommit by a signer outside the committee", async () => {
        const hash = makeBlock("x").hash
        const block = certified("x", R1, await precommits(hash, R1, [...members.slice(0, 2), ...outsiders]))
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("2 of a bound committee of 4")
        expect(await committeeCommitShortfall(block, committee, 4)).not.toBeNull()
    })

    it("rejects a block without a valid round", async () => {
        const hash = makeBlock("x").hash
        const sigs = await precommits(hash, R1, members)
        for (const round of [undefined, 0, -1, 1.5, "5000"]) {
            const result = await verifyBlock(certified("x", round, sigs))
            expect(result.valid).toBe(false)
            expect(result.reason).toContain("validation_data.round")
            expect(await committeeCommitShortfall(certified("x", round, sigs), committee, 4)).not.toBeNull()
        }
    })
})

describe("proof of lock", () => {
    it("keeps exactly the verified committee prevotes of a quorum", async () => {
        const hash = makeBlock("x").hash
        const sigs = { ...(await prevotes(hash, R1, members.slice(0, 3))), ...(await prevotes(hash, R1, outsiders)) }
        const pol = await votes.proofOfLock(H, R1, hash, sigs, committee)
        expect(Object.keys(pol ?? {}).sort()).toEqual(members.slice(0, 3).map(m => m.identity).sort())
    })

    it("rejects a forged signature that leaves fewer than a quorum", async () => {
        const hash = makeBlock("x").hash
        const sigs = await prevotes(hash, R1, members.slice(0, 3))
        const id = members[2].identity
        sigs[id] = sigs[id].slice(0, -2) + (sigs[id].slice(-2) === "00" ? "01" : "00")
        expect(await votes.proofOfLock(H, R1, hash, sigs, committee)).toBeNull()
    })

    it("rejects prevotes of another round or block, and precommits", async () => {
        const hash = makeBlock("x").hash
        const other = makeBlock("y").hash
        expect(await votes.proofOfLock(H, R2, hash, await prevotes(hash, R1, members), committee)).toBeNull()
        expect(await votes.proofOfLock(H, R1, hash, await prevotes(other, R1, members), committee)).toBeNull()
        expect(await votes.proofOfLock(H, R1, hash, await precommits(hash, R1, members), committee)).toBeNull()
    })

    it("rejects maps that are not signature maps or are oversized", async () => {
        const hash = makeBlock("x").hash
        expect(await votes.proofOfLock(H, R1, hash, null, committee)).toBeNull()
        expect(await votes.proofOfLock(H, R1, hash, ["a"], committee)).toBeNull()
        expect(await votes.proofOfLock(H, R1, hash, { a: 1 }, committee)).toBeNull()
        const big: Record<string, string> = await prevotes(hash, R1, members)
        for (let i = 0; i < 2 * committee.length; i++) big[`junk-${i}`] = "00"
        expect(await votes.proofOfLock(H, R1, hash, big, committee)).toBeNull()
    })
})

describe("precommit equivocation", () => {
    it("flags two precommits by one member for different blocks in one round", async () => {
        const book = new votes.PrecommitBook()
        const x = makeBlock("x").hash
        const y = makeBlock("y").hash
        const m = members[1]

        expect(await votes.admitPrecommits(H, R1, x, await precommits(x, R1, [m]), committee, book)).toEqual([m.identity])
        expect(metrics.equivocations).toBe(0)
        const sigY = (await precommits(y, R1, [m]))[m.identity]
        expect(book.record(H, R1, y, m.identity, sigY)).toBe("equivocation")
        expect(metrics.equivocations).toBe(1)
    })

    it("treats different blocks in different rounds as a lock move", async () => {
        const book = new votes.PrecommitBook()
        const x = makeBlock("x").hash
        const y = makeBlock("y").hash
        const m = members[1]
        await votes.admitPrecommits(H, R1, x, await precommits(x, R1, [m]), committee, book)
        await votes.admitPrecommits(H, R2, y, await precommits(y, R2, [m]), committee, book)

        expect(metrics.equivocations).toBe(0)
        expect(Object.keys(book.precommitsFor(H, R1, x))).toEqual([m.identity])
        expect(Object.keys(book.precommitsFor(H, R2, y))).toEqual([m.identity])
        expect(book.precommitsFor(H, R2, x)).toEqual({})
    })

    it("does not record precommits that do not verify", async () => {
        const book = new votes.PrecommitBook()
        const x = makeBlock("x").hash
        const forged = await prevotes(x, R1, members)
        expect(await votes.admitPrecommits(H, R1, x, forged, committee, book)).toEqual([])
        expect(book.precommitsFor(H, R1, x)).toEqual({})
    })

    it("forgets a height once a higher one is recorded", async () => {
        const book = new votes.PrecommitBook()
        const x = makeBlock("x").hash
        await votes.admitPrecommits(H, R1, x, await precommits(x, R1, members), committee, book)
        book.record(H + 1, R1, "z", members[0].identity, "00")
        expect(book.precommitsFor(H, R1, x)).toEqual({})
        expect(book.record(H, R1, x, members[0].identity, "00")).toBe("stale")
    })
})

describe("with commitLock dormant", () => {
    it("signs and verifies the bare block hash as before", async () => {
        sharedState.forkConfig.commitLock.activationHeight = null
        const block = await signedBy(makeBlock("x"), members.slice(0, 3))
        expect(domain.voteMessageOf(block)).toBe(block.hash)
        expect(domain.certificateMessageOf(block)).toBe(block.hash)
        expect(await verifyBlock(block)).toEqual({ valid: true })
    })

    it("does not accept a precommit certificate before the fork height", async () => {
        sharedState.forkConfig.commitLock.activationHeight = H + 1
        const hash = makeBlock("x").hash
        const result = await verifyBlock(certified("x", R1, await precommits(hash, R1, members)))
        expect(result.valid).toBe(false)
    })

    it("stays inactive when committeeBinding is not active", () => {
        sharedState.forkConfig.committeeBinding.activationHeight = null
        expect(domain.commitLockActive(H)).toBe(false)
        expect(domain.voteMessageOf(makeBlock("x"))).toBe(makeBlock("x").hash)
    })
})
