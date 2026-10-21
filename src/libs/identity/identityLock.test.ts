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

    it("refuses when another live process on this host holds it", () => {
        fs.writeFileSync(
            `${identity}.lock`,
            JSON.stringify({ pid: process.ppid, hostname: os.hostname() }),
        )
        expect(() => acquireIdentityLock(identity)).toThrow(IdentityLockError)
    })

    it("treats a lock carrying our own pid and host as stale", () => {
        fs.writeFileSync(
            `${identity}.lock`,
            JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
        )
        acquireIdentityLock(identity)
        expect(
            JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8")).pid,
        ).toBe(process.pid)
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

    it("replaces an unreadable lock", () => {
        fs.writeFileSync(`${identity}.lock`, "garbage")
        acquireIdentityLock(identity)
        expect(
            JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8")).pid,
        ).toBe(process.pid)
    })

    describe("lock held by another host", () => {
        const foreign = () =>
            fs.writeFileSync(
                `${identity}.lock`,
                JSON.stringify({ pid: 4242, hostname: "elsewhere" }),
            )
        const savedEnv = process.env.DEMOS_IDENTITY_TAKEOVER
        afterEach(() => {
            if (savedEnv === undefined) {
                delete process.env.DEMOS_IDENTITY_TAKEOVER
            } else {
                process.env.DEMOS_IDENTITY_TAKEOVER = savedEnv
            }
        })

        it("refuses and names the holder host and pid", () => {
            delete process.env.DEMOS_IDENTITY_TAKEOVER
            foreign()
            let message = ""
            try {
                acquireIdentityLock(identity)
            } catch (e) {
                expect(e).toBeInstanceOf(IdentityLockError)
                message = (e as Error).message
            }
            expect(message).toContain("elsewhere")
            expect(message).toContain("4242")
            expect(
                JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8"))
                    .hostname,
            ).toBe("elsewhere")
        })

        it("is replaced when DEMOS_IDENTITY_TAKEOVER=true", () => {
            process.env.DEMOS_IDENTITY_TAKEOVER = "true"
            foreign()
            acquireIdentityLock(identity)
            const holder = JSON.parse(
                fs.readFileSync(`${identity}.lock`, "utf8"),
            )
            expect(holder.pid).toBe(process.pid)
            expect(holder.hostname).toBe(os.hostname())
        })

        it("is not replaced by other values of the variable", () => {
            process.env.DEMOS_IDENTITY_TAKEOVER = "false"
            foreign()
            expect(() => acquireIdentityLock(identity)).toThrow(
                IdentityLockError,
            )
        })

        it("honours the explicit takeover option", () => {
            delete process.env.DEMOS_IDENTITY_TAKEOVER
            foreign()
            acquireIdentityLock(identity, { takeover: true })
            expect(
                JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8")).pid,
            ).toBe(process.pid)
        })
    })

    it("treats a dead pid on this host as stale even without takeover", () => {
        fs.writeFileSync(
            `${identity}.lock`,
            JSON.stringify({ pid: 2 ** 22 - 1, hostname: os.hostname() }),
        )
        acquireIdentityLock(identity, { takeover: false })
        expect(
            JSON.parse(fs.readFileSync(`${identity}.lock`, "utf8")).pid,
        ).toBe(process.pid)
    })
})
