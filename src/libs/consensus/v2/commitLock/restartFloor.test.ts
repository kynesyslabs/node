/**
 * A restarted validator whose signing state files no longer show everything
 * the earlier run signed: an older but consistent backup of all three, or a
 * prevote record lost while the signing record survived. The files agree
 * with each other, so the gates that read them allow rounds the earlier run
 * already signed in. The restart floor, set at boot from the calibrated
 * clock, keeps every such round closed.
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

const signing = await import("src/libs/identity/signingRecord")
const { CommitLockError, commitLockPath, writeCommitLock } = await import("./lockStore")
const { loadPrevoteRecord, prevoteRecordPath, recordPrevoteRound } = await import("./prevoteRecord")
const { armRestartSigningFloor } = await import("./restartFloor")
const { COSIGN_TIMESTAMP_MAX_LEAD_SECONDS: LEAD } = await import("../routines/cosignTimestamp")

const GENESIS = "hash-0"
// The network clock of the earlier run when it last signed, and of the
// restarted process when it calibrates
const LAST_SIGNED_AT = 1_800_000_000
const BOOT_NOW = LAST_SIGNED_AT + 20

let dir: string
let identityFile: string

interface Vote {
    height: number
    round: number
    hash: string
}

function precommit(v: Vote): void {
    writeCommitLock(identityFile, {
        genesisHash: GENESIS,
        height: v.height,
        hash: v.hash,
        round: v.round,
        pol: { a: "01", b: "02", c: "03" },
        inputs: {
            previousHash: `prev-of-${v.hash}`,
            orderedTransactions: [],
            peerlist: ["a", "b", "c", "d"],
            timestamp: v.round,
        },
        lockedAt: 1,
    })
    signing.recordBlockSignature(identityFile, {
        genesisHash: GENESIS,
        height: v.height,
        timestamp: v.round,
        hash: v.hash,
    })
}

function prevote(v: Vote): void {
    recordPrevoteRound(identityFile, { genesisHash: GENESIS, ...v })
}

const stateFiles = () => [
    signing.signingRecordPath(identityFile),
    commitLockPath(identityFile),
    prevoteRecordPath(identityFile),
]

function backup(): Map<string, string> {
    return new Map(stateFiles().map(f => [f, fs.readFileSync(f, "utf8")]))
}

function restore(copy: Map<string, string>): void {
    for (const [f, body] of copy) fs.writeFileSync(f, body)
}

/** What the gates see for a block signature or precommit in `v`. */
function blockSignature(v: Vote) {
    return () =>
        signing.checkBlockSignature(identityFile, {
            genesisHash: GENESIS,
            height: v.height,
            timestamp: v.round,
            hash: v.hash,
        })
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-restart-floor-"))
    identityFile = path.join(dir, ".demos_identity")
    signing.__resetSigningHalt()
})

afterEach(() => {
    signing.__resetSigningHalt()
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("state files restored from an older backup", () => {
    // Backed up after height 10, then X precommitted at height 11
    const backedUp = { height: 10, round: LAST_SIGNED_AT - 100, hash: "block-10" }
    const signedX = { height: 11, round: LAST_SIGNED_AT, hash: "block-11-x" }
    // What a secretary can then ask for: Y at height 11 in an earlier round
    const conflictY = { height: 11, round: LAST_SIGNED_AT - 10, hash: "block-11-y" }

    function signThenRestoreOlderCopy(): void {
        prevote(backedUp)
        precommit(backedUp)
        const copy = backup()
        prevote(signedX)
        precommit(signedX)
        restore(copy)
    }

    it("the files alone refuse the conflict when they are current", () => {
        prevote(signedX)
        precommit(signedX)
        expect(blockSignature(conflictY)).toThrow(signing.DoubleSignError)
        expect(() => prevote(conflictY)).toThrow(CommitLockError)
    })

    it("refuses at every gate each round the earlier run can have signed", () => {
        signThenRestoreOlderCopy()
        const floor = armRestartSigningFloor(identityFile, BOOT_NOW)
        expect(floor).toBe(BOOT_NOW + LEAD)

        for (const round of [conflictY.round, signedX.round, BOOT_NOW, BOOT_NOW + LEAD]) {
            const v = { ...conflictY, round }
            expect(blockSignature(v)).toThrow(signing.DoubleSignError)
            expect(() =>
                signing.recordBlockSignature(identityFile, {
                    genesisHash: GENESIS,
                    height: v.height,
                    timestamp: v.round,
                    hash: v.hash,
                }),
            ).toThrow(signing.DoubleSignError)
            expect(() => prevote(v)).toThrow(CommitLockError)
        }
        // The refused votes left the restored files as they were
        expect(signing.loadSigningRecord(identityFile)?.height).toBe(backedUp.height)
        expect(loadPrevoteRecord(identityFile)?.height).toBe(backedUp.height)
    })

    it("signs a round after the floor, so the height can still complete", () => {
        signThenRestoreOlderCopy()
        const floor = armRestartSigningFloor(identityFile, BOOT_NOW)
        const later = { ...conflictY, round: floor + 1 }
        expect(() => prevote(later)).not.toThrow()
        expect(() => precommit(later)).not.toThrow()
        expect(signing.loadSigningRecord(identityFile)).toMatchObject({
            height: later.height,
            timestamp: later.round,
        })
    })
})

describe("a prevote record lost while the signing record survives", () => {
    // Precommitted X in round p, then prevoted Z in a later round q at the
    // same height; the prevote record is then lost
    const p = LAST_SIGNED_AT - 30
    const q = LAST_SIGNED_AT
    const precommittedX = { height: 11, round: p, hash: "block-11-x" }
    const prevotedZ = { height: 11, round: q, hash: "block-11-z" }
    const otherInQ = { height: 11, round: q, hash: "block-11-w" }

    function prevoteZThenLoseRecord(): void {
        prevote(precommittedX)
        precommit(precommittedX)
        prevote(prevotedZ)
        fs.rmSync(prevoteRecordPath(identityFile))
    }

    it("refuses a second block in the prevoted round after a restart", () => {
        prevoteZThenLoseRecord()
        armRestartSigningFloor(identityFile, BOOT_NOW)
        expect(() => prevote(otherInQ)).toThrow(CommitLockError)
        expect(() => prevote(prevotedZ)).toThrow(CommitLockError)
        expect(fs.existsSync(prevoteRecordPath(identityFile))).toBe(false)
    })
})

describe("the floor itself", () => {
    it("refuses every round from process start until it is set", () => {
        signing.holdSigningUntilRestartFloor()
        const v = { height: 11, round: BOOT_NOW + 1000, hash: "block-11-x" }
        expect(blockSignature(v)).toThrow(/not set yet/)
        expect(() => prevote(v)).toThrow(/not set yet/)

        armRestartSigningFloor(identityFile, BOOT_NOW)
        expect(blockSignature(v)).not.toThrow()
        expect(() => prevote(v)).not.toThrow()
    })

    it("rises to the highest round in the files when the clock reads earlier", () => {
        // Written by a run whose clock was ahead of this one
        const ahead = BOOT_NOW + 60
        prevote({ height: 11, round: ahead, hash: "block-11-x" })
        expect(armRestartSigningFloor(identityFile, BOOT_NOW)).toBe(ahead)
        expect(() =>
            prevote({ height: 12, round: ahead, hash: "block-12-y" }),
        ).toThrow(CommitLockError)
        expect(() =>
            prevote({ height: 12, round: ahead + 1, hash: "block-12-y" }),
        ).not.toThrow()
    })

    it("keeps signing held when the clock reading is not a number", () => {
        signing.holdSigningUntilRestartFloor()
        expect(() => armRestartSigningFloor(identityFile, Number.NaN)).toThrow(
            /invalid restart signing floor/,
        )
        const v = { height: 11, round: BOOT_NOW + 1000, hash: "block-11-x" }
        expect(blockSignature(v)).toThrow(/not set yet/)
    })

    it("skips a file it cannot read, which the gates still refuse on", () => {
        fs.writeFileSync(commitLockPath(identityFile), "{")
        expect(armRestartSigningFloor(identityFile, BOOT_NOW)).toBe(BOOT_NOW + LEAD)
        expect(() =>
            prevote({ height: 11, round: BOOT_NOW + LEAD + 1, hash: "block-11-x" }),
        ).toThrow(CommitLockError)
    })
})
