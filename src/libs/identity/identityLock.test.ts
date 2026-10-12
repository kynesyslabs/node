import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))

import {
    acquireIdentityLock,
    IdentityLockError,
    releaseIdentityLock,
} from "./identityLock"

describe("identityLock", () => {
    let dir: string
    let identity: string
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-lock-"))
        identity = path.join(dir, ".demos_identity")
    })
    afterEach(() => {
        releaseIdentityLock()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("creates the lock with our pid and removes it on release", () => {
        acquireIdentityLock(identity)
        const holder = JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8"))
        expect(holder.pid).toBe(process.pid)
        expect(holder.hostname).toBe(os.hostname())
        releaseIdentityLock()
        expect(fs.existsSync(`${identity}.lock`)).toBe(false)
    })

    it("refuses when a live process on this host holds it", () => {
        fs.writeFileSync(
            `${identity}.lock`,
            JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
        )
        expect(() => acquireIdentityLock(identity)).toThrow(IdentityLockError)
    })

    it("replaces a lock left by a dead pid", () => {
        fs.writeFileSync(
            `${identity}.lock`,
            JSON.stringify({ pid: 2 ** 22 - 1, hostname: os.hostname() }),
        )
        acquireIdentityLock(identity)
        const holder = JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8"))
        expect(holder.pid).toBe(process.pid)
    })

    it("replaces a lock from another host or an unreadable one", () => {
        fs.writeFileSync(
            `${identity}.lock`,
            JSON.stringify({ pid: process.pid, hostname: "elsewhere" }),
        )
        acquireIdentityLock(identity)
        releaseIdentityLock()
        fs.writeFileSync(`${identity}.lock`, "garbage")
        acquireIdentityLock(identity)
        expect(
            JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8")).pid,
        ).toBe(process.pid)
    })
})
