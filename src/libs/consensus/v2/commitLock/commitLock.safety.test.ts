/**
 * The safety argument of the commit lock, played out by a committee of four
 * (q = 3, f = 1) with real ed25519 keys, a lock file per member and the
 * real rules: proof-of-lock checks, the per-member precommit decision, the
 * candidate choice, the getLock reply check and verifyBlock on the result.
 *
 * Round 1: everyone prevotes X. Only A gathers the precommits of B and C,
 * certifies X and commits it; then A is cut off, and D never saw a
 * precommit request. The others time out. In round 2 no certificate for a
 * block other than X can form, and the others converge on X.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
    type Signer,
    type StubChain,
    makeBlock,
    makeSigner,
    mockCommitteeChain,
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

jest.mock("@/features/metrics/consensusMetrics", () => ({
    countBlockHashMismatch: () => undefined,
    countConflictingBlock: () => undefined,
    countCommitLock: () => undefined,
    countLockMoved: () => undefined,
    countPrecommitEquivocation: () => undefined,
    countMissedSignature: () => undefined,
    setForkScheduleMismatch: () => undefined,
    setConsensusAbstaining: () => undefined,
}))
jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 2000,
}))
jest.mock("src/libs/blockchain/validation/verifyBlockTxSignatures", () => ({
    verifyBlockTxSignatures: async () => ({ valid: true }),
}))

const { verifyBlock } = await import("src/libs/blockchain/validation/verifyBlock")
const { getBoundCommittee, __resetValidatorCache } = await import("../routines/getShard")
const validatorPool = (
    await import("src/libs/blockchain/validation/txValidatorPool")
).default.getInstance()
const domain = await import("./domain")
const votes = await import("./votes")
const { precommitUnderLock } = await import("./precommit")
const { readLockReply } = await import("./getLock")
const { chooseCandidates } = await import("./candidate")
const lockStore = await import("./lockStore")
type PrevoteState = import("./roundState").PrevoteState

const H = 10
const R1 = 5000
const R2 = 5010
// Every member's network clock: past each round the scenarios use
const NOW = 6000

interface Member {
    name: string
    signer: Signer
    file: string
    prevote: PrevoteState | null
    /** Votes this member received, by block and round. */
    prevotesSeen: Map<string, Record<string, string>>
}

const blocks = { X: makeBlock("X"), Xp: makeBlock("X'"), Y: makeBlock("Y"), Z: makeBlock("Z") }
const nonceOf = new Map(Object.entries(blocks).map(([k, b]) => [b.hash, k === "Xp" ? "X'" : k]))
const inputsOf = (hash: string) => ({
    previousHash: "hash-9",
    orderedTransactions: [`tx-of-${hash.slice(0, 8)}`],
    peerlist: ["p"],
    timestamp: 1500,
})

let dir: string
let committee: string[] = []
let A: Member, B: Member, C: Member, D: Member
let all: Member[] = []
let keys: Signer[] = []

function key(hash: string, round: number) {
    return `${round}:${hash}`
}

async function prevote(m: Member, round: number, hash: string): Promise<[string, string]> {
    m.prevote = { height: H, round, hash, inputs: inputsOf(hash), open: true }
    return [m.signer.identity, await m.signer.sign(domain.prevoteMessage(H, round, hash))]
}

/** Deliver prevotes to a member, as the proposeBlockHash exchange does. */
function deliver(m: Member, round: number, hash: string, ...sigs: [string, string][]) {
    const seen = m.prevotesSeen.get(key(hash, round)) ?? {}
    for (const [id, sig] of sigs) seen[id] = sig
    m.prevotesSeen.set(key(hash, round), seen)
}

/** The next attempt starts: the previous prevote can no longer be precommitted. */
function nextAttempt(m: Member) {
    if (m.prevote) m.prevote.open = false
}

/**
 * A precommit request reaching `m`, checked the way the precommitBlockHash
 * handler checks it, and decided by the member's own lock.
 */
async function askPrecommit(m: Member, round: number, hash: string, pol: unknown): Promise<string | null> {
    const verified = await votes.proofOfLock(H, round, hash, pol, committee)
    if (!verified) return null
    const outcome = await precommitUnderLock(
        { height: H, round, hash, pol: verified },
        {
            identityFile: m.file,
            genesisHash: "hash-0",
            production: false,
            now: NOW,
            prevote: m.prevote?.open ? m.prevote : null,
            sign: message => m.signer.sign(message),
        },
    )
    return "signature" in outcome ? outcome.signature : null
}

/** The lock `m` reports to a getLock query, as the asking member reads it. */
async function lockReport(m: Member) {
    const lock = lockStore.lockAt(m.file, "hash-0", H)
    const response = { result: 200, response: "", require_reply: false, extra: { lock } }
    return await readLockReply(response, H, committee, { identity: m.signer.identity }, NOW)
}

/** Step 1: the block `m` prevotes in its next attempt. */
async function candidateOf(m: Member, reports: Awaited<ReturnType<typeof lockReport>>[], fresh: string) {
    nextAttempt(m)
    const own = lockStore.lockAt(m.file, "hash-0", H)
    const options = chooseCandidates(own, reports.filter(r => r !== null))
    return options[0]?.hash ?? fresh
}

async function certifies(hash: string, round: number, signatures: Record<string, string>) {
    const block = makeBlock(nonceOf.get(hash) as string)
    block.validation_data = { signatures, round }
    return (await verifyBlock(block)).valid
}

beforeAll(async () => {
    keys = await Promise.all(["A", "B", "C", "D"].map((n, i) => makeSigner(`safety-${n}`, 70 + i)))
    await validatorPool.start(1)
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-commitlock-safety-"))
    chain.peerlist = keys.map(k => k.identity)
    __resetValidatorCache()
    committee = await getBoundCommittee(9)
    const member = (name: string, i: number): Member => ({
        name,
        signer: keys[i],
        file: path.join(dir, `${name}.identity`),
        prevote: null,
        prevotesSeen: new Map(),
    })
    ;[A, B, C, D] = ["A", "B", "C", "D"].map(member)
    all = [A, B, C, D]
})

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

async function roundOneCommitsXAtAOnly() {
    const X = blocks.X.hash
    const pv = await Promise.all(all.map(m => prevote(m, R1, X)))
    // A hears B and C; the others' proposal replies time out
    deliver(A, R1, X, pv[0], pv[1], pv[2])
    deliver(B, R1, X, pv[1])
    deliver(C, R1, X, pv[2])
    deliver(D, R1, X, pv[3])

    const polA = A.prevotesSeen.get(key(X, R1))
    for (const m of [B, C, D]) {
        expect(await votes.proofOfLock(H, R1, X, m.prevotesSeen.get(key(X, R1)), committee)).toBeNull()
    }

    const certificate: Record<string, string> = {}
    for (const m of [A, B, C]) {
        const sig = await askPrecommit(m, R1, X, polA)
        expect(sig).not.toBeNull()
        certificate[m.signer.identity] = sig as string
    }
    expect(await certifies(X, R1, certificate)).toBe(true)
    return certificate
}

describe("commit lock safety with a committee of four", () => {
    it("draws all four members into the bound committee (q = 3)", () => {
        expect([...committee].sort()).toEqual(keys.map(k => k.identity).sort())
        expect(votes.commitQuorum(committee.length)).toBe(3)
    })

    it("lets no certificate for another block form in round 2", async () => {
        const X = blocks.X.hash
        const Xp = blocks.Xp.hash
        await roundOneCommitsXAtAOnly()

        // A is cut off. B and C are locked on X; D is not, and is the
        // faulty member: it forges X' and signs whatever helps it.
        expect(lockStore.lockAt(B.file, "hash-0", H)?.hash).toBe(X)
        expect(lockStore.lockAt(C.file, "hash-0", H)?.hash).toBe(X)
        expect(lockStore.lockAt(D.file, "hash-0", H)).toBeNull()

        // Without any lock exchange, the locked members still prevote X
        expect(await candidateOf(B, [], blocks.Y.hash)).toBe(X)
        expect(await candidateOf(C, [], blocks.Z.hash)).toBe(X)
        const pvB = await prevote(B, R2, X)
        const pvC = await prevote(C, R2, X)
        nextAttempt(D)
        const pvD = await prevote(D, R2, Xp)

        // Everything the faulty member can assemble for X' in round 2
        const forgedPols: unknown[] = [
            Object.fromEntries([pvD]),
            Object.fromEntries([pvD, pvB, pvC]),
            { ...Object.fromEntries([pvD]), [A.signer.identity]: await A.signer.sign(domain.prevoteMessage(H, R1, Xp)) },
            { ...Object.fromEntries([pvD]), ...(await precommitPairs([B, C], R1, X)) },
        ]
        for (const pol of forgedPols) {
            expect(await votes.proofOfLock(H, R2, Xp, pol, committee)).toBeNull()
            for (const m of [B, C]) expect(await askPrecommit(m, R2, Xp, pol)).toBeNull()
        }

        // Even a proof of lock for X' made of real prevotes would not move
        // B: its open prevote is for X, and a move needs a later round.
        expect(await askPrecommit(B, R2, Xp, Object.fromEntries([pvD, pvB, pvC]))).toBeNull()
        expect(lockStore.lockAt(B.file, "hash-0", H)?.hash).toBe(X)

        // At most D's own precommit exists for X': no certificate
        const dOnly = { [D.signer.identity]: await D.signer.sign(domain.precommitMessage(H, R2, Xp)) }
        expect(await certifies(Xp, R2, dOnly)).toBe(false)
    })

    it("converges on X in round 2 once the locks are exchanged", async () => {
        const X = blocks.X.hash
        const certificateR1 = await roundOneCommitsXAtAOnly()

        // getLock from the reachable members; A is cut off
        const reports = await Promise.all([B, C, D].map(lockReport))
        expect(reports.filter(r => r !== null).map(r => [r?.hash, r?.round])).toEqual([
            [X, R1],
            [X, R1],
        ])

        expect(await candidateOf(B, reports, blocks.Y.hash)).toBe(X)
        expect(await candidateOf(C, reports, blocks.Z.hash)).toBe(X)
        expect(await candidateOf(D, reports, blocks.Xp.hash)).toBe(X)

        const pv = await Promise.all([B, C, D].map(m => prevote(m, R2, X)))
        const pol = Object.fromEntries(pv)
        const certificateR2: Record<string, string> = {}
        for (const m of [B, C, D]) {
            const sig = await askPrecommit(m, R2, X, pol)
            expect(sig).not.toBeNull()
            certificateR2[m.signer.identity] = sig as string
        }
        expect(await certifies(X, R2, certificateR2)).toBe(true)

        // Two certificates, one block: A's and the others' agree on X
        expect(await certifies(X, R1, certificateR1)).toBe(true)
        for (const m of [B, C, D]) {
            expect(lockStore.lockAt(m.file, "hash-0", H)).toMatchObject({ hash: X, round: R2 })
        }
    })

    it("does not let a lock report without a valid proof of lock steer a candidate", async () => {
        const Xp = blocks.Xp.hash
        // D claims a lock on X' in a late round, backed only by its own prevote
        lockStore.writeCommitLock(D.file, {
            genesisHash: "hash-0",
            height: H,
            hash: Xp,
            round: R2 + 100,
            pol: Object.fromEntries([await prevote(D, R2 + 100, Xp)]),
            inputs: inputsOf(Xp),
            lockedAt: 1,
        })
        expect(await lockReport(D)).toBeNull()
    })

    it("locks nobody in a round far ahead of the clock, so honest rounds still certify", async () => {
        // A faulty secretary greenlit a far-future round and gathered a full
        // proof of lock for X in it: a lock there would outrank every honest
        // round until the clocks caught up
        const X = blocks.X.hash
        const FAR = NOW + 3600
        const polFar = Object.fromEntries(await Promise.all(all.map(m => prevote(m, FAR, X))))
        expect(await votes.proofOfLock(H, FAR, X, polFar, committee)).not.toBeNull()
        for (const m of all) {
            expect(await askPrecommit(m, FAR, X, polFar)).toBeNull()
            expect(lockStore.lockAt(m.file, "hash-0", H)).toBeNull()
        }

        // Nor is such a lock followed when a member reports one
        lockStore.writeCommitLock(D.file, {
            genesisHash: "hash-0",
            height: H,
            hash: X,
            round: FAR,
            pol: polFar,
            inputs: inputsOf(X),
            lockedAt: 1,
        })
        expect(await lockReport(D)).toBeNull()

        // The next honest round goes through for any block
        const Y = blocks.Y.hash
        for (const m of all) nextAttempt(m)
        const polY = Object.fromEntries(await Promise.all([A, B, C].map(m => prevote(m, R2, Y))))
        const certificate: Record<string, string> = {}
        for (const m of [A, B, C]) {
            const sig = await askPrecommit(m, R2, Y, polY)
            expect(sig).not.toBeNull()
            certificate[m.signer.identity] = sig as string
        }
        expect(await certifies(Y, R2, certificate)).toBe(true)
    })

    it("locks nobody on a split round, so the retry forges fresh and completes", async () => {
        const X = blocks.X.hash
        const Y = blocks.Y.hash
        const pvX = await Promise.all([A, B].map(m => prevote(m, R1, X)))
        const pvY = await Promise.all([C, D].map(m => prevote(m, R1, Y)))
        expect(await votes.proofOfLock(H, R1, X, Object.fromEntries(pvX), committee)).toBeNull()
        expect(await votes.proofOfLock(H, R1, Y, Object.fromEntries(pvY), committee)).toBeNull()

        const reports = await Promise.all(all.map(lockReport))
        expect(reports.every(r => r === null)).toBe(true)
        const Z = blocks.Z.hash
        for (const m of all) expect(await candidateOf(m, reports, Z)).toBe(Z)

        const pol = Object.fromEntries(await Promise.all(all.map(m => prevote(m, R2, Z))))
        const certificate: Record<string, string> = {}
        for (const m of all) certificate[m.signer.identity] = (await askPrecommit(m, R2, Z, pol)) as string
        expect(await certifies(Z, R2, certificate)).toBe(true)
    })
})

async function precommitPairs(members: Member[], round: number, hash: string) {
    const out: Record<string, string> = {}
    for (const m of members) out[m.signer.identity] = await m.signer.sign(domain.precommitMessage(H, round, hash))
    return out
}
