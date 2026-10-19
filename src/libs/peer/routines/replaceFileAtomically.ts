import fs from "fs"

export type ReplaceMethod = "renamed" | "in-place"

/**
 * Replace `path` with `content` without ever leaving a half-written or
 * unchecked file in its place: the content goes to a temporary file in the same
 * directory with the mode of the file it replaces, is flushed to disk, is
 * handed to `verify` as read back from disk, and only then put in place. When
 * `verify` throws, `path` is untouched and the temporary file is removed.
 *
 * The normal way in is a rename. A file that is a single-file bind mount cannot
 * be renamed over (EBUSY, or EXDEV across filesystems), so the bytes that
 * passed `verify` are then written into the existing file instead. That is not
 * atomic, so the verified temporary file is kept if that write fails, and is
 * the copy to restore from.
 */
export function replaceFileAtomically(
    path: string,
    content: string,
    verify: (writtenContent: string) => void,
): ReplaceMethod {
    const tmp = `${path}.${process.pid}.tmp`
    const mode = fs.statSync(path).mode & 0o777
    try {
        const fd = fs.openSync(tmp, "w", mode)
        try {
            fs.writeSync(fd, content)
            fs.fsyncSync(fd)
        } finally {
            fs.closeSync(fd)
        }
        verify(fs.readFileSync(tmp, "utf8"))
    } catch (error) {
        fs.rmSync(tmp, { force: true })
        throw error
    }

    try {
        fs.renameSync(tmp, path)
        return "renamed"
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EBUSY" && code !== "EXDEV") {
            fs.rmSync(tmp, { force: true })
            throw error
        }
    }

    const fd = fs.openSync(path, "r+")
    try {
        fs.ftruncateSync(fd, 0)
        fs.writeSync(fd, content)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    fs.rmSync(tmp, { force: true })
    return "in-place"
}
