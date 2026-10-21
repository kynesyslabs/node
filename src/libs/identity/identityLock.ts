import fs from "node:fs"
import os from "node:os"
import log from "src/utilities/logger"
import { EnvKey } from "src/config/envKeys"
import { parseBoolFlag } from "src/config/envFlags"

export class IdentityLockError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "IdentityLockError"
    }
}

interface LockHolder {
    pid: number
    hostname: string
}

let heldPath: string | null = null
let exitHookInstalled = false

function readHolder(lockPath: string): LockHolder | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"))
        if (
            typeof parsed?.pid === "number" &&
            typeof parsed?.hostname === "string"
        ) {
            return parsed
        }
    } catch {
        /* unreadable or malformed: treated as stale */
    }
    return null
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM"
    }
}

export interface AcquireLockOptions {
    /** Replace a lock held by another host; defaults to DEMOS_IDENTITY_TAKEOVER. */
    takeover?: boolean
}

/**
 * Create `<identityFile>.lock`. Throws when a live process on this host holds
 * it, or when another host does (an identity file shared over a network
 * mount means two validators with one key) unless takeover is requested.
 */
export function acquireIdentityLock(
    identityFile: string,
    options: AcquireLockOptions = {},
): void {
    const takeover =
        options.takeover ??
        parseBoolFlag(process.env[EnvKey.DEMOS_IDENTITY_TAKEOVER]) ??
        false
    const lockPath = `${identityFile}.lock`
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(lockPath, "wx")
            fs.writeSync(
                fd,
                JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
            )
            fs.closeSync(fd)
            heldPath = lockPath
            if (!exitHookInstalled) {
                exitHookInstalled = true
                process.on("exit", releaseIdentityLock)
            }
            return
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
            const holder = readHolder(lockPath)
            // Our own pid on our own host is a leftover from a previous run:
            // a restarted container keeps its layer and hostname and gets the
            // same pid again, so it can never be a second live holder.
            if (
                holder &&
                holder.hostname === os.hostname() &&
                holder.pid !== process.pid &&
                pidAlive(holder.pid)
            ) {
                throw new IdentityLockError(
                    `${identityFile} is in use by pid ${holder.pid} on this host (lock: ${lockPath})`,
                )
            }
            if (holder && holder.hostname !== os.hostname()) {
                if (!takeover) {
                    throw new IdentityLockError(
                        `${identityFile} is locked by pid ${holder.pid} on host ${holder.hostname} (lock: ${lockPath}); ` +
                            `if that node is gone, set ${EnvKey.DEMOS_IDENTITY_TAKEOVER}=true to take the identity over`,
                    )
                }
                log.warning(
                    `[IDENTITY] identity taken over from host ${holder.hostname} (pid ${holder.pid}) via ${EnvKey.DEMOS_IDENTITY_TAKEOVER}; make sure that node is stopped`,
                )
                fs.rmSync(lockPath, { force: true })
                continue
            }
            log.warning(
                `[IDENTITY] stale lock ${lockPath} (${holder ? `pid ${holder.pid} on ${holder.hostname}` : "unreadable"}); replacing`,
            )
            fs.rmSync(lockPath, { force: true })
        }
    }
    throw new IdentityLockError(`could not create ${lockPath}`)
}

/** Remove the lock file if this process holds it. */
export function releaseIdentityLock(): void {
    if (!heldPath) return
    try {
        fs.rmSync(heldPath, { force: true })
    } catch {
        /* nothing useful to do on exit */
    }
    heldPath = null
}
