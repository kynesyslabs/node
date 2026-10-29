/**
 * The commit lock on disk and the lock rule: the lock survives a restart,
 * binds only its own chain and height, is never read as absent when it is
 * damaged, and moves only on a proof of lock from a later round.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

const {
    CommitLockError,
    commitLockPath,
    judgeLock,
    loadCommitLock,
    lockAt,
    writeCommitLock,
} = await import("./lockStore")
const { signingRecordPath } = await import("src/libs/identity/signingRecord")

type Lock = Parameters<typeof writeCommitLock>[1]

let dir: string
let identityFile: string

function lock(overrides: Partial<Lock> = {}): Lock {
    return {
        genesisHash: "genesis-a",
        height: 10,
        hash: "x",
        round: 5000,
        pol: { a: "01", b: "02", c: "03" },
        inputs: {
            previousHash: "hash-9",
            orderedTransactions: ["t1", "t2"],
            peerlist: ["a", "b", "c", "d"],
            timestamp: 1500,
        },
        lockedAt: 1,
        ...overrides,
    }
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-commitlock-"))
    identityFile = path.join(dir, ".demos_identity")
})

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("lock store", () => {
    it("lives next to the signing record", () => {
        const record = signingRecordPath(identityFile)
        expect(path.dirname(commitLockPath(identityFile))).toBe(path.dirname(record))
        expect(commitLockPath(identityFile).endsWith(".commitlock.json")).toBe(true)
    })

    it("follows a symlinked signing record onto its volume", () => {
        const volume = fs.mkdtempSync(path.join(os.tmpdir(), "demos-commitlock-vol-"))
        try {
            const target = path.join(volume, "node.signed.json")
            fs.symlinkSync(target, signingRecordPath(identityFile))
            expect(commitLockPath(identityFile)).toBe(path.join(volume, "node.commitlock.json"))
        } finally {
            fs.rmSync(volume, { recursive: true, force: true })
        }
    })

    it("reads back what it wrote, as a later process would", () => {
        writeCommitLock(identityFile, lock())
        const raw = JSON.parse(fs.readFileSync(commitLockPath(identityFile), "utf8"))
        expect(raw).toEqual(lock())
        expect(loadCommitLock(identityFile)).toEqual(lock())
        expect(fs.readdirSync(path.dirname(commitLockPath(identityFile))).filter(f => f.endsWith(".tmp"))).toEqual([])
    })

    it("is absent only when no lock was ever written", () => {
        expect(loadCommitLock(identityFile)).toBeNull()
        expect(lockAt(identityFile, "genesis-a", 10)).toBeNull()
    })

    it("binds only its own chain and height", () => {
        writeCommitLock(identityFile, lock())
        expect(lockAt(identityFile, "genesis-a", 10)?.hash).toBe("x")
        expect(lockAt(identityFile, "genesis-b", 10)).toBeNull()
        expect(lockAt(identityFile, "genesis-a", 11)).toBeNull()
    })

    it("refuses to read a damaged lock as absent", () => {
        fs.writeFileSync(commitLockPath(identityFile), "{not json")
        expect(() => loadCommitLock(identityFile)).toThrow(CommitLockError)
        fs.writeFileSync(commitLockPath(identityFile), JSON.stringify({ ...lock(), round: 0 }))
        expect(() => lockAt(identityFile, "genesis-a", 10)).toThrow(CommitLockError)
    })

    it("refuses to write a malformed lock", () => {
        expect(() => writeCommitLock(identityFile, lock({ hash: "" }))).toThrow(CommitLockError)
        expect(() => writeCommitLock(identityFile, lock({ pol: { a: 1 } as any }))).toThrow(CommitLockError)
        expect(fs.existsSync(commitLockPath(identityFile))).toBe(false)
    })
})

describe("lock rule", () => {
    const req = (hash: string, round: number, height = 10, genesisHash = "genesis-a") => ({
        genesisHash,
        height,
        hash,
        round,
    })
    const current = lock({ hash: "x", round: 5000 })

    it("locks when nothing binds the height", () => {
        expect(judgeLock(null, req("x", 5000)).action).toBe("lock")
        expect(judgeLock(lock({ height: 9 }), req("y", 1)).action).toBe("lock")
        expect(judgeLock(current, req("y", 1, 10, "genesis-b")).action).toBe("lock")
    })

    it("keeps or advances a lock on the same block, never backwards", () => {
        expect(judgeLock(current, req("x", 5000)).action).toBe("keep")
        expect(judgeLock(current, req("x", 5010)).action).toBe("relock")
        expect(judgeLock(current, req("x", 4990)).action).toBe("refuse")
    })

    it("refuses another block in the lock's round or an earlier one", () => {
        expect(judgeLock(current, req("y", 5000)).action).toBe("refuse")
        expect(judgeLock(current, req("y", 4990)).action).toBe("refuse")
    })

    it("moves only on a proof of lock from a later round", () => {
        const decision = judgeLock(current, req("y", 5010))
        expect(decision.action).toBe("move")
        expect(decision.action === "move" && decision.from.hash).toBe("x")
    })

    it("refuses a height below the lock", () => {
        expect(judgeLock(lock({ height: 11 }), req("x", 9999)).action).toBe("refuse")
    })
})
