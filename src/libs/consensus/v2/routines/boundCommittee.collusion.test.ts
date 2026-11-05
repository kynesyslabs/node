/**
 * Ten staked validators, shardSize 10, committeeBinding on: three colluders
 * leave one honest validator H out of their peerlist reports and withhold
 * their votes. Pins the chain of computations from the peerlist merge to
 * the verifier for that case, with real ed25519 signatures:
 *
 * - H stays in the merged peerlist as long as all seven honest members
 *   report it (7 of 7 needed); one honest member missing H drops it.
 * - A peerlist of 9 is at or above the quorum, so getBoundPool keeps it and
 *   the committee shrinks to those 9: the staked fallback fires only below 7.
 * - The bar stays 7 of shardSize, so the six honest members left in the
 *   committee cannot certify the next block, and every retry at that height
 *   draws the same committee: the height stalls.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import {
    type Signer,
    type StubChain,
    makeSigner,
    mockCommitteeChain,
} from "../../../../../testing/consensus/committeeTestKit"
import Hashing from "src/libs/crypto/hashing"

const PARENT = 20

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 10,
    publicKeyHex: "",
    lastBlockNumber: PARENT,
    lastBlockHash: `hash-${PARENT}`,
    genesisBlockHash: "hash-0",
    forkConfig: {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
        commitLock: { activationHeight: null },
    },
    identity: { masterSeed: new Uint8Array(128).fill(5) },
    getBlockTimestampMinDelta: () => 1,
    getBlockTimestampTolerance: () => 60,
}

const chain: StubChain = { peerlist: [], staked: null, tip: PARENT }
mockCommitteeChain(sharedState, chain)

jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 5000,
}))
jest.mock("src/libs/debug/nonceTrace", () => ({
    debugAssertionsEnabled: () => false,
}))

const { verifyBlock } = await import("src/libs/blockchain/validation/verifyBlock")
const {
    getBoundCommittee,
    getBoundPool,
    getCommitteeFloor,
    __resetValidatorCache: resetPoolCache,
} = await import("./getShard")
const {
    __resetPeerlistMerge: resetPeerlistMerge,
    computeMergedPeerlist,
    contributePeerlist,
} = await import("./peerlistMerge")
const { producerCommits, verifierThreshold } = await import("../quorum")
const { serializeBlockContent } = await import("@/forks")
const validatorPool = (
    await import("src/libs/blockchain/validation/txValidatorPool")
).default.getInstance()

let validators: Signer[] = []
let honest: Signer[] = []
let colluders: Signer[] = []
let excluded: Signer
let observer: Signer

const ids = (signers: Signer[]) => signers.map(s => s.identity)
const atParent = (identity: string) => ({
    identity,
    block: PARENT,
    block_hash: `hash-${PARENT}`,
})

/**
 * Every member reports all ten validators at the parent, except that the
 * colluders, and the honest members in `honestMissingH`, leave H out.
 */
function contributeRound(honestMissingH: Signer[]): void {
    const withoutH = validators.filter(v => v !== excluded)
    for (const member of validators) {
        const leavesHOut =
            colluders.includes(member) || honestMissingH.includes(member)
        const seen = leavesHOut ? withoutH : validators
        contributePeerlist(PARENT + 1, member.identity, ids(seen).map(atParent))
    }
}

/** Commit block PARENT + 1 with `peerlist`, so the next committee draws from it. */
function commitParent(peerlist: string[]): void {
    resetPoolCache()
    chain.peerlist = peerlist
    chain.staked = ids(validators)
    chain.tip = PARENT + 1
}

async function nextBlockSignedBy(signers: Signer[]) {
    const number = PARENT + 2
    const content = {
        previousHash: `hash-${PARENT + 1}`,
        timestamp: 2000,
        nonce: "collusion",
    }
    const block = {
        number,
        hash: Hashing.sha256(serializeBlockContent(content as never, number)),
        content,
        validation_data: { signatures: {} as Record<string, string> },
    }
    for (const s of signers) {
        block.validation_data.signatures[s.identity] = await s.sign(block.hash)
    }
    return block as never
}

beforeAll(async () => {
    validators = await Promise.all(
        Array.from({ length: 10 }, (_, i) => makeSigner(`collusion-${i}`, i + 31)),
    )
    observer = await makeSigner("collusion-observer", 99)
    honest = validators.slice(0, 7)
    excluded = honest[6]
    colluders = validators.slice(7)
    await validatorPool.start(1)
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(() => {
    resetPoolCache()
    resetPeerlistMerge()
    // Not a member, so only the members' contributions vote.
    sharedState.publicKeyHex = observer.identity
    chain.peerlist = ids(validators)
    chain.staked = null
    chain.tip = PARENT
})

describe("three colluders leaving one honest validator out (shardSize 10)", () => {
    it("cannot drop H on their own: seven honest reports are the quorum", async () => {
        contributeRound([])
        const merged = await computeMergedPeerlist(PARENT + 1, ids(validators))
        expect(merged).toContain(excluded.identity)
        expect(merged).toHaveLength(10)
    })

    it("drops H when one honest member also misses it", async () => {
        contributeRound([honest[0]])
        const merged = await computeMergedPeerlist(PARENT + 1, ids(validators))
        expect(merged).not.toContain(excluded.identity)
        expect(merged).toHaveLength(9)
    })

    it("keeps a pool of 9 as is: the staked fallback fires only below 7", async () => {
        commitParent(ids(validators.filter(v => v !== excluded)))
        expect(getCommitteeFloor()).toBe(7)
        const pool = await getBoundPool(PARENT + 1)
        expect(pool).toHaveLength(9)
        const committee = await getBoundCommittee(PARENT + 1)
        expect(committee).toHaveLength(9)
        expect(committee).not.toContain(excluded.identity)
        expect(verifierThreshold(10, committee.length, true)).toBe(7)
    })

    it("stalls the next height: six honest committee votes cannot reach 7", async () => {
        commitParent(ids(validators.filter(v => v !== excluded)))
        const honestMembers = honest.filter(h => h !== excluded)
        expect(honestMembers).toHaveLength(6)
        expect(producerCommits(6, 9, 10)).toBe(false)

        const short = await verifyBlock(await nextBlockSignedBy(honestMembers))
        expect(short.valid).toBe(false)
        expect(short.reason).toContain("6 of a bound committee of 9 (need 7)")

        // H signing does not help: it is not in the committee.
        const withH = await verifyBlock(await nextBlockSignedBy(honest))
        expect(withH.valid).toBe(false)

        // Only a colluder's vote certifies it.
        const withColluder = await verifyBlock(
            await nextBlockSignedBy([...honestMembers, colluders[0]]),
        )
        expect(withColluder).toEqual({ valid: true })
    })

    it("draws the same committee on every retry at that height", async () => {
        commitParent(ids(validators.filter(v => v !== excluded)))
        const first = await getBoundCommittee(PARENT + 1)
        resetPoolCache()
        expect(await getBoundCommittee(PARENT + 1)).toEqual(first)
    })

    it("does recover once the pool falls below 7, where the staked fallback seats H again", async () => {
        commitParent(ids(honest.filter(h => h !== excluded)))
        const committee = await getBoundCommittee(PARENT + 1)
        expect(committee).toHaveLength(10)
        expect(committee).toContain(excluded.identity)
        expect(await verifyBlock(await nextBlockSignedBy(honest))).toEqual({
            valid: true,
        })
    })
})
