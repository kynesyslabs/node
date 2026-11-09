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

import { restrictIdentityFileMode } from "./identityFileMode"

const posix = process.platform !== "win32"

describe.skipIf(!posix)("restrictIdentityFileMode", () => {
    let dir: string
    let file: string
    beforeEach(() => {
        warning.mockClear()
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-mode-"))
        file = path.join(dir, ".demos_identity")
        fs.writeFileSync(file, "word ".repeat(12).trim())
    })
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("tightens a world-readable file to 600 and warns", () => {
        fs.chmodSync(file, 0o644)
        expect(restrictIdentityFileMode(file)).toBe(true)
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        expect(warning).toHaveBeenCalledTimes(1)
        expect(String(warning.mock.calls[0][0])).toContain("corrected")
    })

    it("tightens a group-only readable file", () => {
        fs.chmodSync(file, 0o640)
        expect(restrictIdentityFileMode(file)).toBe(true)
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    })

    it("refuses when the mode cannot be corrected and refusal is asked for", () => {
        fs.chmodSync(file, 0o644)
        const chmod = jest.spyOn(fs, "chmodSync").mockImplementation(() => {
            throw new Error("EROFS: read-only file system")
        })
        try {
            expect(() =>
                restrictIdentityFileMode(file, { refuseOpen: true }),
            ).toThrow(/readable by other users.*chmod 600/s)
        } finally {
            chmod.mockRestore()
        }
    })

    it("only warns about an uncorrectable mode without refusal", () => {
        fs.chmodSync(file, 0o644)
        const chmod = jest.spyOn(fs, "chmodSync").mockImplementation(() => {
            throw new Error("EROFS: read-only file system")
        })
        try {
            expect(restrictIdentityFileMode(file)).toBe(false)
            expect(warning).toHaveBeenCalledTimes(1)
        } finally {
            chmod.mockRestore()
        }
    })

    it("leaves an owner-only file alone and stays quiet", () => {
        fs.chmodSync(file, 0o400)
        expect(restrictIdentityFileMode(file)).toBe(false)
        expect(fs.statSync(file).mode & 0o777).toBe(0o400)
        expect(warning).not.toHaveBeenCalled()
    })
})
