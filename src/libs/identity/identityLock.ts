import fs from "node:fs"
import os from "node:os"
import { randomUUID } from "node:crypto"
import log from "src/utilities/logger"
import { EnvKey } from "src/config/envKeys"
import { parseBoolFlag } from "src/config/envFlags"
import { resolveWriteTarget, setSigningLeaseCheck } from "./signingRecord"

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
    /** Bumped on every beat; liveness never depends on the holder's clock. */
    seq?: number
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
let seq = 0
let lastBeatOk = 0
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
                seq: typeof parsed.seq === "number" ? parsed.seq : undefined,
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

type Ownership = "ours" | "missing" | "unreadable" | LockHolder

// A read error is not proof of a takeover (a flaky mount recovers), so it is
// told apart from a missing file or a lock naming someone else.
function ownership(lockPath: string): Ownership {
    let raw: string
    try {
        raw = fs.readFileSync(lockPath, "utf8")
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unreadable"
    }
    try {
        if (JSON.parse(raw)?.instance === instance) return "ours"
    } catch {
        return "unreadable"
    }
    return readHolder(lockPath) ?? "unreadable"
}

function describeOwnership(lockPath: string, own: Exclude<Ownership, "ours">): string {
    if (own === "missing") return `identity lock ${lockPath} is gone`
    if (own === "unreadable") return `identity lock ${lockPath} is unreadable`
    return `identity lock ${lockPath} is held by pid ${own.pid} on ${own.hostname}`
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

function lockBody(beat: number): string {
    return JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        instance,
        seq: beat,
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
        fs.writeSync(fd, lockBody(seq + 1))
    } finally {
        fs.closeSync(fd)
    }
    seq += 1
    return true
}

// A rename in the same directory replaces the lock in one step, so a reader
// never sees a half-written heartbeat. Ownership is checked after the slow
// write, right before the rename. A newcomer can still replace the lock in
// between (a plain filesystem has no compare-and-swap); the rename then
// overwrites its lock and the newcomer stops at its own next beat.
function beat(lockPath: string): Ownership {
    const next = seq + 1
    const tmp = `${lockPath}.${instance}.tmp`
    try {
        fs.writeFileSync(tmp, lockBody(next), { mode: 0o600 })
        const own = ownership(lockPath)
        if (own !== "ours") {
            fs.rmSync(tmp, { force: true })
            return own
        }
        fs.renameSync(tmp, lockPath)
    } catch (e) {
        fs.rmSync(tmp, { force: true })
        throw e
    }
    seq = next
    lastBeatOk = clock.now()
    return "ours"
}

function sameHolder(a: LockHolder | null, b: LockHolder): boolean {
    return (
        a !== null &&
        a.pid === b.pid &&
        a.hostname === b.hostname &&
        a.instance === b.instance &&
        a.seq === b.seq &&
        a.heartbeat === b.heartbeat
    )
}

// Delete only the lock that was judged. Between this read and the unlink a
// newcomer can still slip in (no compare-and-delete on a plain filesystem);
// its next beat then finds our lock instead of its own and it stops.
function removeIfStill(lockPath: string, judged: LockHolder): void {
    if (sameHolder(readHolder(lockPath), judged)) {
        fs.rmSync(lockPath, { force: true })
    }
}

type Observation = "alive" | "stale" | "changed"

/**
 * Watch the holder beat. Clocks of two hosts sharing a volume can disagree,
 * so the holder's age alone never proves it dead: it must also fail to beat
 * while we watch. A live holder beats every HEARTBEAT_MS, so two periods are
 * enough; takeover of an already stale lock shortens that to one period.
 * Any change of the lock counts as a beat, so a holder whose clock steps
 * backwards is still seen alive.
 */
async function observe(
    lockPath: string,
    observed: LockHolder,
    takeover: boolean,
): Promise<Observation> {
    const start = clock.now()
    const age = start - observed.heartbeat
    const window =
        takeover && age >= STALE_MS
            ? HEARTBEAT_MS + 2 * POLL_MS
            : Math.min(
                  STALE_MS + HEARTBEAT_MS,
                  Math.max(STALE_MS - age, 2 * HEARTBEAT_MS),
              )
    while (clock.now() - start < window) {
        await clock.sleep(POLL_MS)
        const current = readHolder(lockPath)
        if (!current) return "changed"
        if (!sameHolder(current, observed)) return "alive"
    }
    return "stale"
}

function startHolding(lockPath: string): void {
    heldPath = lockPath
    lastBeatOk = clock.now()
    setSigningLeaseCheck(identityLeaseProblem)
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
     * Shorten the watch of a lock whose heartbeat is already stale to one
     * beat period; defaults to DEMOS_IDENTITY_TAKEOVER. A lock that keeps
     * beating is never replaced.
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
                if (!readHolder(lockPath)) fs.rmSync(lockPath, { force: true })
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
            removeIfStill(lockPath, holder)
            continue
        }
        // Pids are not trusted for a beating lock: containers sharing the
        // host's hostname live in separate pid namespaces. On one host the
        // clock is shared, so an old heartbeat needs no further watching.
        if (sameHost && clock.now() - holder.heartbeat >= STALE_MS) {
            log.warning(
                `[IDENTITY] stale lock ${lockPath} (pid ${holder.pid} on ${holder.hostname}, no heartbeat for ${STALE_MS / 1000}s); replacing`,
            )
            removeIfStill(lockPath, holder)
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
        // A holder that replaced it meanwhile is judged on the next pass.
        if (!sameHolder(readHolder(lockPath), holder)) continue
        log.warning(
            `[IDENTITY] identity lock ${lockPath} from pid ${holder.pid} on ${holder.hostname} stopped beating; ` +
                `replacing it${takeover ? ` (${EnvKey.DEMOS_IDENTITY_TAKEOVER})` : ""}. Make sure that node is stopped`,
        )
        removeIfStill(lockPath, holder)
    }
    throw new IdentityLockError(`could not create ${lockPath}`)
}

function lose(reason: string): void {
    stopHeartbeat()
    heldPath = null
    onLost(reason)
}

/**
 * One heartbeat; the timer started by acquireIdentityLock runs it. A lock
 * that is gone or names another instance means the identity was taken over
 * while we run, and this process must stop before it signs again. So must a
 * holder that cannot write its beat for the stale window: other nodes
 * already see its lock as free.
 */
export function identityLockHeartbeat(): void {
    if (!heldPath) return
    const lockPath = heldPath
    let failure: string
    try {
        const own = beat(lockPath)
        if (own === "ours") return
        if (own !== "unreadable") {
            lose(
                `${describeOwnership(lockPath, own)} while this node held it; another node may hold this key, stopping`,
            )
            return
        }
        failure = "the lock is unreadable"
    } catch (e) {
        failure = (e as Error).message
    }
    const silent = clock.now() - lastBeatOk
    if (silent >= STALE_MS) {
        lose(
            `cannot refresh identity lock ${lockPath} for ${Math.round(silent / 1000)}s (${failure}); ` +
                "other nodes now see it as free, stopping",
        )
        return
    }
    log.warning(
        `[IDENTITY] cannot refresh identity lock ${lockPath}: ${failure}`,
    )
}

/**
 * Checked under the signing-record lock before a signature is released. The
 * timer alone notices a takeover only at its next beat; a node that stalled
 * past the stale window could otherwise sign one more round after a
 * newcomer replaced its lock.
 */
export function identityLeaseProblem(): string | null {
    if (!heldPath) return "this node does not hold the identity lock"
    const silent = clock.now() - lastBeatOk
    if (silent >= STALE_MS) {
        return `the identity lock was last refreshed ${Math.round(silent / 1000)}s ago; another node may have taken it over`
    }
    const own = ownership(heldPath)
    return own === "ours" ? null : describeOwnership(heldPath, own)
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
