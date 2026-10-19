import fs from "fs"

/**
 * Replace `path` with `content` without ever leaving a half-written or
 * unchecked file in its place: the content goes to a temporary file in the same
 * directory (so the rename stays on one filesystem) with the mode of the file it
 * replaces, is flushed to disk, is handed to `verify` as read back from disk,
 * and only then renamed over `path`. When `verify` throws, or anything else
 * fails, `path` is untouched and the temporary file is removed.
 */
export function replaceFileAtomically(
    path: string,
    content: string,
    verify: (writtenContent: string) => void,
): void {
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
        fs.renameSync(tmp, path)
    } catch (error) {
        fs.rmSync(tmp, { force: true })
        throw error
    }
}
