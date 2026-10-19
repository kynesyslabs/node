import { describe, it, expect } from "bun:test"
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
})
