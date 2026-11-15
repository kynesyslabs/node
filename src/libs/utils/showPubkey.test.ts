import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PHRASE =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
const HEX_KEY = "a".repeat(64)

describe("show:pubkey identity file format detection", () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-showpubkey-"))
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    function run(content: string) {
        const file = path.join(dir, "id")
        fs.writeFileSync(file, content, { mode: 0o600 })
        const result = Bun.spawnSync(["bun", "src/libs/utils/showPubkey.ts", file], {
            cwd: path.resolve(import.meta.dir, "../../.."),
            stdout: "pipe",
            stderr: "pipe",
        })
        return {
            code: result.exitCode,
            stdout: result.stdout.toString(),
            stderr: result.stderr.toString(),
        }
    }

    it("shows the public key for an ASCII-space phrase", () => {
        const r = run(PHRASE)
        expect(r.code).toBe(0)
        expect(r.stdout).toContain("Public Key: ")
    })

    it("reports a hex private key file as the old format", () => {
        const r = run(HEX_KEY)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain("old format")
    })

    it("does not call a phrase separated by U+3000 the old format", () => {
        const r = run(PHRASE.replaceAll(" ", "　"))
        expect(r.stderr).not.toContain("old format")
    })

    it("does not call a phrase separated by a tab the old format", () => {
        const r = run(PHRASE.replaceAll(" ", "\t"))
        expect(r.stderr).not.toContain("old format")
        expect(r.stderr).toContain("Invalid mnemonic")
        expect(r.code).toBe(1)
    })
})
