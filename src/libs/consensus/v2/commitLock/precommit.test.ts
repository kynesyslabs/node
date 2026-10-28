/**
 * The node's own precommit, signed by a started TxValidatorPool: it is
 * given only for the block of the open prevote, only under the lock rule,
 * and only after the lock is durable. The precommitBlockHash handler and
 * the precommit exchange use real ed25519 for every other member.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
    type Signer,
    type StubChain,
    makeSigner,
    mockCommitteeChain,
} from "../../../../../testing/consensus/committeeTestKit"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 4,
    publicKeyHex: "",
    identityFile: "",
    PROD: false,
    lastBlockNumber: 9,
    lastBlockHash: "hash-9",
    genesisBlockHash: "hash-0",
    timestampCorrection: 0,
    forkConfig: {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
        commitLock: { activationHeight: 0 },
    },
    identity: { masterSeed: new Uint8Array(128).fill(7) },
}

const chain: StubChain = { peerlist: [], staked: null, tip: 9 }
mockCommitteeChain(sharedState, chain)

const peers = new Map<string, any>()
class StubPeerManager {
    static getInstance() {
        return new StubPeerManager()
    }
    getPeer(id: string) {
        return peers.get(id)
    }
    getOfflinePeers() {
        return {}
    }
}
jest.mock("src/libs/peer/PeerManager", () => ({ __esModule: true, default: StubPeerManager }))

const metrics = { locks: 0, moves: 0, equivocations: 0 }
jest.mock("@/features/metrics/consensusMetrics", () => ({
    countBlockHashMismatch: () => undefined,
    countConflictingBlock: () => undefined,
    countCommitLock: () => {
        metrics.locks++
    },
    countLockMoved: () => {
        metrics.moves++
    },
    countPrecommitEquivocation: () => {
        metrics.equivocations++
    },
    countMissedSignature: () => undefined,
    setForkScheduleMismatch: () => undefined,
    setConsensusAbstaining: () => undefined,
}))

const { getBoundCommittee, __resetValidatorCache } = await import("../routines/getShard")
const validatorPool = (
    await import("src/libs/blockchain/validation/txValidatorPool")
).default.getInstance()
const { loadSigningRecord } = await import("src/libs/identity/signingRecord")
const domain = await import("./domain")
const votes = await import("./votes")
const roundState = await import("./roundState")
const lockStore = await import("./lockStore")
const precommit = await import("./precommit")

const H = 10
const R1 = 5000
const R2 = 5010
const X = "a".repeat(64)
const Y = "b".repeat(64)
// A round an hour ahead of every clock, as a faulty secretary could stamp it
const farRound = () => Math.floor(Date.now() / 1000) + 3600
const inputs = {
    previousHash: "hash-9",
    orderedTransactions: ["t1"],
    peerlist: ["p"],
    timestamp: 1500,
}

let node: Signer
let others: Signer[] = []
let committee: string[] = []
let dir: string

async function prevotes(hash: string, round: number, by: Signer[]) {
    const out: Record<string, string> = {}
    for (const s of by) out[s.identity] = await s.sign(domain.prevoteMessage(H, round, hash))
    return out
}

async function precommitsOf(hash: string, round: number, by: Signer[]) {
    const out: Record<string, string> = {}
    for (const s of by) out[s.identity] = await s.sign(domain.precommitMessage(H, round, hash))
    return out
}

function openPrevote(hash: string, round: number) {
    roundState.recordPrevote({ height: H, round, hash, inputs })
}

beforeAll(async () => {
    await validatorPool.start(1)
    const nodeKey = await makeSigner("precommit-node", 7)
    node = {
        identity: nodeKey.identity,
        sign: async message => nodeKey.sign(message),
    }
    others = await Promise.all([1, 2, 3].map(i => makeSigner(`precommit-${i}`, 40 + i)))
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-precommit-"))
    sharedState.identityFile = path.join(dir, ".demos_identity")
    sharedState.publicKeyHex = node.identity
    sharedState.lastBlockNumber = 9
    sharedState.forkConfig.commitLock.activationHeight = 0
    metrics.locks = 0
    metrics.moves = 0
    metrics.equivocations = 0
    chain.peerlist = [node, ...others].map(s => s.identity)
    __resetValidatorCache()
    committee = await getBoundCommittee(9)
    roundState.__resetRoundState()
    precommit.__resetPrecommitState()
    votes.precommitBook.reset()
    peers.clear()
})

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("lockAndPrecommit", () => {
    it("draws a committee of the node and three others", () => {
        expect([...committee].sort()).toEqual([node, ...others].map(s => s.identity).sort())
    })

    it("refuses without an open prevote for that block and round", async () => {
        const pol = await prevotes(X, R1, others)
        expect("refused" in (await precommit.lockAndPrecommit({ height: H, round: R1, hash: X, pol }))).toBe(true)

        openPrevote(X, R1)
        expect("refused" in (await precommit.lockAndPrecommit({ height: H, round: R2, hash: X, pol }))).toBe(true)
        expect("refused" in (await precommit.lockAndPrecommit({ height: H, round: R1, hash: Y, pol }))).toBe(true)
        expect(lockStore.loadCommitLock(sharedState.identityFile)).toBeNull()
        expect(loadSigningRecord(sharedState.identityFile)).toBeNull()
    })

    it("refuses once the next attempt has closed the prevote", async () => {
        openPrevote(X, R1)
        await roundState.withLockMutex(() => roundState.closePrevotes())
        const pol = await prevotes(X, R1, others)
        expect("refused" in (await precommit.lockAndPrecommit({ height: H, round: R1, hash: X, pol }))).toBe(true)
    })

    it("locks durably, then signs a precommit that verifies, and records its round", async () => {
        openPrevote(X, R1)
        const pol = await prevotes(X, R1, others)
        const outcome = await precommit.lockAndPrecommit({ height: H, round: R1, hash: X, pol })
        if (!("signature" in outcome)) throw new Error(outcome.refused)

        const lock = lockStore.lockAt(sharedState.identityFile, "hash-0", H)
        expect(lock).toMatchObject({ hash: X, round: R1, pol, inputs })
        expect(loadSigningRecord(sharedState.identityFile)).toMatchObject({ height: H, timestamp: R1, hash: X })
        expect(metrics.locks).toBe(1)

        const signers = await votes.verifiedPrecommitters(H, R1, X, { [node.identity]: outcome.signature }, committee)
        expect([...signers]).toEqual([node.identity])

        // Asked again for the same block and round: the same precommit
        const again = await precommit.lockAndPrecommit({ height: H, round: R1, hash: X, pol })
        expect(again).toEqual(outcome)
        expect(metrics.locks).toBe(1)
    })

    it("does not sign when the lock cannot be written", async () => {
        fs.mkdirSync(lockStore.commitLockPath(sharedState.identityFile))
        openPrevote(X, R1)
        const outcome = await precommit.lockAndPrecommit({
            height: H,
            round: R1,
            hash: X,
            pol: await prevotes(X, R1, others),
        })
        expect("refused" in outcome).toBe(true)
        expect(loadSigningRecord(sharedState.identityFile)).toBeNull()
    })

    it("takes no lock and signs nothing in a round far ahead of the clock", async () => {
        const far = farRound()
        openPrevote(X, far)
        const outcome = await precommit.lockAndPrecommit({
            height: H,
            round: far,
            hash: X,
            pol: await prevotes(X, far, others),
        })
        expect("refused" in outcome && outcome.refused).toContain("ahead of our clock")
        expect(lockStore.loadCommitLock(sharedState.identityFile)).toBeNull()
        expect(loadSigningRecord(sharedState.identityFile)).toBeNull()
        expect(metrics.locks).toBe(0)
    })

    it("refuses when the record holds a precommit at the height but the lock file is gone", async () => {
        openPrevote(X, R1)
        await precommit.lockAndPrecommit({ height: H, round: R1, hash: X, pol: await prevotes(X, R1, others) })
        fs.rmSync(lockStore.commitLockPath(sharedState.identityFile))
        roundState.__resetRoundState()
        precommit.__resetPrecommitState()

        openPrevote(Y, R2)
        const outcome = await precommit.lockAndPrecommit({
            height: H,
            round: R2,
            hash: Y,
            pol: await prevotes(Y, R2, others),
        })
        expect("refused" in outcome && outcome.refused).toContain("lock file was lost")
        expect(lockStore.loadCommitLock(sharedState.identityFile)).toBeNull()
        expect(loadSigningRecord(sharedState.identityFile)).toMatchObject({ height: H, timestamp: R1, hash: X })

        // The next height is not held back by the lost lock
        sharedState.lastBlockNumber = H
        roundState.recordPrevote({ height: H + 1, round: R2, hash: Y, inputs })
        const next = await precommit.lockAndPrecommit({ height: H + 1, round: R2, hash: Y, pol: {} })
        expect("signature" in next).toBe(true)
    })

    it("refuses another block while locked, until a later proof of lock moves it", async () => {
        openPrevote(X, R1)
        await precommit.lockAndPrecommit({ height: H, round: R1, hash: X, pol: await prevotes(X, R1, others) })

        // A restart: nothing in memory, the lock on disk
        roundState.__resetRoundState()
        precommit.__resetPrecommitState()

        // A lock written at a later round than the prevote refuses it
        lockStore.writeCommitLock(sharedState.identityFile, {
            ...(lockStore.loadCommitLock(sharedState.identityFile) as any),
            round: R2,
        })
        openPrevote(Y, R1 + 5)
        const refused = await precommit.lockAndPrecommit({
            height: H,
            round: R1 + 5,
            hash: Y,
            pol: await prevotes(Y, R1 + 5, others),
        })
        expect("refused" in refused && refused.refused).toContain("locked on")

        openPrevote(Y, R2 + 10)
        const moved = await precommit.lockAndPrecommit({
            height: H,
            round: R2 + 10,
            hash: Y,
            pol: await prevotes(Y, R2 + 10, others),
        })
        expect("signature" in moved).toBe(true)
        expect(lockStore.lockAt(sharedState.identityFile, "hash-0", H)).toMatchObject({ hash: Y, round: R2 + 10 })
        expect(metrics.moves).toBe(1)
    })
})

describe("precommitBlockHash handler", () => {
    const call = (sender: string, params: unknown[]) => precommit.managePrecommitBlockHash(sender, params)

    it("refuses a sender outside the bound committee", async () => {
        const outsider = await makeSigner("precommit-outsider", 60)
        openPrevote(X, R1)
        const res = await call(outsider.identity, [X, R1, H, await prevotes(X, R1, others), {}])
        expect(res.result).toBe(401)
    })

    it("refuses a forged or insufficient proof of lock", async () => {
        openPrevote(X, R1)
        const forged = await prevotes(X, R1, others)
        const id = others[2].identity
        forged[id] = forged[id].slice(0, -2) + (forged[id].slice(-2) === "00" ? "01" : "00")
        expect((await call(others[0].identity, [X, R1, H, forged, {}])).result).toBe(400)
        expect((await call(others[0].identity, [X, R1, H, await prevotes(X, R2, others), {}])).result).toBe(400)
        expect(lockStore.loadCommitLock(sharedState.identityFile)).toBeNull()
    })

    it("refuses malformed, oversized or wrong-height requests", async () => {
        openPrevote(X, R1)
        const pol = await prevotes(X, R1, others)
        expect((await call(others[0].identity, [X, "r", H, pol, {}])).result).toBe(400)
        expect((await call(others[0].identity, [X, R1, H + 1, pol, {}])).result).toBe(409)
        const big = { ...pol }
        for (let i = 0; i < 5; i++) big[`junk-${i}`] = "00"
        expect((await call(others[0].identity, [X, R1, H, big, {}])).result).toBe(400)
    })

    it("precommits the open prevote's block and answers with every precommit it holds", async () => {
        openPrevote(X, R1)
        const pol = await prevotes(X, R1, others)
        const theirs = await precommitsOf(X, R1, [others[0]])
        const res = await call(others[0].identity, [X, R1, H, pol, theirs])
        expect(res.result).toBe(200)
        const answered = (res.extra as any).precommits
        expect(Object.keys(answered).sort()).toEqual([node.identity, others[0].identity].sort())
        const verified = await votes.verifiedPrecommitters(H, R1, X, answered, committee)
        expect(verified.size).toBe(2)
    })

    it("refuses a round far ahead of the clock before locking", async () => {
        const far = farRound()
        openPrevote(X, far)
        const res = await call(others[0].identity, [X, far, H, await prevotes(X, far, others), {}])
        expect(res.result).toBe(409)
        expect((res.extra as any).message).toBe("Round is ahead of our clock")
        expect(lockStore.loadCommitLock(sharedState.identityFile)).toBeNull()
        expect(loadSigningRecord(sharedState.identityFile)).toBeNull()
    })

    it("refuses an oversized block hash", async () => {
        openPrevote(X, R1)
        const res = await call(others[0].identity, ["a".repeat(200), R1, H, {}, {}])
        expect(res.result).toBe(400)
    })

    it("answers 409 when the lock rule refuses", async () => {
        openPrevote(X, R1)
        await call(others[0].identity, [X, R1, H, await prevotes(X, R1, others), {}])
        openPrevote(Y, R1)
        const res = await call(others[1].identity, [Y, R1, H, await prevotes(Y, R1, others), {}])
        expect(res.result).toBe(409)
    })
})

describe("precommit exchange", () => {
    it("gathers verified precommits into a one-round certificate and reports committed members", async () => {
        openPrevote(X, R1)
        const pol = await prevotes(X, R1, others)
        const own = await precommit.lockAndPrecommit({ height: H, round: R1, hash: X, pol })
        if (!("signature" in own)) throw new Error(own.refused)

        const [a, b, c] = others
        const sent: unknown[][] = []
        const reply = (extra: unknown, result = 200) => ({ result, response: "", require_reply: false, extra })
        peers.set(a.identity, {
            identity: a.identity,
            longCall: async (req: any) => {
                sent.push(req.params[0].params)
                return reply({ precommits: await precommitsOf(X, R1, [a]) })
            },
        })
        // A precommit for another round is not part of this certificate
        peers.set(b.identity, {
            identity: b.identity,
            longCall: async () => reply({ precommits: await precommitsOf(X, R2, [b]) }),
        })
        peers.set(c.identity, {
            identity: c.identity,
            longCall: async () =>
                reply(
                    { message: "Height already committed", committedBlock: { number: H, hash: X } },
                    410,
                ),
        })

        const tally = await precommit.broadcastPrecommit(
            { height: H, round: R1, hash: X, pol },
            own.signature,
            committee,
        )
        expect(Object.keys(tally.certificate).sort()).toEqual([node.identity, a.identity].sort())
        expect(tally.quorum).toBe(3)
        expect(tally.committed.map(r => r.peer.identity)).toEqual([c.identity])
        expect(sent[0]).toEqual([X, R1, H, pol, { [node.identity]: own.signature }])
    })
})
