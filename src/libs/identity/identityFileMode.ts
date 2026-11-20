import fs from "node:fs"
import log from "src/utilities/logger"

/**
 * The mnemonic is the validator key: any group or other permission bit lets
 * another local user read it, so those bits are removed on load. Returns true
 * when the mode had to be corrected.
 *
 * With `refuseOpen` (production), a mode that cannot be corrected (a
 * read-only mount, a file owned by someone else) stops the boot instead of
 * leaving the key readable; elsewhere it is only reported.
 */
export function restrictIdentityFileMode(
    file: string,
    opts: { refuseOpen?: boolean } = {},
): boolean {
    if (process.platform === "win32") return false
    const mode = fs.statSync(file).mode & 0o777
    if ((mode & 0o077) === 0) return false
    try {
        fs.chmodSync(file, 0o600)
    } catch (e) {
        const reason = `${file} is readable by other users (mode ${mode.toString(8)}) and could not be corrected: ${(e as Error).message}`
        if (opts.refuseOpen) {
            throw new Error(
                `[IDENTITY] ${reason}. Refusing to start with a key other users can read: ` +
                    `run chmod 600 on the file where it is stored (on the host for a mounted file), then start again`,
            )
        }
        log.warning(`[IDENTITY] ${reason}`)
        return false
    }
    log.warning(
        `[IDENTITY] ${file} was readable by other users (mode ${mode.toString(8)}); permissions corrected to 600`,
    )
    return true
}
