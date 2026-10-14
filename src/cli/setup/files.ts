import * as fs from "node:fs"
import * as path from "node:path"

export type WriteOutcome =
    | { status: "created" }
    | { status: "unchanged" }
    | { status: "replaced"; backup: string }
    | { status: "kept" }

export interface WriteOptions {
    mode: number
    /** Replace a file that exists with different content. Off unless the operator agreed. */
    overwrite: boolean
}

/**
 * The only place the setup writes files. An existing file is never replaced
 * unless `overwrite` is set, and a replaced file is first copied to a
 * `.bak-<time>` sibling so a mistaken key rotation can be undone.
 */
export function writeFileGuarded(
    file: string,
    content: string,
    opts: WriteOptions,
    now: () => number = Date.now,
    rename: (from: string, to: string) => void = fs.renameSync,
): WriteOutcome {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const exists = fs.existsSync(file)
    // Modes only ever tighten: an operator's 600 config stays 600, a 644 key
    // is brought down to 600, nothing is made more readable.
    let mode = opts.mode
    if (exists) {
        const current = fs.statSync(file).mode & 0o777
        mode = current & opts.mode
        if (fs.readFileSync(file, "utf8") === content) {
            if (mode !== current) fs.chmodSync(file, mode)
            return { status: "unchanged" }
        }
        if (!opts.overwrite) return { status: "kept" }
    }

    let backup = ""
    if (exists) {
        backup = `${file}.bak-${now()}`
        fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(backup, 0o600)
    }

    const tmp = `${file}.tmp-${process.pid}`
    try {
        fs.writeFileSync(tmp, content, { mode, flag: "wx" })
        fs.chmodSync(tmp, mode)
        rename(tmp, file)
    } catch (e) {
        fs.rmSync(tmp, { force: true })
        throw e
    }
    return exists ? { status: "replaced", backup } : { status: "created" }
}

export function readTextIfExists(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8")
    } catch {
        return undefined
    }
}
