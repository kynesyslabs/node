import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export type WriteOutcome =
    | { status: "created" }
    | { status: "unchanged" }
    | { status: "replaced"; backup: string }
    | { status: "kept" }
    /** The path is a symbolic link and replacing it was not allowed. */
    | { status: "link" }

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
    /**
     * With followSymlink: refuse (before creating any directory) when the file
     * a link leads to is outside this directory.
     */
    confineTo?: string
}

/** realpath for a path that may not exist yet: the existing part is resolved, the rest appended. */
export function realpathLoose(p: string): string {
    const rest: string[] = []
    let current = path.resolve(p)
    for (;;) {
        try {
            const resolved = fs.realpathSync(current)
            return path.join(resolved, ...[...rest].reverse())
        } catch {
            const parent = path.dirname(current)
            if (parent === current) return path.resolve(p)
            rest.push(path.basename(current))
            current = parent
        }
    }
}

/** True when `file` is `dir` or below it once every symlink on the way is resolved. */
export function isInsideDir(file: string, dir: string): boolean {
    const rel = path.relative(realpathLoose(dir), realpathLoose(file))
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
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

/** The file to write: the one a symlink leads to when asked, refused if that is outside the confinement. */
function destination(file: string, opts: WriteOptions): string {
    if (!opts.followSymlink) return file
    const target = resolveSymlink(file)
    if (opts.confineTo !== undefined && !isInsideDir(target, opts.confineTo)) {
        throw new Error(`${target} is outside ${opts.confineTo}`)
    }
    return target
}

export function isSymlink(file: string): boolean {
    try {
        return fs.lstatSync(file).isSymbolicLink()
    } catch {
        return false
    }
}

/** Copies the file (or, for a link, the link itself) to a fresh `.bak-<time>` sibling and returns its path. */
function backUp(file: string, now: () => number): string {
    // Never overwrite an earlier backup: it may be the only copy of a key.
    const stamp = now()
    for (let n = 0; ; n++) {
        const suffix = n === 0 ? "" : `-${n}`
        const backup = `${file}.bak-${stamp}${suffix}`
        try {
            if (isSymlink(file)) {
                // Copying a link would copy what it points at, which may be outside the checkout.
                fs.symlinkSync(fs.readlinkSync(file), backup)
                return backup
            }
            fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
            fs.chmodSync(backup, 0o600)
            return backup
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw e
        }
    }
}

/** Writes through a temp file in the same directory and renames it into place. */
function replaceAtomically(
    file: string,
    content: string,
    mode: number,
    rename: (from: string, to: string) => void,
): void {
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
}

/**
 * The only place the setup writes files. An existing file is never replaced
 * unless `overwrite` is set, and a replaced file is first copied to a
 * `.bak-<time>` sibling so a mistaken key rotation can be undone.
 */
export function writeFileGuarded(
    requested: string,
    content: string,
    opts: WriteOptions,
    now: () => number = Date.now,
    rename: (from: string, to: string) => void = fs.renameSync,
): WriteOutcome {
    const file = destination(requested, opts)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // A link is judged by what it is, never by what it points at: reading through
    // it would call an outside file "unchanged", and tightening its mode would
    // chmod that file. The node's checker rejects a linked key, so only a
    // replacement by a regular file repairs it.
    if (!opts.followSymlink && isSymlink(file)) {
        if (!opts.overwrite) return { status: "link" }
        const backup = backUp(file, now)
        replaceAtomically(file, content, opts.mode, rename)
        return { status: "replaced", backup }
    }
    if (!fs.existsSync(file)) {
        replaceAtomically(file, content, opts.mode, rename)
        return { status: "created" }
    }
    // Modes only ever tighten: an operator's 600 config stays 600, a 644 key
    // is brought down to 600, nothing is made more readable.
    const current = fs.statSync(file).mode & 0o777
    const mode = current & opts.mode
    if (fs.readFileSync(file, "utf8") === content) {
        if (mode !== current) fs.chmodSync(file, mode)
        return { status: "unchanged" }
    }
    if (!opts.overwrite) return { status: "kept" }
    const backup = backUp(file, now)
    replaceAtomically(file, content, mode, rename)
    return { status: "replaced", backup }
}

export function readTextIfExists(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8")
    } catch {
        return undefined
    }
}
