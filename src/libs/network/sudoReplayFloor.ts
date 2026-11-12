import fs from "node:fs"
import {
    resolveWriteTarget,
    signingRecordPath,
    writeFileDurably,
} from "src/libs/identity/signingRecord"

/**
 * The latest timestamp of a sudo call this node accepted, kept on disk next
 * to the signing record. The replay memory is lost on restart and the wall
 * clock can be set back between runs, so only a durable bound tells a call
 * that already ran from a new one: every accepted sudo call is dated after
 * it, and raises it before it runs.
 */

let cached: { file: string; floor: number } | null = null

const RECORD_SUFFIX = ".signed.json"

/** Next to the real signing record, on the same persistent volume. */
export function sudoFloorPath(identityFile: string): string {
    const record = resolveWriteTarget(signingRecordPath(identityFile))
    const base = record.endsWith(RECORD_SUFFIX)
        ? record.slice(0, -RECORD_SUFFIX.length)
        : record
    return `${base}.sudo-floor.json`
}

function readFloor(file: string): number | string {
    if (cached?.file === file) return cached.floor
    let raw: string
    try {
        raw = fs.readFileSync(file, "utf8")
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            return `cannot read sudo replay floor ${file}: ${(e as Error).message}`
        }
        cached = { file, floor: 0 }
        return 0
    }
    let floor: unknown
    try {
        floor = (JSON.parse(raw) as { acceptedUpTo?: unknown } | null)?.acceptedUpTo
    } catch {
        floor = undefined
    }
    if (typeof floor !== "number" || !Number.isFinite(floor)) {
        return `sudo replay floor ${file} is malformed`
    }
    cached = { file, floor }
    return floor
}

/**
 * Admits a sudo call signed at `timestamp`, raising the floor to it on disk
 * first; or says why it is refused. Synchronous, so two requests cannot
 * both pass the check before either raises the floor. Any failure to read
 * or write the floor refuses the call.
 */
export function admitSudoCall(
    identityFile: string | undefined,
    timestamp: number | undefined,
): string | null {
    if (!identityFile) return "no identity file to keep the sudo replay floor next to"
    if (timestamp === undefined || !Number.isFinite(timestamp)) {
        return "sudo call carries no signed timestamp"
    }
    const file = sudoFloorPath(identityFile)
    const floor = readFloor(file)
    if (typeof floor === "string") return floor
    if (timestamp <= floor) {
        return `sudo call dated ${new Date(timestamp).toISOString()} is not after the last one this node accepted (${new Date(floor).toISOString()}); sign it again`
    }
    try {
        writeFileDurably(file, JSON.stringify({ acceptedUpTo: timestamp }), "sudo replay floor")
    } catch (e) {
        return (e as Error).message
    }
    cached = { file, floor: timestamp }
    return null
}
