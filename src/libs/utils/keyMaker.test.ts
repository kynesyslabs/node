import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as bip39 from "bip39"

const sharedState = { identityFile: "", signingAlgorithm: "ed25519", PROD: true }
const fakeLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
}
jest.mock("src/utilities/logger", () => ({ __esModule: true, default: fakeLog }))
jest.mock("@/utilities/logger", () => ({ __esModule: true, default: fakeLog }))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

const { default: Identity } = await import("../identity/identity")
const { default: Cryptography } = await import("../crypto/cryptography")
const { uint8ArrayToHex } = await import("@kynesyslabs/demosdk/encryption")

const REPO = path.resolve(import.meta.dir, "../../..")
const PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"))
const EXISTING =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n"

// Run the actual package script, including tsx and tsconfig-paths, without mocks.
// Only the fixture package/config and links live in the disposable working dir.
function keygen(cwd: string, args: string[] = []) {
    const result = spawnSync(process.execPath, ["run", "keygen", ...args], {
        cwd,
        encoding: "utf8",
        env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            TS_NODE_PROJECT: path.join(REPO, "tsconfig.json"),
            ESBK_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
        },
        timeout: 120_000,
    })
    if (result.error) throw result.error
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

function expectNoSecret(output: string, mnemonic: string, privateKey?: Uint8Array) {
    expect(output).not.toContain(mnemonic.trim())
    if (privateKey) {
        expect(output).not.toContain(uint8ArrayToHex(privateKey).replace(/^0x/, ""))
        expect(output).not.toContain(JSON.stringify(Buffer.from(privateKey)))
        expect(output).not.toContain(Buffer.from(privateKey).toString("base64"))
    }
}

describe.skipIf(process.platform === "win32")("bun run keygen", () => {
    let dir: string
    let file: string
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-keygen-"))
        file = path.join(dir, ".demos_identity")
        fs.symlinkSync(path.join(REPO, "src"), path.join(dir, "src"), "dir")
        fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir")
        fs.copyFileSync(path.join(REPO, "tsconfig.json"), path.join(dir, "tsconfig.json"))
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
            type: PACKAGE.type,
            scripts: { keygen: PACKAGE.scripts.keygen },
        }))
    })
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("creates a 0600 mnemonic that boots with the printed public key and no secrets", async () => {
        const result = keygen(dir)
        expect(result.status).toBe(0)
        const mnemonic = fs.readFileSync(file, "utf8")
        expect(bip39.validateMnemonic(mnemonic)).toBe(true)
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        sharedState.identityFile = file
        const identity = await Identity.getInstance().loadIdentity()
        const publicKey = uint8ArrayToHex(identity.publicKey as Uint8Array).replace(/^0x/, "")
        expect(fs.readFileSync(path.join(dir, "public.key"), "utf8")).toBe(publicKey)
        expect(result.output).toContain(`Public Key (ed25519): ${publicKey}`)
        expectNoSecret(result.output, mnemonic, identity.privateKey as Uint8Array)
    }, 180_000)

    it("keeps an existing mnemonic, including with the rejected -f flag", () => {
        fs.writeFileSync(file, EXISTING, { mode: 0o600 })
        const original = fs.statSync(file)
        const result = keygen(dir)
        expect(result.status).toBe(0)
        expectNoSecret(result.output, EXISTING)
        const forced = keygen(dir, ["-f"])
        expect(forced.status).toBe(1)
        expect(forced.output).toContain("-f is no longer supported")
        expectNoSecret(forced.output, EXISTING)
        expect(fs.readFileSync(file, "utf8")).toBe(EXISTING)
        expect(fs.statSync(file).ino).toBe(original.ino)
        expect(fs.statSync(file).mtimeMs).toBe(original.mtimeMs)
    }, 180_000)

    it("refuses an existing legacy hex identity without changing it", () => {
        const legacy = "0x" + "ab".repeat(64)
        fs.writeFileSync(file, legacy, { mode: 0o600 })
        const result = keygen(dir)
        expect(result.status).toBe(1)
        expect(result.output).toContain("not a valid BIP39 mnemonic")
        expect(result.output).not.toContain(legacy)
        expect(fs.readFileSync(file, "utf8")).toBe(legacy)
        expect(fs.existsSync(path.join(dir, "public.key"))).toBe(false)
        expect(keygen(dir, ["-f"]).status).toBe(1)
        expect(fs.readFileSync(file, "utf8")).toBe(legacy)
    }, 180_000)

    it("does not follow a dangling identity symlink to create a new secret", () => {
        const target = path.join(dir, "missing-identity")
        fs.symlinkSync(target, file)
        const result = keygen(dir)
        expect(result.status).toBe(1)
        expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
        expect(fs.existsSync(target)).toBe(false)
    }, 180_000)

    for (const alias of ["symlink", "hardlink"]) {
        it(`keeps the identity when public.key is a ${alias} to it`, () => {
            fs.writeFileSync(file, EXISTING, { mode: 0o600 })
            const output = path.join(dir, "public.key")
            if (alias === "symlink") fs.symlinkSync(file, output)
            else fs.linkSync(file, output)
            const result = keygen(dir)
            expect(result.status).toBe(1)
            expect(fs.readFileSync(file, "utf8")).toBe(EXISTING)
            expectNoSecret(result.output, EXISTING)
        }, 180_000)
    }
})

describe("Cryptography.save", () => {
    it("never logs the private key, for either supported format", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-crypto-"))
        try {
            for (const logger of Object.values(fakeLog)) logger.mockClear()
            const identity = Cryptography.new()
            await Cryptography.save(identity, path.join(dir, "hex"))
            await Cryptography.save(identity, path.join(dir, "json"), "json")
            const logged = JSON.stringify(Object.values(fakeLog).flatMap(logger => logger.mock.calls))
            expect(logged).not.toContain(identity.privateKey.toString("hex"))
            expect(logged).not.toContain(JSON.stringify(identity.privateKey))
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
