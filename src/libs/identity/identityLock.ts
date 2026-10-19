import fs from "node:fs"
import os from "node:os"
import log from "src/utilities/logger"

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

/** Create `<identityFile>.lock`; throw if a live process on this host already holds it. */
export function acquireIdentityLock(identityFile: string): void {
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
            if (
                holder &&
                holder.hostname === os.hostname() &&
                pidAlive(holder.pid)
            ) {
                throw new IdentityLockError(
                    `${identityFile} is in use by pid ${holder.pid} on this host (lock: ${lockPath})`,
                )
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
