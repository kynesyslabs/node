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
    __resetSigningHalt,
    cachedSigningRecord,
    checkBlockSignature,
    currentSigningRecord,
    DoubleSignError,
    haltSigning,
    reportSigningHaltMarker,
    setSigningLeaseCheck,
    signedByThisProcess,
    signingHaltMarkerPath,
    signingHaltReason,
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

    describe("another genesis in production", () => {
        const production = { production: true }
        const savedEnv = process.env.DEMOS_SIGNING_RECORD_REBIND
        beforeEach(() => {
            delete process.env.DEMOS_SIGNING_RECORD_REBIND
        })
        afterEach(() => {
            if (savedEnv === undefined) {
                delete process.env.DEMOS_SIGNING_RECORD_REBIND
            } else {
                process.env.DEMOS_SIGNING_RECORD_REBIND = savedEnv
            }
        })

        it("refuses before signing and keeps the old record", () => {
            guardBlockSignature(identity, round(500, 9000, "old", "genesis-old"))
            let message = ""
            try {
                checkBlockSignature(
                    identity,
                    round(3, 100, "new", "genesis-new"),
                    production,
                )
            } catch (e) {
                expect(e).toBeInstanceOf(DoubleSignError)
                message = (e as Error).message
            }
            expect(message).toContain("genesis-old")
            expect(message).toContain("genesis-new")
            expect(message).toContain("DEMOS_SIGNING_RECORD_REBIND")
            expect(() =>
                recordBlockSignature(
                    identity,
                    round(3, 100, "new", "genesis-new"),
                    production,
                ),
            ).toThrow(DoubleSignError)
            expect(loadSigningRecord(identity)?.genesisHash).toBe(
                "genesis-old",
            )
        })

        it("re-binds when DEMOS_SIGNING_RECORD_REBIND=true", () => {
            process.env.DEMOS_SIGNING_RECORD_REBIND = "true"
            guardBlockSignature(identity, round(500, 9000, "old", "genesis-old"))
            checkBlockSignature(
                identity,
                round(3, 100, "new", "genesis-new"),
                production,
            )
            recordBlockSignature(
                identity,
                round(3, 100, "new", "genesis-new"),
                production,
            )
            expect(loadSigningRecord(identity)?.genesisHash).toBe(
                "genesis-new",
            )
            expect(warning).toHaveBeenCalled()
        })

        it("still accepts the same chain", () => {
            guardBlockSignature(identity, round(10, 1000, "aa"))
            expect(() =>
                checkBlockSignature(identity, round(11, 1010, "bb"), production),
            ).not.toThrow()
        })
    })

    describe("halted signing", () => {
        afterEach(() => __resetSigningHalt())

        it("keeps refusing after a restart while the marker exists", () => {
            guardBlockSignature(identity, round(10, 1000, "aa"))
            haltSigning("key seen elsewhere", identity)
            expect(fs.existsSync(signingHaltMarkerPath(identity))).toBe(true)
            // A restart forgets the in-memory stop; the marker does not.
            __resetSigningHalt()
            let message = ""
            try {
                checkBlockSignature(identity, round(11, 2000, "bb"))
            } catch (e) {
                expect(e).toBeInstanceOf(DoubleSignError)
                message = (e as Error).message
            }
            expect(message).toContain(signingHaltMarkerPath(identity))
            expect(message).toContain("key seen elsewhere")
            expect(message).toContain("single copy")
            expect(reportSigningHaltMarker(identity)).toBe(true)
            fs.rmSync(signingHaltMarkerPath(identity))
            expect(reportSigningHaltMarker(identity)).toBe(false)
            expect(() =>
                guardBlockSignature(identity, round(11, 2000, "bb")),
            ).not.toThrow()
        })

        it("puts the marker next to the real record behind a symlink", () => {
            const state = path.join(dir, "state")
            fs.mkdirSync(state)
            fs.symlinkSync(
                path.join(state, ".demos_identity.signed.json"),
                signingRecordPath(identity),
            )
            haltSigning("x", identity)
            expect(
                fs.existsSync(
                    path.join(state, ".demos_identity.signed.json.halted"),
                ),
            ).toBe(true)
        })

        it("writes the marker durably: synced file renamed into place, then the directory synced", () => {
            const marker = signingHaltMarkerPath(identity)
            const steps: string[] = []
            const realFsync = fs.fsyncSync
            const realRename = fs.renameSync
            jest.spyOn(fs, "fsyncSync").mockImplementation(fd => {
                steps.push(
                    fs.fstatSync(fd).isDirectory() ? "fsync dir" : "fsync file",
                )
                realFsync(fd)
            })
            jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
                if (to === marker) steps.push("rename")
                realRename(from, to)
            })
            try {
                haltSigning("key seen elsewhere", identity)
            } finally {
                jest.restoreAllMocks()
            }
            expect(steps).toEqual(["fsync file", "rename", "fsync dir"])
            expect(JSON.parse(fs.readFileSync(marker, "utf8")).reason).toBe(
                "key seen elsewhere",
            )
            expect(fs.statSync(marker).mode & 0o777).toBe(0o600)
            const leftovers = fs
                .readdirSync(dir)
                .filter(f => f.endsWith(".tmp"))
            expect(leftovers).toEqual([])
        })

        it("keeps the first marker's reason", () => {
            haltSigning("first", identity)
            haltSigning("second", identity)
            expect(
                JSON.parse(
                    fs.readFileSync(signingHaltMarkerPath(identity), "utf8"),
                ).reason,
            ).toBe("first")
        })

        it("still stops this process when the marker cannot be made durable", () => {
            jest.spyOn(fs, "fsyncSync").mockImplementation(() => {
                throw Object.assign(new Error("EIO: sync failed"), {
                    code: "EIO",
                })
            })
            try {
                expect(haltSigning("key seen elsewhere", identity)).toBe(true)
            } finally {
                jest.restoreAllMocks()
            }
            expect(signingHaltReason()).toBe("key seen elsewhere")
            expect(fs.existsSync(signingHaltMarkerPath(identity))).toBe(false)
        })

        it("refuses every round once halted and names the reason", () => {
            guardBlockSignature(identity, round(10, 1000, "aa"))
            expect(haltSigning("key seen elsewhere")).toBe(true)
            expect(haltSigning("again")).toBe(false)
            expect(() =>
                checkBlockSignature(identity, round(11, 2000, "bb")),
            ).toThrow(/key seen elsewhere/)
            expect(() =>
                recordBlockSignature(identity, round(11, 2000, "bb")),
            ).toThrow(DoubleSignError)
            expect(loadSigningRecord(identity)?.height).toBe(10)
        })
    })

    describe("identity lease at record time", () => {
        afterEach(() => __resetSigningHalt())

        it("refuses to release a signature when the lease is not ours", () => {
            guardBlockSignature(identity, round(10, 1000, "aa"))
            setSigningLeaseCheck(() => "identity lock is held by pid 7 on elsewhere")
            expect(() =>
                recordBlockSignature(identity, round(11, 2000, "bb")),
            ).toThrow(/held by pid 7 on elsewhere/)
            expect(loadSigningRecord(identity)?.height).toBe(10)
        })

        it("records normally while the lease holds", () => {
            setSigningLeaseCheck(() => null)
            guardBlockSignature(identity, round(10, 1000, "aa"))
            expect(loadSigningRecord(identity)?.height).toBe(10)
        })
    })

    describe("record cache", () => {
        afterEach(() => __resetSigningHalt())

        it("is filled by a write and follows changes to the file", () => {
            __resetSigningHalt()
            expect(cachedSigningRecord(identity)).toBeNull()
            guardBlockSignature(identity, round(10, 1000, "aa"))
            expect(cachedSigningRecord(identity)?.height).toBe(10)
            expect(currentSigningRecord(identity)?.height).toBe(10)
            const file = signingRecordPath(identity)
            const changed = {
                ...JSON.parse(fs.readFileSync(file, "utf8")),
                height: 12,
            }
            fs.writeFileSync(file, JSON.stringify(changed))
            const later = new Date(Date.now() + 5_000)
            fs.utimesSync(file, later, later)
            expect(currentSigningRecord(identity)?.height).toBe(12)
        })
    })

    it("remembers the blocks this process recorded", () => {
        guardBlockSignature(identity, round(10, 1000, "aa"))
        guardBlockSignature(identity, round(10, 1005, "bb"))
        expect(signedByThisProcess("aa")).toBe(true)
        expect(signedByThisProcess("bb")).toBe(true)
        expect(signedByThisProcess("cc")).toBe(false)
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
