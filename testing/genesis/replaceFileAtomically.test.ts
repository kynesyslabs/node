import { describe, it, expect, afterEach } from "bun:test"
import fs from "node:fs"
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { replaceFileAtomically } from "src/libs/peer/routines/replaceFileAtomically"

describe("replacing a file atomically", () => {
    const setup = () => {
        const dir = mkdtempSync(join(tmpdir(), "atomic-"))
        const path = join(dir, "genesis.json")
        writeFileSync(path, "old")
        chmodSync(path, 0o640)
        return { dir, path }
    }

    it("swaps the content in, keeps the mode and leaves no temporary file", () => {
        const { dir, path } = setup()
        let seen = ""
        replaceFileAtomically(path, "new", written => {
            seen = written
            // The target is still the old file while the check runs.
            expect(readFileSync(path, "utf8")).toBe("old")
        })
        expect(seen).toBe("new")
        expect(readFileSync(path, "utf8")).toBe("new")
        expect(statSync(path).mode & 0o777).toBe(0o640)
        expect(readdirSync(dir)).toEqual(["genesis.json"])
        rmSync(dir, { recursive: true })
    })

    it("leaves the old file and no temporary file when the check fails", () => {
        const { dir, path } = setup()
        expect(() =>
            replaceFileAtomically(path, "bad", () => {
                throw new Error("does not hash like what was served")
            }),
        ).toThrow("does not hash")
        expect(readFileSync(path, "utf8")).toBe("old")
        expect(readdirSync(dir)).toEqual(["genesis.json"])
        rmSync(dir, { recursive: true })
    })

    describe("when the file cannot be renamed over (a single-file bind mount)", () => {
        const realRename = fs.renameSync
        afterEach(() => {
            fs.renameSync = realRename
        })
        const failRename = (code: string) => {
            fs.renameSync = (() => {
                throw Object.assign(new Error(code), { code })
            }) as typeof fs.renameSync
        }

        for (const code of ["EBUSY", "EXDEV"]) {
            it(`writes the verified bytes in place on ${code} and removes the temporary file`, () => {
                const { dir, path } = setup()
                failRename(code)
                const method = replaceFileAtomically(path, "new content", () => undefined)
                expect(method).toBe("in-place")
                expect(readFileSync(path, "utf8")).toBe("new content")
                expect(statSync(path).mode & 0o777).toBe(0o640)
                expect(readdirSync(dir)).toEqual(["genesis.json"])
                rmSync(dir, { recursive: true })
            })
        }

        it("writes every byte in place when the filesystem accepts only a few at a time", () => {
            const { dir, path } = setup()
            failRename("EBUSY")
            const realWrite = fs.writeSync
            fs.writeSync = ((fd: number, data: Buffer | string, ...rest: unknown[]) => {
                if (typeof data === "string") return realWrite(fd, data)
                const [offset, length, position] = rest as [number, number, number]
                return realWrite(fd, data, offset, Math.min(length, 3), position)
            }) as typeof fs.writeSync
            try {
                expect(replaceFileAtomically(path, "new content, written in pieces", () => undefined)).toBe("in-place")
            } finally {
                fs.writeSync = realWrite
            }
            expect(readFileSync(path, "utf8")).toBe("new content, written in pieces")
            expect(readdirSync(dir)).toEqual(["genesis.json"])
            rmSync(dir, { recursive: true })
        })

        it("keeps the verified copy when the in-place write stops short", () => {
            const { dir, path } = setup()
            failRename("EBUSY")
            const realWrite = fs.writeSync
            fs.writeSync = ((fd: number, data: Buffer | string, ...rest: unknown[]) =>
                typeof data === "string" ? realWrite(fd, data) : 0) as typeof fs.writeSync
            try {
                expect(() => replaceFileAtomically(path, "new content", () => undefined)).toThrow(/short write/)
            } finally {
                fs.writeSync = realWrite
            }
            expect(readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(true)
            rmSync(dir, { recursive: true })
        })

        it("does not fall back for other errors, and leaves the old file", () => {
            const { dir, path } = setup()
            failRename("EACCES")
            expect(() => replaceFileAtomically(path, "new", () => undefined)).toThrow("EACCES")
            expect(readFileSync(path, "utf8")).toBe("old")
            expect(readdirSync(dir)).toEqual(["genesis.json"])
            rmSync(dir, { recursive: true })
        })

        it("shortens the content in place without leaving old bytes behind", () => {
            const { dir, path } = setup()
            writeFileSync(path, "a much longer previous content")
            failRename("EBUSY")
            replaceFileAtomically(path, "short", () => undefined)
            expect(readFileSync(path, "utf8")).toBe("short")
            rmSync(dir, { recursive: true })
        })

        it("still verifies before touching the file", () => {
            const { dir, path } = setup()
            failRename("EBUSY")
            expect(() =>
                replaceFileAtomically(path, "bad", () => {
                    throw new Error("rejected")
                }),
            ).toThrow("rejected")
            expect(readFileSync(path, "utf8")).toBe("old")
            rmSync(dir, { recursive: true })
        })
    })
})
