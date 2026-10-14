import * as crypto from "node:crypto"
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
    /**
     * Write to the file a symlink points at instead of replacing the link.
     * Only for a file the operator may deliberately keep elsewhere (.env); a
     * key file must never be written through a link to outside the checkout.
     */
    followSymlink?: boolean
}

/** The file a chain of symlinks ends at; a dangling link yields where it would create it. */
export function resolveSymlink(file: string): string {
    let current = file
    for (let hops = 0; hops < 40; hops++) {
        let target: string
        try {
            if (!fs.lstatSync(current).isSymbolicLink()) return current
            target = fs.readlinkSync(current)
        } catch {
            return current
        }
        current = path.resolve(path.dirname(current), target)
    }
    throw new Error(`${file}: too many levels of symbolic links`)
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
    if (opts.followSymlink) file = resolveSymlink(file)
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
        // Never overwrite an earlier backup: it may be the only copy of a key.
        const stamp = now()
        for (let n = 0; ; n++) {
            backup = `${file}.bak-${stamp}${n === 0 ? "" : `-${n}`}`
            try {
                fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
                break
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw e
            }
        }
        fs.chmodSync(backup, 0o600)
    }

    // A pid alone repeats across container restarts, so a temp file left by a
    // killed run would block every later write.
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
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
