/**
 * A height a member already committed is never built a second time by a
 * node that can reach that member: proposals for it are answered with the
 * block, a retry asks the failed round's members first, and a block pushed
 * or probed at a height we hold with a different hash is reported as a fork.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const state = {
    lastBlockNumber: 5,
    lastBlockHash: "h5",
    publicKeyHex: "self",
    inSyncLoop: false,
    fastSyncCount: 1,
}
let chain: Record<number, any> = {}
let verdicts: Record<string, { valid: boolean; reason?: string }> = {}
const synced: string[] = []
let syncOk = true
// Sources whose block bodies make syncBlock throw, as verifyBlockAttrs does
let throwingSources = new Set<string>()
// Sources whose apply fails and cannot be undone, which latches the drift
let latchingSources = new Set<string>()
let latchedDrift: number | null = null
const attempts: string[] = []
// Time each attempt takes, on a clock the test controls
let attemptCostMs = 0
let now = 1_000_000
const conflicts = jest.fn()
const credited: Array<[string, number]> = []
let knownPeers: Record<string, any> = {}
let offlinePeers: Record<string, any> = {}

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: state }))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: async (n: number) => chain[n] ?? null },
}))
jest.mock("src/libs/blockchain/validation/verifyBlock", () => ({
    verifyBlock: async (b: any) => verdicts[b.hash] ?? { valid: false, reason: "unknown" },
}))
jest.mock("src/libs/blockchain/routines/Sync", () => ({
    syncLock: { acquire: async () => () => undefined },
    unreconciledGcrBlockNumber: () => latchedDrift,
    // Like the real one: verify, then insert
    syncBlock: async (b: any, p: any) => {
        attempts.push(p?.identity)
        now += attemptCostMs
        if (latchingSources.has(p?.identity)) {
            latchedDrift = b.number
            throw new Error(`rollback of block ${b.number} failed`)
        }
        if (throwingSources.has(p?.identity)) {
            throw new Error(`transactions of ${b.hash} missing from ${p.identity}`)
        }
        if (!syncOk || !verdicts[b.hash]?.valid) return false
        synced.push(b.hash)
        chain[b.number] = b
        state.lastBlockNumber = b.number
        state.lastBlockHash = b.hash
        return true
    },
}))
jest.mock("src/features/metrics/consensusMetrics", () => ({
    countConflictingBlock: conflicts,
}))
jest.mock("src/libs/consensus/v2/routines/networkAheadVeto", () => ({
    creditVerifiedHeight: (peer: any, h: number) => credited.push([peer.identity, h]),
}))
jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            getPeer: (id: string) => knownPeers[id],
            getOfflinePeers: () => offlinePeers,
        }),
    },
}))

const {
    ADOPT_LOCK_BUDGET_MS,
    COMMITTED_HEIGHT_RESULT,
    adoptBeforeRetry,
    adoptBlockFromPeers,
    adoptCommittedBlock,
    committedHeightRefusal,
    fetchBlockAt,
    probeCommitteeForHeight,
    probePeerHeight,
    readCommittedRefusal,
    recordFailedRound,
    resetCommittedBlockState,
    scheduleHeightProbe,
} = await import("./committedBlock")

const block = (number: number, hash: string, previousHash: string): any => ({
    number,
    hash,
    content: { previousHash },
    validation_data: { signatures: {} },
})

/** A peer whose chain is `blocks`; getBlocks walks down from `start`. */
const peer = (identity: string, blocks: any[], delayMs = 0): any => ({
    identity,
    calls: 0,
    async call(req: any) {
        this.calls++
        if (delayMs) await new Promise(r => setTimeout(r, delayMs))
        const { start } = req.params[0].data
        const below = blocks
            .filter(b => b.number <= start)
            .sort((a, b) => b.number - a.number)
        return below.length > 0
            ? { result: 200, response: below.slice(0, 1) }
            : { result: 404, response: "error" }
    },
})

const b4 = block(4, "h4", "h3")
const b5 = block(5, "h5", "h4")
const x6 = block(6, "x6", "h5")
const y6 = block(6, "y6", "h5")

beforeEach(() => {
    state.lastBlockNumber = 5
    state.lastBlockHash = "h5"
    chain = { 4: b4, 5: b5 }
    verdicts = { x6: { valid: true }, y6: { valid: true } }
    synced.length = 0
    syncOk = true
    throwingSources = new Set()
    latchingSources = new Set()
    latchedDrift = null
    attempts.length = 0
    attemptCostMs = 0
    state.inSyncLoop = false
    state.fastSyncCount = 1
    conflicts.mockClear()
    credited.length = 0
    knownPeers = {}
    offlinePeers = {}
    resetCommittedBlockState()
})

describe("answering a proposal for a committed height", () => {
    it("refuses with the committed block for a height we hold", async () => {
        const res = await committedHeightRefusal(5)
        expect(res?.result).toBe(COMMITTED_HEIGHT_RESULT)
        expect(res?.response).toBe("self")
        expect((res?.extra as any).committedBlock).toEqual({ number: 5, hash: "h5" })
    })

    it("leaves open heights, and proposals without a height, to the vote", async () => {
        expect(await committedHeightRefusal(6)).toBeNull()
        expect(await committedHeightRefusal(undefined)).toBeNull()
        expect(await committedHeightRefusal("5")).toBeNull()
        expect(await committedHeightRefusal(4.5)).toBeNull()
    })

    it("reads the refusal on the proposer side only for its own height", async () => {
        const res = (await committedHeightRefusal(5))!
        expect(readCommittedRefusal(res, 5)).toBe("h5")
        expect(readCommittedRefusal(res, 6)).toBeNull()
        expect(readCommittedRefusal({ ...res, result: 401 }, 5)).toBeNull()
        expect(
            readCommittedRefusal({ ...res, extra: { committedBlock: { number: 5 } } }, 5),
        ).toBeNull()
    })
})

describe("fetching a member's block", () => {
    it("returns the block at exactly that height", async () => {
        expect((await fetchBlockAt(peer("a", [b5, x6]), 6))?.hash).toBe("x6")
    })

    it("does not mistake an older block for it when the member is below", async () => {
        expect(await fetchBlockAt(peer("a", [b4, b5]), 6)).toBeNull()
    })

    it("gives up on a slow member", async () => {
        expect(await fetchBlockAt(peer("slow", [x6], 200), 6, 20)).toBeNull()
    })
})

describe("adopting a committed block", () => {
    it("inserts a verified child of our head", async () => {
        expect(await adoptCommittedBlock(x6, peer("a", []))).toBe("adopted")
        expect(synced).toEqual(["x6"])
    })

    it("is a no-op for the block we already hold", async () => {
        chain[6] = x6
        state.lastBlockNumber = 6
        expect(await adoptCommittedBlock(x6, peer("a", []))).toBe("already-held")
        expect(synced).toEqual([])
    })

    it("reports, and never switches to, a second certified block at a held height", async () => {
        chain[6] = x6
        state.lastBlockNumber = 6
        expect(await adoptCommittedBlock(y6, peer("a", []))).toBe("conflict")
        expect(conflicts).toHaveBeenCalledTimes(1)
        expect(chain[6].hash).toBe("x6")
        // a repeat of the same pair is not counted twice
        await adoptCommittedBlock(y6, peer("b", []))
        expect(conflicts).toHaveBeenCalledTimes(1)
    })

    it("does not report a different block that fails verification", async () => {
        chain[6] = x6
        state.lastBlockNumber = 6
        verdicts.y6 = { valid: false, reason: "insufficient signatures" }
        expect(await adoptCommittedBlock(y6, peer("a", []))).toBe("rejected")
        expect(conflicts).not.toHaveBeenCalled()
    })

    it("rejects a block with transactions from an unknown sender instead of throwing", async () => {
        const withTxs = { ...x6, content: { ...x6.content, ordered_transactions: ["t1"] } }
        expect(await adoptCommittedBlock(withTxs, undefined)).toBe("rejected")
        expect(synced).toEqual([])
    })

    it("rejects a source whose bodies make the apply throw, without throwing itself", async () => {
        throwingSources = new Set(["a"])
        expect(await adoptCommittedBlock(x6, peer("a", []))).toBe("rejected")
        expect(synced).toEqual([])
    })

    it("does not apply next to the initial sync, which runs without the lock", async () => {
        state.inSyncLoop = true
        state.fastSyncCount = 0
        expect(await adoptCommittedBlock(x6, peer("a", []))).toBe("rejected")
        expect(synced).toEqual([])
    })

    it("does not apply before any sync succeeded, since the next one may start mid-apply", async () => {
        state.inSyncLoop = false
        state.fastSyncCount = 0
        expect(await adoptCommittedBlock(x6, peer("a", []))).toBe("rejected")
        expect(synced).toEqual([])
    })

    it("applies under the lock once syncs take it, even while one waits for it", async () => {
        state.inSyncLoop = true
        state.fastSyncCount = 3
        expect(await adoptCommittedBlock(x6, peer("a", []))).toBe("adopted")
        expect(synced).toEqual(["x6"])
    })

    it("rejects a block on another parent and one that is not next", async () => {
        expect(await adoptCommittedBlock(block(6, "z6", "other"), peer("a", []))).toBe(
            "rejected",
        )
        expect(await adoptCommittedBlock(block(8, "z8", "z7"), peer("a", []))).toBe(
            "not-next",
        )
        expect(synced).toEqual([])
    })
})

describe("check before retry", () => {
    it("adopts a block a member of the failed round committed, so no retry builds one", async () => {
        knownPeers = { a: peer("a", [b5, x6]), b: peer("b", [b5]), self: peer("self", [b5]) }
        recordFailedRound(6, ["self", "a", "b"])
        expect(await adoptBeforeRetry(6)).toBe(true)
        expect(synced).toEqual(["x6"])
        expect(knownPeers.self.calls).toBe(0)
    })

    it("still asks a member marked offline after its proposal reply timed out", async () => {
        const committer = peer("a", [b5, x6])
        knownPeers = { b: peer("b", [b5]) }
        offlinePeers = { a: committer }
        recordFailedRound(6, ["a", "b"])
        expect(await adoptBeforeRetry(6)).toBe(true)
        expect(committer.calls).toBe(1)
        expect(synced).toEqual(["x6"])
    })

    it("retries when no member holds the height, and asks only once", async () => {
        knownPeers = { a: peer("a", [b5]), b: peer("b", [b5]) }
        recordFailedRound(6, ["a", "b"])
        expect(await adoptBeforeRetry(6)).toBe(false)
        expect(await adoptBeforeRetry(6)).toBe(false)
        expect(knownPeers.a.calls).toBe(1)
    })

    it("does nothing for a height other than the failed one", async () => {
        knownPeers = { a: peer("a", [b5, x6]) }
        recordFailedRound(6, ["a"])
        expect(await adoptBeforeRetry(7)).toBe(false)
        expect(knownPeers.a.calls).toBe(0)
    })

    it("skips a variant that does not verify and takes one that does", async () => {
        verdicts.x6 = { valid: false, reason: "bad quorum" }
        const ok = await adoptBlockFromPeers(
            6,
            [peer("a", [x6]), peer("b", [y6]), peer("c", [x6])],
            "test",
        )
        expect(ok).toBe(true)
        expect(synced).toEqual(["y6"])
    })

    it("moves on to the next source when one throws mid-apply", async () => {
        throwingSources = new Set(["a"])
        const ok = await adoptBlockFromPeers(
            6,
            [peer("a", [x6]), peer("b", [x6])],
            "test",
        )
        expect(ok).toBe(true)
        expect(synced).toEqual(["x6"])
    })

    it("reports no block when every source throws", async () => {
        throwingSources = new Set(["a", "b"])
        const ok = await adoptBlockFromPeers(
            6,
            [peer("a", [x6]), peer("b", [x6])],
            "test",
        )
        expect(ok).toBe(false)
    })

    it("tries no further source once a failed apply could not be undone", async () => {
        latchingSources = new Set(["a"])
        const ok = await adoptBlockFromPeers(
            6,
            [peer("a", [x6]), peer("b", [x6])],
            "test",
        )
        expect(ok).toBe(false)
        expect(attempts).toEqual(["a"])
        expect(synced).toEqual([])
    })

    it("stops trying sources under the lock once its time budget is spent", async () => {
        throwingSources = new Set(["a", "b", "c"])
        attemptCostMs = ADOPT_LOCK_BUDGET_MS / 2
        const clock = jest.spyOn(Date, "now").mockImplementation(() => now)
        try {
            const ok = await adoptBlockFromPeers(
                6,
                [peer("a", [x6]), peer("b", [x6]), peer("c", [x6])],
                "test",
            )
            expect(ok).toBe(false)
            expect(attempts).toEqual(["a", "b"])
        } finally {
            clock.mockRestore()
        }
    })

    it("is not held up by an unreachable member", async () => {
        const started = Date.now()
        const ok = await adoptBlockFromPeers(
            6,
            [peer("dead", [x6], 500), peer("b", [b5])],
            "test",
            30,
        )
        expect(ok).toBe(false)
        expect(Date.now() - started).toBeLessThan(400)
    })
})

describe("peers reporting heights", () => {
    it("credits and adopts only verified blocks, never the bare claimed height", async () => {
        const ahead = peer("a", [b5, x6, block(7, "x7", "x6")])
        verdicts.x7 = { valid: true }
        expect(await probePeerHeight(ahead, 1_000_000)).toBe("credited")
        expect(credited).toEqual([
            ["a", 6],
            ["a", 7],
        ])
        expect(synced).toEqual(["x6", "x7"])
    })

    it("stops at the first block that does not verify, keeping what was verified", async () => {
        const ahead = peer("a", [b5, x6, block(7, "x7", "x6")])
        expect(await probePeerHeight(ahead, 9)).toBe("credited")
        expect(credited).toEqual([["a", 6]])
        expect(synced).toEqual(["x6"])
    })

    it("leaves the block to a running sync instead of applying it alongside", async () => {
        state.inSyncLoop = true
        expect(await probePeerHeight(peer("a", [b5, x6]), 6)).toBe("credited")
        expect(credited).toEqual([["a", 6]])
        expect(synced).toEqual([])
    })

    it("does not credit a claim whose next block does not verify", async () => {
        verdicts.x6 = { valid: false, reason: "insufficient signatures" }
        expect(await probePeerHeight(peer("a", [b5, x6]), 9)).toBe("none")
        expect(credited).toEqual([])
        expect(synced).toEqual([])
    })

    it("reports a fork when the peer's chain holds another certified block at our head", async () => {
        chain[6] = x6
        state.lastBlockNumber = 6
        state.lastBlockHash = "x6"
        const majority = peer("m", [b5, y6, block(7, "y7", "y6")])
        expect(await probePeerHeight(majority, 23)).toBe("conflict")
        expect(conflicts).toHaveBeenCalledTimes(1)
        expect(credited).toEqual([])
    })

    it("reports a fork for a claim at a held height with another hash", async () => {
        chain[6] = x6
        state.lastBlockNumber = 6
        state.lastBlockHash = "x6"
        expect(await probePeerHeight(peer("m", [b5, y6]), 6, "y6")).toBe("conflict")
        expect(await probePeerHeight(peer("m", [b5, x6]), 6, "x6")).toBe("none")
    })

    it("probes each peer at most once per window", async () => {
        const p = peer("a", [b5])
        scheduleHeightProbe(p, 9)
        scheduleHeightProbe(p, 10)
        scheduleHeightProbe({ ...p, identity: "self" }, 9)
        await new Promise(r => setTimeout(r, 10))
        expect(p.calls).toBe(1)
    })
})

describe("a round short of its bound committee", () => {
    it("asks each online member it could not count for the block, and adopts it once verified", async () => {
        const signer = peer("a", [b5, x6])
        const level = peer("c", [b5])
        knownPeers = { a: signer, c: level }
        // b is offline, c counted live, self is us
        probeCommitteeForHeight(6, ["self", "a", "b", "c"], [
            { identity: "self" } as any,
            { identity: "C" } as any,
        ])
        await new Promise(r => setTimeout(r, 10))
        expect(signer.calls).toBe(1)
        expect(level.calls).toBe(0)
        expect(credited).toEqual([["a", 6]])
        expect(synced).toEqual(["x6"])
    })

    it("adopts nothing a member cannot back with a verified block", async () => {
        verdicts.x6 = { valid: false, reason: "insufficient signatures" }
        const signer = peer("a", [b5, x6])
        knownPeers = { a: signer }
        probeCommitteeForHeight(6, ["self", "a"], [{ identity: "self" } as any])
        await new Promise(r => setTimeout(r, 10))
        expect(signer.calls).toBe(1)
        expect(credited).toEqual([])
        expect(synced).toEqual([])
    })

    it("asks a member at most once per window across failed rounds", async () => {
        const behind = peer("a", [b5])
        knownPeers = { a: behind }
        for (let round = 0; round < 5; round++) {
            probeCommitteeForHeight(6, ["self", "a"], [{ identity: "self" } as any])
        }
        await new Promise(r => setTimeout(r, 10))
        expect(behind.calls).toBe(1)
    })
})
