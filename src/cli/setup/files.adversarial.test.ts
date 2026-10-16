import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { writeFileGuarded } from "./files"
import { makeRoot, removeRoot } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

describe("writeFileGuarded", () => {
    it("is not blocked by a stale temp file left by a killed run with the same process id", () => {
        const file = path.join(root, "k.txt")
        // Containers restart with the same small pids, so this name does recur.
        fs.writeFileSync(`${file}.tmp-${process.pid}`, "stale")
        expect(writeFileGuarded(file, "new\n", { mode: 0o600, overwrite: false }).status).toBe("created")
        expect(fs.readFileSync(file, "utf8")).toBe("new\n")
    })

    it("does not follow a symlink planted where its temp file would go", () => {
        const file = path.join(root, "k.txt")
        const victim = path.join(root, "victim")
        fs.writeFileSync(victim, "precious")
        for (const name of [`${file}.tmp-${process.pid}`]) fs.symlinkSync(victim, name)
        writeFileGuarded(file, "new\n", { mode: 0o600, overwrite: false })
        expect(fs.readFileSync(victim, "utf8")).toBe("precious")
    })

    it("leaves no temp file behind after a success or a failed rename", () => {
        const file = path.join(root, "k.txt")
        writeFileGuarded(file, "a\n", { mode: 0o600, overwrite: true })
        expect(() =>
            writeFileGuarded(file, "b\n", { mode: 0o600, overwrite: true }, Date.now, () => {
                throw new Error("rename failed")
            }),
        ).toThrow("rename failed")
        expect(fs.readFileSync(file, "utf8")).toBe("a\n")
        expect(fs.readdirSync(root).filter(f => f.includes(".tmp-"))).toEqual([])
    })

    it("keeps the old content intact and a readable backup when it replaces a file", () => {
        const file = path.join(root, "k.txt")
        fs.writeFileSync(file, "old\n", { mode: 0o600 })
        const out = writeFileGuarded(file, "new\n", { mode: 0o600, overwrite: true })
        expect(out.status).toBe("replaced")
        expect(fs.readFileSync(file, "utf8")).toBe("new\n")
        if (out.status === "replaced") {
            expect(fs.readFileSync(out.backup, "utf8")).toBe("old\n")
            expect(fs.statSync(out.backup).mode & 0o777).toBe(0o600)
        }
    })

    it("two replacements in the same millisecond do not collide on the backup name", () => {
        const file = path.join(root, "k.txt")
        fs.writeFileSync(file, "v1\n", { mode: 0o600 })
        const fixed = () => 1234
        writeFileGuarded(file, "v2\n", { mode: 0o600, overwrite: true }, fixed)
        expect(() => writeFileGuarded(file, "v3\n", { mode: 0o600, overwrite: true }, fixed)).not.toThrow()
        expect(fs.readFileSync(file, "utf8")).toBe("v3\n")
    })
})
