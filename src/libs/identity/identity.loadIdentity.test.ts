import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const sharedState: any = { identityFile: "", signingAlgorithm: "ed25519" }

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

const { default: Identity } = await import("./identity")
const { ucrypto } = await import("@kynesyslabs/demosdk/encryption")

const posix = process.platform !== "win32"

describe.skipIf(!posix)("Identity.loadIdentity file permissions", () => {
    let dir: string
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-identity-"))
        sharedState.identityFile = path.join(dir, ".demos_identity")
        jest.spyOn(ucrypto, "generateAllIdentities").mockResolvedValue(
            undefined as never,
        )
        jest.spyOn(ucrypto, "getIdentity").mockResolvedValue({} as never)
    })
    afterEach(() => {
        jest.restoreAllMocks()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("creates a new identity file readable by the owner only", async () => {
        const previous = process.umask(0o000)
        try {
            await Identity.getInstance().loadIdentity()
        } finally {
            process.umask(previous)
        }
        expect(fs.statSync(sharedState.identityFile).mode & 0o777).toBe(0o600)
        expect(
            fs.readFileSync(sharedState.identityFile, "utf8").split(" ").length,
        ).toBeGreaterThanOrEqual(12)
    })

    it("tightens an existing group- and world-readable identity file", async () => {
        const previous = process.umask(0o000)
        try {
            await Identity.getInstance().loadIdentity()
        } finally {
            process.umask(previous)
        }
        fs.chmodSync(sharedState.identityFile, 0o644)
        await Identity.getInstance().loadIdentity()
        expect(fs.statSync(sharedState.identityFile).mode & 0o777).toBe(0o600)
    })
})
