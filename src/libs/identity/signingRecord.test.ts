import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const warning = jest.fn()
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning,
        error: jest.fn(),
    },
}))

import {
    checkBlockSignature,
    DoubleSignError,
    recordBlockSignature,
    loadSigningRecord,
    SigningRecordError,
    signingRecordPath,
} from "./signingRecord"

describe("signingRecord", () => {
    let dir: string
    let identity: string
    beforeEach(() => {
        warning.mockClear()
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-signed-"))
        identity = path.join(dir, ".demos_identity")
    })
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const GENESIS = "genesis-a"
    const round = (
        height: number,
        timestamp: number,
        hash: string,
        genesisHash = GENESIS,
    ) => ({
        genesisHash,
        height,
        timestamp,
        hash,
    })

    // The node's order: check, sign, record.
    const guardBlockSignature = (
        file: string,
        request: ReturnType<typeof round>,
    ) => {
        checkBlockSignature(file, request)
        recordBlockSignature(file, request)
    }

    it("reports no record for a fresh node and writes one on the first signature", () => {
        expect(loadSigningRecord(identity)).toBeNull()
        guardBlockSignature(identity, round(10, 1000, "aa"))
        const rec = loadSigningRecord(identity)
        expect(rec).toMatchObject({
            genesisHash: GENESIS,
            height: 10,
            timestamp: 1000,
            hash: "aa",
        })
        expect(typeof rec?.signedAt).toBe("number")
    })

    it("allows re-signing the identical round", () => {
        guardBlockSignature(identity, round(10, 1000, "aa"))
        expect(() =>
            guardBlockSignature(identity, round(10, 1000, "aa")),
        ).not.toThrow()
    })

    it("refuses a lower height", () => {
        guardBlockSignature(identity, round(10, 1000, "aa"))
        expect(() =>
            guardBlockSignature(identity, round(9, 2000, "bb")),
        ).toThrow(DoubleSignError)
        expect(loadSigningRecord(identity)?.height).toBe(10)
    })

    it("refuses the same height with an earlier timestamp", () => {
        guardBlockSignature(identity, round(10, 1000, "aa"))
        expect(() =>
            guardBlockSignature(identity, round(10, 999, "bb")),
        ).toThrow(DoubleSignError)
        expect(loadSigningRecord(identity)?.timestamp).toBe(1000)
    })

    it("refuses a different hash for the same round and names both", () => {
        guardBlockSignature(identity, round(10, 1000, "aa"))
        let message = ""
        try {
            guardBlockSignature(identity, round(10, 1000, "bb"))
        } catch (e) {
            expect(e).toBeInstanceOf(DoubleSignError)
            message = (e as Error).message
        }
        expect(message).toContain("hash aa")
        expect(message).toContain("hash bb")
        expect(message).toContain("height 10")
        expect(message).toContain("timestamp 1000")
        expect(message).toContain(signingRecordPath(identity))
        expect(message).toContain("only safe when the chain itself was reset")
        expect(loadSigningRecord(identity)?.hash).toBe("aa")
    })

    it("allows a retry at the same height with a later timestamp", () => {
        guardBlockSignature(identity, round(10, 1000, "aa"))
        guardBlockSignature(identity, round(10, 1005, "bb"))
        expect(loadSigningRecord(identity)).toMatchObject({
            height: 10,
            timestamp: 1005,
            hash: "bb",
        })
    })

    it("allows a higher height even with an earlier timestamp value", () => {
        guardBlockSignature(identity, round(10, 1000, "aa"))
        guardBlockSignature(identity, round(11, 1001, "cc"))
        expect(loadSigningRecord(identity)?.height).toBe(11)
    })

    it("treats a record from another chain as stale and re-binds it", () => {
        guardBlockSignature(identity, round(500, 9000, "old", "genesis-old"))
        guardBlockSignature(identity, round(3, 100, "new", "genesis-new"))
        expect(loadSigningRecord(identity)).toMatchObject({
            genesisHash: "genesis-new",
            height: 3,
            timestamp: 100,
            hash: "new",
        })
        const text = String(warning.mock.calls[0][0])
        expect(text).toContain("genesis-old")
        expect(text).toContain("genesis-new")
        expect(text).toContain(signingRecordPath(identity))
    })

    it("still refuses lower heights on the same chain after a re-bind", () => {
        guardBlockSignature(identity, round(500, 9000, "old", "genesis-old"))
        guardBlockSignature(identity, round(3, 100, "new", "genesis-new"))
        expect(() =>
            guardBlockSignature(identity, round(2, 200, "x", "genesis-new")),
        ).toThrow(DoubleSignError)
    })

    it("checking alone never writes a record", () => {
        checkBlockSignature(identity, round(10, 1000, "aa"))
        expect(fs.existsSync(signingRecordPath(identity))).toBe(false)
    })

    it("rejects a conflicting signature at record time too", () => {
        checkBlockSignature(identity, round(10, 1000, "aa"))
        checkBlockSignature(identity, round(10, 1000, "bb"))
        recordBlockSignature(identity, round(10, 1000, "aa"))
        expect(() =>
            recordBlockSignature(identity, round(10, 1000, "bb")),
        ).toThrow(DoubleSignError)
        expect(loadSigningRecord(identity)?.hash).toBe("aa")
    })

    it("refuses to sign when the record is malformed", () => {
        const file = signingRecordPath(identity)
        for (const bad of [
            "",
            "not json",
            "{}",
            '{"height":"x"}',
            "[]",
            '{"height":1,"timestamp":1,"hash":"a","signedAt":1}',
        ]) {
            fs.writeFileSync(file, bad)
            expect(() => loadSigningRecord(identity)).toThrow(
                SigningRecordError,
            )
            expect(() =>
                guardBlockSignature(identity, round(10, 1000, "aa")),
            ).toThrow(SigningRecordError)
            expect(fs.readFileSync(file, "utf8")).toBe(bad)
        }
    })

    it("refuses an invalid request", () => {
        expect(() =>
            guardBlockSignature(identity, round(1.5, 1000, "aa")),
        ).toThrow(DoubleSignError)
        expect(() =>
            guardBlockSignature(identity, round(1, Number.NaN, "aa")),
        ).toThrow(DoubleSignError)
        expect(() => guardBlockSignature(identity, round(1, 1, ""))).toThrow(
            DoubleSignError,
        )
        expect(() =>
            guardBlockSignature(identity, round(1, 1, "aa", "")),
        ).toThrow(DoubleSignError)
        expect(fs.existsSync(signingRecordPath(identity))).toBe(false)
    })

    it.skipIf(process.platform === "win32")(
        "writes the record with mode 600 and leaves no temp files",
        () => {
            guardBlockSignature(identity, round(10, 1000, "aa"))
            guardBlockSignature(identity, round(11, 1001, "bb"))
            expect(fs.statSync(signingRecordPath(identity)).mode & 0o777).toBe(
                0o600,
            )
            expect(fs.readdirSync(dir)).toEqual([".demos_identity.signed.json"])
        },
    )

    it("fails (and does not sign) when the record cannot be persisted", () => {
        const missing = path.join(dir, "no-such-dir", ".demos_identity")
        expect(() =>
            guardBlockSignature(missing, round(10, 1000, "aa")),
        ).toThrow(SigningRecordError)
    })

    it.skipIf(process.platform === "win32")(
        "writes through a symlinked record instead of replacing the link",
        () => {
            const state = path.join(dir, "state")
            fs.mkdirSync(state)
            fs.symlinkSync(
                path.join(state, ".demos_identity.signed.json"),
                signingRecordPath(identity),
            )
            guardBlockSignature(identity, round(10, 1000, "aa"))
            expect(
                fs.lstatSync(signingRecordPath(identity)).isSymbolicLink(),
            ).toBe(true)
            expect(
                fs.existsSync(path.join(state, ".demos_identity.signed.json")),
            ).toBe(true)
            expect(loadSigningRecord(identity)?.hash).toBe("aa")
        },
    )

    describe("cross-process record lock", () => {
        const lockPath = () => `${signingRecordPath(identity)}.lock`
        const holdLock = (holder: object) =>
            fs.writeFileSync(lockPath(), JSON.stringify(holder))

        it("refuses to write while another live process holds a fresh lock", () => {
            holdLock({
                pid: process.ppid,
                hostname: os.hostname(),
                at: Date.now(),
            })
            expect(() =>
                recordBlockSignature(identity, round(10, 1000, "aa")),
            ).toThrow(/another process is writing/)
            expect(fs.existsSync(signingRecordPath(identity))).toBe(false)
            expect(fs.existsSync(lockPath())).toBe(true)
        })

        it("refuses while a lock from another host is fresh", () => {
            holdLock({ pid: 1, hostname: "elsewhere", at: Date.now() })
            expect(() =>
                recordBlockSignature(identity, round(10, 1000, "aa")),
            ).toThrow(SigningRecordError)
        })

        it("replaces a lock whose pid is dead on this host", () => {
            holdLock({
                pid: 2 ** 22 - 1,
                hostname: os.hostname(),
                at: Date.now(),
            })
            recordBlockSignature(identity, round(10, 1000, "aa"))
            expect(loadSigningRecord(identity)?.hash).toBe("aa")
            expect(fs.existsSync(lockPath())).toBe(false)
        })

        it("replaces a lock left by our own pid", () => {
            holdLock({
                pid: process.pid,
                hostname: os.hostname(),
                at: Date.now(),
            })
            recordBlockSignature(identity, round(10, 1000, "aa"))
            expect(loadSigningRecord(identity)?.hash).toBe("aa")
        })

        it("replaces a lock older than the stale window, even from a live pid or another host", () => {
            holdLock({
                pid: process.ppid,
                hostname: os.hostname(),
                at: Date.now() - 60_000,
            })
            recordBlockSignature(identity, round(10, 1000, "aa"))
            holdLock({ pid: 1, hostname: "elsewhere", at: Date.now() - 60_000 })
            recordBlockSignature(identity, round(11, 1001, "bb"))
            expect(loadSigningRecord(identity)?.height).toBe(11)
        })

        it("replaces an unreadable lock once its file is old", () => {
            fs.writeFileSync(lockPath(), "garbage")
            const old = new Date(Date.now() - 60_000)
            fs.utimesSync(lockPath(), old, old)
            recordBlockSignature(identity, round(10, 1000, "aa"))
            expect(loadSigningRecord(identity)?.hash).toBe("aa")
        })

        it("releases the lock when the check under it refuses", () => {
            recordBlockSignature(identity, round(10, 1000, "aa"))
            expect(() =>
                recordBlockSignature(identity, round(10, 1000, "bb")),
            ).toThrow(DoubleSignError)
            expect(fs.existsSync(lockPath())).toBe(false)
        })
    })

    describe("directory sync", () => {
        afterEach(() => {
            jest.restoreAllMocks()
        })

        const failDirectoryFsync = (code: string) => {
            const real = fs.fsyncSync
            return jest.spyOn(fs, "fsyncSync").mockImplementation(fd => {
                if (fs.fstatSync(fd).isDirectory()) {
                    throw Object.assign(new Error(`${code}: sync failed`), {
                        code,
                    })
                }
                real(fd)
            })
        }

        it("fails when the directory cannot be synced for a real reason", () => {
            failDirectoryFsync("EIO")
            expect(() =>
                recordBlockSignature(identity, round(10, 1000, "aa")),
            ).toThrow(SigningRecordError)
            expect(fs.existsSync(`${signingRecordPath(identity)}.lock`)).toBe(
                false,
            )
        })

        it("tolerates filesystems that cannot sync directories", () => {
            failDirectoryFsync("EINVAL")
            recordBlockSignature(identity, round(10, 1000, "aa"))
            expect(loadSigningRecord(identity)?.hash).toBe("aa")
        })
    })
})
