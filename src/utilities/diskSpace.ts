import { statfsSync } from "fs"

const GIB = 1024 ** 3

/**
 * The path whose filesystem the start check and the disk metric measure:
 * DISK_SPACE_PATH when set, else the working directory. In Docker the
 * working directory sits on the container's root filesystem, not on the data
 * volumes, so the compose file points this at the data volume.
 */
export function diskSpacePath(configured: string): string {
    return configured || process.cwd()
}

/** Bytes an unprivileged process can still write under `path`, or null when unknown. */
export function freeDiskBytes(path: string): number | null {
    try {
        const stats = statfsSync(path)
        return Number(stats.bavail) * Number(stats.bsize)
    } catch {
        return null
    }
}

/**
 * Why the node must not start with `freeBytes` left, or null when it may.
 * A full disk fails Postgres writes mid-block, so the node refuses to start
 * below the floor rather than run into that. 0 turns the check off; an
 * unknown free space never refuses.
 */
export function lowDiskRefusal(
    freeBytes: number | null,
    minGib: number,
): string | null {
    if (!(minGib > 0) || freeBytes === null) return null
    if (freeBytes >= minGib * GIB) return null
    return (
        `only ${(freeBytes / GIB).toFixed(1)} GiB of disk free, below MIN_DISK_SPACE=${minGib} GiB. ` +
        "Free disk space (or lower MIN_DISK_SPACE, 0 turns the check off) and start again."
    )
}
