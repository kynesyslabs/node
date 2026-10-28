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
    HEARTBEAT_MS,
    identityLeaseProblem,
    identityLockHeartbeat,
    IdentityLockError,
    releaseIdentityLock,
    STALE_MS,
} from "./identityLock"

// Time only moves when the code under test sleeps, so a 20 s wait runs
// instantly; onSleep lets a test act as the other holder in between.
function fakeClock(onSleep?: (now: number) => void) {
    let t = Date.now()
    const clock = {
        slept: 0,
        now: () => t,
        sleep: async (ms: number) => {
            t += ms
            clock.slept += ms
            onSleep?.(t)
        },
        advance: (ms: number) => {
            t += ms
        },
    }
    return clock
}

describe("identityLock", () => {
    let dir: string
    let identity: string
    let lockFile: string
    const readLock = () => JSON.parse(fs.readFileSync(lockFile, "utf8"))
    const writeLock = (body: Record<string, unknown>) =>
        fs.writeFileSync(lockFile, JSON.stringify(body))
    const savedEnv = process.env.DEMOS_IDENTITY_TAKEOVER

    beforeEach(() => {
        delete process.env.DEMOS_IDENTITY_TAKEOVER
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-lock-"))
        identity = path.join(dir, ".demos_identity")
        lockFile = `${identity}.lock`
    })
    afterEach(() => {
        releaseIdentityLock()
        fs.rmSync(dir, { recursive: true, force: true })
        if (savedEnv === undefined) {
            delete process.env.DEMOS_IDENTITY_TAKEOVER
        } else {
            process.env.DEMOS_IDENTITY_TAKEOVER = savedEnv
        }
    })

    it("creates the lock with our pid, instance and heartbeat and removes it on release", async () => {
        const clock = fakeClock()
        await acquireIdentityLock(identity, { clock })
        const holder = readLock()
        expect(holder.pid).toBe(process.pid)
        expect(holder.hostname).toBe(os.hostname())
        expect(typeof holder.instance).toBe("string")
        expect(holder.heartbeat).toBe(clock.now())
        releaseIdentityLock()
        expect(fs.existsSync(lockFile)).toBe(false)
    })

    it("puts the lock next to the real identity file behind a symlink", async () => {
        const state = path.join(dir, "state")
        const app = path.join(dir, "app")
        fs.mkdirSync(state)
        fs.mkdirSync(app)
        fs.writeFileSync(path.join(state, ".demos_identity"), "words")
        fs.symlinkSync(
            path.join(state, ".demos_identity"),
            path.join(app, ".demos_identity"),
        )
        await acquireIdentityLock(path.join(app, ".demos_identity"), {
            clock: fakeClock(),
        })
        expect(fs.existsSync(path.join(state, ".demos_identity.lock"))).toBe(
            true,
        )
        expect(fs.existsSync(path.join(app, ".demos_identity.lock"))).toBe(
            false,
        )
    })

    it("refreshes the heartbeat and bumps the beat counter on each beat", async () => {
        const clock = fakeClock()
        await acquireIdentityLock(identity, { clock })
        const first = readLock()
        clock.advance(HEARTBEAT_MS)
        identityLockHeartbeat()
        expect(readLock().heartbeat).toBe(first.heartbeat + HEARTBEAT_MS)
        expect(readLock().seq).toBe(first.seq + 1)
    })

    describe("lock without a heartbeat on this host", () => {
        it("refuses while its pid is alive", async () => {
            writeLock({ pid: process.ppid, hostname: os.hostname() })
            await expect(
                acquireIdentityLock(identity, { clock: fakeClock() }),
            ).rejects.toBeInstanceOf(IdentityLockError)
        })

        it("treats our own pid as stale", async () => {
            writeLock({ pid: process.pid, hostname: os.hostname() })
            await acquireIdentityLock(identity, { clock: fakeClock() })
            expect(typeof readLock().instance).toBe("string")
        })

        it("replaces a dead pid", async () => {
            writeLock({ pid: 2 ** 22 - 1, hostname: os.hostname() })
            const clock = fakeClock()
            await acquireIdentityLock(identity, { clock, takeover: false })
            expect(readLock().pid).toBe(process.pid)
            expect(clock.slept).toBe(0)
        })
    })

    it("replaces an unreadable lock once it is older than the stale window", async () => {
        fs.writeFileSync(lockFile, "garbage")
        const clock = fakeClock()
        await acquireIdentityLock(identity, { clock })
        expect(readLock().pid).toBe(process.pid)
        expect(clock.slept).toBeGreaterThanOrEqual(STALE_MS)
    })

    it("replaces a lease from this host whose heartbeat is stale, without waiting", async () => {
        const clock = fakeClock()
        writeLock({
            pid: 4242,
            hostname: os.hostname(),
            instance: "crashed",
            heartbeat: clock.now() - STALE_MS - 1,
        })
        await acquireIdentityLock(identity, { clock })
        expect(readLock().pid).toBe(process.pid)
        expect(clock.slept).toBe(0)
    })

    describe("lease held by another host", () => {
        const foreign = (heartbeat: number, instance = "other") =>
            writeLock({ pid: 4242, hostname: "elsewhere", instance, heartbeat })

        it("refuses a live holder whose heartbeat advances, naming pid, host and age", async () => {
            const clock = fakeClock(now => foreign(now - 500))
            foreign(clock.now() - 1_000)
            let error: unknown
            try {
                await acquireIdentityLock(identity, { clock })
            } catch (e) {
                error = e
            }
            expect(error).toBeInstanceOf(IdentityLockError)
            const message = (error as Error).message
            expect(message).toContain("elsewhere")
            expect(message).toContain("4242")
            expect(message).toContain("heartbeat")
            expect(readLock().hostname).toBe("elsewhere")
        })

        it("refuses when the holder's instance changes during the wait", async () => {
            const start = Date.now()
            const clock = fakeClock(() => foreign(start - 1_000, "newcomer"))
            foreign(start - 1_000)
            await expect(
                acquireIdentityLock(identity, { clock }),
            ).rejects.toBeInstanceOf(IdentityLockError)
        })

        it("replaces a fresh heartbeat that stops advancing, after waiting it out", async () => {
            const clock = fakeClock()
            foreign(clock.now() - 2_000)
            await acquireIdentityLock(identity, { clock })
            expect(readLock().pid).toBe(process.pid)
            expect(clock.slept).toBeGreaterThanOrEqual(STALE_MS - 2_000)
            expect(clock.slept).toBeLessThanOrEqual(STALE_MS + HEARTBEAT_MS)
        })

        it("replaces a stale heartbeat without takeover after a short watch", async () => {
            const clock = fakeClock()
            foreign(clock.now() - 10 * STALE_MS)
            await acquireIdentityLock(identity, { clock })
            expect(readLock().pid).toBe(process.pid)
            expect(clock.slept).toBeGreaterThanOrEqual(2 * HEARTBEAT_MS)
            expect(clock.slept).toBeLessThan(STALE_MS)
        })

        it("still refuses a stale-looking heartbeat that advances (clock skew)", async () => {
            const start = Date.now()
            const clock = fakeClock(now =>
                foreign(start - 10 * STALE_MS + (now - start)),
            )
            foreign(start - 10 * STALE_MS)
            await expect(
                acquireIdentityLock(identity, { clock }),
            ).rejects.toBeInstanceOf(IdentityLockError)
        })

        it("with takeover, replaces a stale heartbeat after one beat period", async () => {
            const clock = fakeClock()
            foreign(clock.now() - STALE_MS - 1)
            await acquireIdentityLock(identity, { clock, takeover: true })
            expect(readLock().pid).toBe(process.pid)
            expect(clock.slept).toBeGreaterThan(HEARTBEAT_MS)
            expect(clock.slept).toBeLessThan(2 * HEARTBEAT_MS)
        })

        it("reads takeover from DEMOS_IDENTITY_TAKEOVER", async () => {
            process.env.DEMOS_IDENTITY_TAKEOVER = "true"
            const clock = fakeClock()
            foreign(clock.now() - STALE_MS - 1)
            await acquireIdentityLock(identity, { clock })
            expect(clock.slept).toBeLessThan(2 * HEARTBEAT_MS)
        })

        it("with takeover, still refuses a stale-looking holder that beats (clock behind ours)", async () => {
            const start = Date.now()
            let beats = 0
            const clock = fakeClock(now => {
                if (now - start >= HEARTBEAT_MS) {
                    beats += 1
                    writeLock({
                        pid: 4242,
                        hostname: "elsewhere",
                        instance: "other",
                        seq: 1 + beats,
                        heartbeat: start - 10 * STALE_MS,
                    })
                }
            })
            writeLock({
                pid: 4242,
                hostname: "elsewhere",
                instance: "other",
                seq: 1,
                heartbeat: start - 10 * STALE_MS,
            })
            await expect(
                acquireIdentityLock(identity, { clock, takeover: true }),
            ).rejects.toBeInstanceOf(IdentityLockError)
        })

        it("counts a beat whose time steps backwards as alive", async () => {
            const start = Date.now()
            let n = 1
            const clock = fakeClock(() => {
                n += 1
                writeLock({
                    pid: 4242,
                    hostname: "elsewhere",
                    instance: "other",
                    seq: n,
                    heartbeat: start - 1_000 - n * 1_000,
                })
            })
            writeLock({
                pid: 4242,
                hostname: "elsewhere",
                instance: "other",
                seq: n,
                heartbeat: start - 1_000,
            })
            await expect(
                acquireIdentityLock(identity, { clock }),
            ).rejects.toBeInstanceOf(IdentityLockError)
        })

        it("with takeover, never replaces a heartbeat that keeps advancing", async () => {
            const clock = fakeClock(now => foreign(now))
            foreign(clock.now())
            await expect(
                acquireIdentityLock(identity, { clock, takeover: true }),
            ).rejects.toBeInstanceOf(IdentityLockError)
        })

        it("starts over when the holder releases during the wait", async () => {
            const clock = fakeClock(() => fs.rmSync(lockFile, { force: true }))
            foreign(clock.now())
            await acquireIdentityLock(identity, { clock })
            expect(readLock().pid).toBe(process.pid)
        })
    })

    describe("lost ownership", () => {
        it("stops the node when another instance replaced the lock", async () => {
            const onLost = jest.fn()
            await acquireIdentityLock(identity, {
                clock: fakeClock(),
                onLost,
            })
            writeLock({
                pid: 4242,
                hostname: "elsewhere",
                instance: "intruder",
                heartbeat: Date.now(),
            })
            identityLockHeartbeat()
            expect(onLost).toHaveBeenCalledTimes(1)
            expect(onLost.mock.calls[0][0]).toContain("elsewhere")
            // The other node's lock stays: it is the one holding the key now.
            releaseIdentityLock()
            expect(readLock().instance).toBe("intruder")
        })

        it("stops the node when the lock disappeared", async () => {
            const onLost = jest.fn()
            await acquireIdentityLock(identity, {
                clock: fakeClock(),
                onLost,
            })
            fs.rmSync(lockFile)
            identityLockHeartbeat()
            expect(onLost).toHaveBeenCalledTimes(1)
            expect(fs.existsSync(lockFile)).toBe(false)
        })

        it("keeps running through a short write failure and stops once the lock would look stale", async () => {
            const onLost = jest.fn()
            const clock = fakeClock()
            await acquireIdentityLock(identity, { clock, onLost })
            // A directory where the beat's temporary file goes makes every
            // write fail, like a read-only or broken mount.
            fs.mkdirSync(`${lockFile}.${readLock().instance}.tmp`)
            clock.advance(HEARTBEAT_MS)
            identityLockHeartbeat()
            expect(onLost).not.toHaveBeenCalled()
            expect(identityLeaseProblem()).toBeNull()
            clock.advance(STALE_MS)
            expect(identityLeaseProblem()).toContain("last refreshed")
            identityLockHeartbeat()
            expect(onLost).toHaveBeenCalledTimes(1)
            expect(onLost.mock.calls[0][0]).toContain("cannot refresh")
        })

        it("does nothing after release", async () => {
            const onLost = jest.fn()
            await acquireIdentityLock(identity, {
                clock: fakeClock(),
                onLost,
            })
            releaseIdentityLock()
            identityLockHeartbeat()
            expect(onLost).not.toHaveBeenCalled()
        })
    })

    describe("lease check at signing time", () => {
        it("passes while the lock names this node", async () => {
            await acquireIdentityLock(identity, { clock: fakeClock() })
            expect(identityLeaseProblem()).toBeNull()
        })

        it("fails as soon as another node replaced the lock, before the next beat", async () => {
            await acquireIdentityLock(identity, {
                clock: fakeClock(),
                onLost: jest.fn(),
            })
            writeLock({
                pid: 4242,
                hostname: "elsewhere",
                instance: "intruder",
                seq: 1,
                heartbeat: Date.now(),
            })
            expect(identityLeaseProblem()).toContain("elsewhere")
        })

        it("fails after a stall longer than the stale window", async () => {
            const clock = fakeClock()
            await acquireIdentityLock(identity, { clock, onLost: jest.fn() })
            clock.advance(STALE_MS)
            expect(identityLeaseProblem()).toContain("last refreshed")
        })

        it("fails once the lock was released", async () => {
            await acquireIdentityLock(identity, { clock: fakeClock() })
            releaseIdentityLock()
            expect(identityLeaseProblem()).not.toBeNull()
        })
    })
})
