import fs from "node:fs"
import os from "node:os"
import { randomUUID } from "node:crypto"
import log from "src/utilities/logger"
import { EnvKey } from "src/config/envKeys"
import { parseBoolFlag } from "src/config/envFlags"
import { resolveWriteTarget } from "./signingRecord"

export class IdentityLockError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "IdentityLockError"
    }
}

/** How often the holder refreshes the lock. */
export const HEARTBEAT_MS = 5_000
/** A lock whose heartbeat is older than this belongs to a node that is gone. */
export const STALE_MS = 20_000
const POLL_MS = 1_000

interface LockHolder {
    pid: number
    hostname: string
    /** Absent in locks written before the lease existed. */
    instance?: string
    /** Epoch ms; for a lock without one, the file's mtime. */
    heartbeat: number
}

export interface LockClock {
    now: () => number
    sleep: (ms: number) => Promise<void>
}

const realClock: LockClock = {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

// A restarted container can get the same pid and hostname as the process
// that wrote the lock, so ownership is decided by an id no other process has.
const instance = randomUUID()

let heldPath: string | null = null
let clock: LockClock = realClock
let onLost: (reason: string) => void = defaultOnLost
let timer: ReturnType<typeof setInterval> | null = null
let exitHookInstalled = false

function defaultOnLost(reason: string): void {
    log.error(`[IDENTITY] ${reason}`)
    process.exit(1)
}

/**
 * The lock sits next to the real identity file. Container entrypoints
 * symlink the identity file into a shared volume; a lock beside the link
 * would live in the container layer, where a second container on the same
 * volume never sees it.
 */
export function identityLockPath(identityFile: string): string {
    return `${resolveWriteTarget(identityFile)}.lock`
}

function readHolder(lockPath: string): LockHolder | null {
    let raw: string
    let mtimeMs: number
    try {
        raw = fs.readFileSync(lockPath, "utf8")
        mtimeMs = fs.statSync(lockPath).mtimeMs
    } catch {
        return null
    }
    try {
        const parsed = JSON.parse(raw)
        if (
            typeof parsed?.pid === "number" &&
            typeof parsed?.hostname === "string"
        ) {
            return {
                pid: parsed.pid,
                hostname: parsed.hostname,
                instance:
                    typeof parsed.instance === "string"
                        ? parsed.instance
                        : undefined,
                heartbeat:
                    typeof parsed.heartbeat === "number"
                        ? parsed.heartbeat
                        : mtimeMs,
            }
        }
    } catch {
        /* malformed: the caller judges it by file age */
    }
    return null
}

function fileAge(lockPath: string): number | null {
    try {
        return clock.now() - fs.statSync(lockPath).mtimeMs
    } catch {
        return null
    }
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM"
    }
}

function lockBody(): string {
    return JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        instance,
        heartbeat: clock.now(),
    })
}

function tryCreate(lockPath: string): boolean {
    let fd: number
    try {
        fd = fs.openSync(lockPath, "wx", 0o600)
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false
        throw e
    }
    try {
        fs.writeSync(fd, lockBody())
    } finally {
        fs.closeSync(fd)
    }
    return true
}

// A rename in the same directory replaces the lock in one step, so a reader
// never sees a half-written heartbeat.
function rewrite(lockPath: string): void {
    const tmp = `${lockPath}.${instance}.tmp`
    try {
        fs.writeFileSync(tmp, lockBody(), { mode: 0o600 })
        fs.renameSync(tmp, lockPath)
    } catch (e) {
        fs.rmSync(tmp, { force: true })
        throw e
    }
}

function sameHolder(a: LockHolder | null, b: LockHolder): boolean {
    return (
        a !== null &&
        a.pid === b.pid &&
        a.hostname === b.hostname &&
        a.instance === b.instance &&
        a.heartbeat === b.heartbeat
    )
}

type Observation = "alive" | "stale" | "changed"

/**
 * Watch the holder's heartbeat. Clocks of two hosts sharing a volume can
 * disagree, so the holder's age alone never proves it dead: unless takeover
 * was asked for an already stale lock, it must also fail to beat while we
 * watch. A live holder beats every HEARTBEAT_MS, so two periods are enough.
 */
async function observe(
    lockPath: string,
    observed: LockHolder,
    takeover: boolean,
): Promise<Observation> {
    const start = clock.now()
    const age = start - observed.heartbeat
    if (takeover && age >= STALE_MS) return "stale"
    const window = Math.min(
        STALE_MS + HEARTBEAT_MS,
        Math.max(STALE_MS - age, 2 * HEARTBEAT_MS),
    )
    while (clock.now() - start < window) {
        await clock.sleep(POLL_MS)
        const current = readHolder(lockPath)
        if (!current) return "changed"
        if (
            current.instance !== observed.instance ||
            current.heartbeat > observed.heartbeat
        ) {
            return "alive"
        }
    }
    return "stale"
}

function startHolding(lockPath: string): void {
    heldPath = lockPath
    if (!exitHookInstalled) {
        exitHookInstalled = true
        process.on("exit", releaseIdentityLock)
    }
    if (!timer) {
        timer = setInterval(identityLockHeartbeat, HEARTBEAT_MS)
        timer.unref?.()
    }
}

export interface AcquireLockOptions {
    /**
     * Skip the wait for a lock whose heartbeat is already stale; defaults to
     * DEMOS_IDENTITY_TAKEOVER. A lock that keeps beating is never replaced.
     */
    takeover?: boolean
    /** Called when another process replaced our lock while we run. */
    onLost?: (reason: string) => void
    clock?: LockClock
}

/**
 * Take the identity lease. A lock left by a crashed node is replaced once its
 * heartbeat is seen to stop, so recreating a container needs no flag; a lock
 * whose holder keeps beating means a second node with this key, and throws.
 */
export async function acquireIdentityLock(
    identityFile: string,
    options: AcquireLockOptions = {},
): Promise<void> {
    const takeover =
        options.takeover ??
        parseBoolFlag(process.env[EnvKey.DEMOS_IDENTITY_TAKEOVER]) ??
        false
    clock = options.clock ?? realClock
    onLost = options.onLost ?? defaultOnLost
    const lockPath = identityLockPath(identityFile)
    const deadline = clock.now() + 3 * (STALE_MS + HEARTBEAT_MS)

    while (clock.now() < deadline) {
        if (tryCreate(lockPath)) {
            startHolding(lockPath)
            return
        }
        const holder = readHolder(lockPath)
        if (!holder) {
            const age = fileAge(lockPath)
            if (age === null) continue
            // Unreadable for a moment while its creator writes it; one that
            // stays unreadable for the stale window is debris.
            if (age >= STALE_MS) {
                log.warning(
                    `[IDENTITY] unreadable identity lock ${lockPath}; replacing`,
                )
                fs.rmSync(lockPath, { force: true })
                continue
            }
            await clock.sleep(POLL_MS)
            continue
        }
        if (holder.instance === instance) {
            startHolding(lockPath)
            return
        }
        const sameHost = holder.hostname === os.hostname()
        // A node from before the lease never beats, so its pid is the only
        // sign of life. Our own pid is a leftover from a previous run: a
        // restarted container keeps its hostname and gets the same pid again.
        if (sameHost && holder.instance === undefined) {
            if (holder.pid !== process.pid && pidAlive(holder.pid)) {
                throw new IdentityLockError(
                    `${identityFile} is in use by pid ${holder.pid} on this host (lock: ${lockPath})`,
                )
            }
            log.warning(
                `[IDENTITY] stale lock ${lockPath} (pid ${holder.pid} on ${holder.hostname}); replacing`,
            )
            fs.rmSync(lockPath, { force: true })
            continue
        }
        // Pids are not trusted for a beating lock: containers sharing the
        // host's hostname live in separate pid namespaces. On one host the
        // clock is shared, so an old heartbeat needs no further watching.
        if (sameHost && clock.now() - holder.heartbeat >= STALE_MS) {
            log.warning(
                `[IDENTITY] stale lock ${lockPath} (pid ${holder.pid} on ${holder.hostname}, no heartbeat for ${STALE_MS / 1000}s); replacing`,
            )
            fs.rmSync(lockPath, { force: true })
            continue
        }

        log.info(
            `[IDENTITY] identity lock ${lockPath} is held by pid ${holder.pid} on ${holder.hostname}; checking whether that node is still alive`,
        )
        const seen = await observe(lockPath, holder, takeover)
        if (seen === "changed") continue
        if (seen === "alive") {
            const latest = readHolder(lockPath) ?? holder
            const ageSec = Math.max(
                0,
                Math.round((clock.now() - latest.heartbeat) / 1000),
            )
            throw new IdentityLockError(
                `${identityFile} is in use by pid ${latest.pid} on host ${latest.hostname} ` +
                    `(heartbeat ${ageSec}s ago, lock: ${lockPath}); two nodes with one key can double-sign, stop the other node first`,
            )
        }
        // Only remove what was judged: a holder that replaced it meanwhile
        // is judged on the next pass.
        if (!sameHolder(readHolder(lockPath), holder)) continue
        log.warning(
            `[IDENTITY] identity lock ${lockPath} from pid ${holder.pid} on ${holder.hostname} stopped beating; ` +
                `replacing it${takeover ? ` (${EnvKey.DEMOS_IDENTITY_TAKEOVER})` : ""}. Make sure that node is stopped`,
        )
        fs.rmSync(lockPath, { force: true })
    }
    throw new IdentityLockError(`could not create ${lockPath}`)
}

/**
 * One heartbeat; the timer started by acquireIdentityLock runs it. A lock
 * that is gone or names another instance means the identity was taken over
 * while we run, and this process must stop before it signs again.
 */
export function identityLockHeartbeat(): void {
    if (!heldPath) return
    const lockPath = heldPath
    const current = readHolder(lockPath)
    if (!current || current.instance !== instance) {
        stopHeartbeat()
        heldPath = null
        onLost(
            current
                ? `identity lock ${lockPath} was taken over by pid ${current.pid} on ${current.hostname}; another node holds this key, stopping`
                : `identity lock ${lockPath} disappeared while this node held it; stopping so two nodes cannot sign with one key`,
        )
        return
    }
    try {
        rewrite(lockPath)
    } catch (e) {
        log.warning(
            `[IDENTITY] cannot refresh identity lock ${lockPath}: ${(e as Error).message}`,
        )
    }
}

function stopHeartbeat(): void {
    if (timer) {
        clearInterval(timer)
        timer = null
    }
}

/** Remove the lock file if it still names this process. */
export function releaseIdentityLock(): void {
    stopHeartbeat()
    if (!heldPath) return
    const lockPath = heldPath
    heldPath = null
    try {
        if (readHolder(lockPath)?.instance === instance) {
            fs.rmSync(lockPath, { force: true })
        }
    } catch {
        /* nothing useful to do on exit */
    }
}
