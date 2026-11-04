import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// A member whose commit-lock file is gone still precommitted at the height,
// as its signing record shows. It must not prevote a fresh block there:
// that prevote would contradict the lock it lost.

const HEIGHT = 10
const GENESIS = "hash-0"
const PARENT = "hash-9"
const RECORD_ROUND = 5000

const fetched = { locks: [] as unknown[], asked: 0 }
const realGetLock = await import("src/libs/consensus/v2/commitLock/getLock")
mock.module("src/libs/consensus/v2/commitLock/getLock", () => ({
    ...realGetLock,
    fetchLocks: async () => {
        fetched.asked++
        return { locks: fetched.locks, committed: [] }
    },
}))

const created: (string | undefined)[] = []
const realCreateBlock = await import("src/libs/consensus/v2/routines/createBlock")
mock.module("src/libs/consensus/v2/routines/createBlock", () => ({
    ...realCreateBlock,
    createBlock: async (
        _txs: unknown,
        _seed: string,
        _previous: string,
        number: number,
        _peerlist: string[],
        timestamp: number,
        options: { expectedHash?: string } = {},
    ) => {
        created.push(options.expectedHash)
        return {
            number,
            hash: options.expectedHash ?? "fresh",
            content: { timestamp },
        }
    },
}))

mock.module("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({
        commonValidatorSeed: "seed",
        lastBlockNumber: HEIGHT - 1,
    }),
}))

const { default: Chain } = await import("src/libs/blockchain/chain")
const { default: GCR } = await import("src/libs/blockchain/gcr/gcr")
const { default: SecretaryManager, AbortConsensusError } = await import(
    "src/libs/consensus/v2/types/secretaryManager"
)
const { getSharedState } = await import("src/utilities/sharedState")
const { forgeLockedCandidate } = await import("src/libs/consensus/v2/PoRBFT")
const { recordBlockSignature, signingRecordPath } = await import(
    "src/libs/identity/signingRecord"
)
const { __resetRoundState } = await import(
    "src/libs/consensus/v2/commitLock/roundState"
)

spyOn(Chain, "getLastBlockHash").mockResolvedValue(PARENT)
spyOn(GCR, "getAccountNonces").mockResolvedValue({})
spyOn(SecretaryManager, "getInstance").mockReturnValue({
    shard: { blockRef: HEIGHT },
    ourValidatorPhase: { currentPhase: 0 },
} as unknown as InstanceType<typeof SecretaryManager>)

const COMMITTEE = ["self", "a", "b", "c"]
let dir: string

function recordPrecommit(height: number, hash: string, genesisHash = GENESIS) {
    recordBlockSignature(getSharedState.identityFile, {
        genesisHash,
        height,
        timestamp: RECORD_ROUND,
        hash,
    })
}

function reportedLock(hash: string, round: number, source: string) {
    return {
        hash,
        round,
        pol: {},
        inputs: {
            previousHash: PARENT,
            orderedTransactions: [],
            peerlist: COMMITTEE,
            timestamp: round,
        },
        source,
    }
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-lost-lock-"))
    getSharedState.identityFile = path.join(dir, ".demos_identity")
    getSharedState.genesisBlockHash = GENESIS
    getSharedState.lastBlockNumber = HEIGHT - 1
    getSharedState.lastBlockHash = PARENT
    fetched.locks = []
    fetched.asked = 0
    created.length = 0
    __resetRoundState()
})

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("forging after the commit-lock file was lost", () => {
    it("aborts a first attempt instead of prevoting a fresh block", async () => {
        recordPrecommit(HEIGHT, "x")
        await expect(
            forgeLockedCandidate(HEIGHT, false, RECORD_ROUND + 10, COMMITTEE),
        ).rejects.toBeInstanceOf(AbortConsensusError)
        expect(fetched.asked).toBe(1)
        expect(created).toEqual([])
    })

    it("aborts a retry the same way", async () => {
        recordPrecommit(HEIGHT, "x")
        await expect(
            forgeLockedCandidate(HEIGHT, true, RECORD_ROUND + 10, COMMITTEE),
        ).rejects.toBeInstanceOf(AbortConsensusError)
        expect(created).toEqual([])
    })

    it("rebuilds and prevotes the recorded block a member reports", async () => {
        recordPrecommit(HEIGHT, "x")
        fetched.locks = [reportedLock("x", RECORD_ROUND, "a")]
        const candidate = await forgeLockedCandidate(
            HEIGHT,
            false,
            RECORD_ROUND + 10,
            COMMITTEE,
        )
        expect(candidate?.block.hash).toBe("x")
        expect(created).toEqual(["x"])
    })

    it("does not take another block whose proof of lock is not above the recorded round", async () => {
        recordPrecommit(HEIGHT, "x")
        fetched.locks = [
            reportedLock("y", RECORD_ROUND, "a"),
            reportedLock("z", RECORD_ROUND - 10, "b"),
        ]
        await expect(
            forgeLockedCandidate(HEIGHT, true, RECORD_ROUND + 10, COMMITTEE),
        ).rejects.toBeInstanceOf(AbortConsensusError)
        expect(created).toEqual([])
    })

    it("takes another block on a proof of lock above the recorded round", async () => {
        recordPrecommit(HEIGHT, "x")
        fetched.locks = [reportedLock("y", RECORD_ROUND + 5, "a")]
        const candidate = await forgeLockedCandidate(
            HEIGHT,
            true,
            RECORD_ROUND + 10,
            COMMITTEE,
        )
        expect(candidate?.block.hash).toBe("y")
        expect(created).toEqual(["y"])
    })

    it("aborts when the record cannot be read", async () => {
        fs.writeFileSync(signingRecordPath(getSharedState.identityFile), "{")
        await expect(
            forgeLockedCandidate(HEIGHT, false, RECORD_ROUND + 10, COMMITTEE),
        ).rejects.toBeInstanceOf(AbortConsensusError)
        expect(created).toEqual([])
    })

    it("still forges fresh when the record is from the previous height", async () => {
        recordPrecommit(HEIGHT - 1, "x")
        const candidate = await forgeLockedCandidate(
            HEIGHT,
            false,
            RECORD_ROUND + 10,
            COMMITTEE,
        )
        expect(candidate).toBeNull()
        expect(fetched.asked).toBe(0)
    })

    it("ignores a record of another chain", async () => {
        recordPrecommit(HEIGHT, "x", "other-genesis")
        const candidate = await forgeLockedCandidate(
            HEIGHT,
            false,
            RECORD_ROUND + 10,
            COMMITTEE,
        )
        expect(candidate).toBeNull()
    })
})
