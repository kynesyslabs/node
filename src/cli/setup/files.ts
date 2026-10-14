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
): WriteOutcome {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const exists = fs.existsSync(file)
    if (exists) {
        if (fs.readFileSync(file, "utf8") === content) {
            fs.chmodSync(file, opts.mode)
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
    fs.writeFileSync(tmp, content, { mode: opts.mode, flag: "wx" })
    fs.chmodSync(tmp, opts.mode)
    fs.renameSync(tmp, file)
    return exists ? { status: "replaced", backup } : { status: "created" }
}

export function readTextIfExists(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8")
    } catch {
        return undefined
    }
}
