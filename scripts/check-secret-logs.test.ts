import { expect, it } from "bun:test"
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findSecretLogs } from "./check-secret-logs"

function scan(code: string): string[] {
    const root = mkdtempSync(join(tmpdir(), "secret-logs-"))
    try {
        mkdirSync(join(root, "src"))
        writeFileSync(join(root, "src", "fixture.ts"), code)
        return findSecretLogs(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

it("flags concatenated key values", () => {
    expect(scan("log.debug(\"bridgePrivateKey: \" + bridgePrivateKey)")).toEqual(["src/fixture.ts:1"])
})

it("flags key properties inside template expressions", () => {
    expect(scan("log.debug(`k ${keys.privateKey}`)")).toEqual(["src/fixture.ts:1"])
})

it("flags private key fields", () => {
    expect(scan("class Keys { #privateKey = \"key\"; log() { log.debug(this.#privateKey) } }")).toEqual(["src/fixture.ts:1"])
})

it("allows private key field lengths", () => {
    expect(scan("class Keys { #privateKey = \"key\"; log() { log.debug(this.#privateKey.length) } }")).toEqual([])
})

it("ignores key names in fixed text", () => {
    expect(scan("log.error(\"Invalid mnemonic: not valid\")")).toEqual([])
})

it("flags multi-line calls", () => {
    expect(scan("console.info(\n  \"signing key\",\n  signingKey\n)")).toEqual(["src/fixture.ts:1"])
})

it("allows key lengths", () => {
    expect(scan("log.info(\"len \" + privateKey.length)")).toEqual([])
    expect(scan("log.info(`len ${keys.privateKey.length}`)")).toEqual([])
})

it("flags other key operations", () => {
    expect(scan("log.info(\"k \" + privateKey.toString(\"hex\"))")).toEqual(["src/fixture.ts:1"])
    expect(scan("log.info(privateKey[0])")).toEqual(["src/fixture.ts:1"])
})

it("matches every sensitive name without case sensitivity", () => {
    for (const name of ["bridgePrivateKey", "shardKey", "signingKey", "privateKey", "mnemonic", "seedPhrase", "secretKey"]) {
        expect(scan(`console.warn(${name.toUpperCase()})`)).toEqual(["src/fixture.ts:1"])
    }
})

it("checks only non-test .ts files under src", () => {
    const root = mkdtempSync(join(tmpdir(), "secret-logs-scope-"))
    try {
        mkdirSync(join(root, "src", "nested"), { recursive: true })
        mkdirSync(join(root, "scripts"))
        const code = "log.debug(privateKey)"
        for (const file of ["src/nested/kept.ts", "src/a.test.ts", "src/a.spec.ts", "src/a.js", "scripts/a.ts"]) {
            writeFileSync(join(root, file), code)
        }
        expect(findSecretLogs(root)).toEqual(["src/nested/kept.ts:1"])
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

it("exits unsuccessfully for a hit and successfully for fixed text", () => {
    // The CLI scans the repository that contains the script, so run a copy placed in a fixture repository.
    const root = mkdtempSync(join(tmpdir(), "secret-logs-cli-"))
    try {
        mkdirSync(join(root, "src"))
        mkdirSync(join(root, "scripts"))
        copyFileSync(join(import.meta.dir, "check-secret-logs.ts"), join(root, "scripts", "check-secret-logs.ts"))
        symlinkSync(join(import.meta.dir, "..", "node_modules"), join(root, "node_modules"), "dir")
        const fixture = join(root, "src", "fixture.ts")
        const command = [process.execPath, join(root, "scripts", "check-secret-logs.ts")]
        writeFileSync(fixture, "log.debug(\"key: \" + secretKey)")
        const rejected = Bun.spawnSync(command, { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" })
        expect(rejected.exitCode).toBe(1)
        expect(rejected.stderr.toString()).toContain("src/fixture.ts:1")

        writeFileSync(fixture, "log.error(\"Invalid mnemonic: not valid\")")
        const accepted = Bun.spawnSync(command, { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" })
        expect(accepted.exitCode).toBe(0)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

it("scans its own repository whatever the working directory", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "secret-logs-cwd-"))
    try {
        const command = [process.execPath, join(import.meta.dir, "check-secret-logs.ts")]
        const run = (cwd: string) => {
            const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
            return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
        }
        // Each run parses every source file under src/, so this test needs more than the default timeout.
        expect(run(elsewhere)).toEqual(run(join(import.meta.dir, "..")))
    } finally {
        rmSync(elsewhere, { recursive: true, force: true })
    }
}, 60_000)
