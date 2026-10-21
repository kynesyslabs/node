import fs from "node:fs"
import log from "src/utilities/logger"

/**
 * The mnemonic is the validator key: any group or other permission bit lets
 * another local user read it, so those bits are removed on load. Returns true
 * when the mode had to be corrected.
 */
export function restrictIdentityFileMode(file: string): boolean {
    if (process.platform === "win32") return false
    const mode = fs.statSync(file).mode & 0o777
    if ((mode & 0o077) === 0) return false
    try {
        fs.chmodSync(file, 0o600)
    } catch (e) {
        // A read-only mount or a file owned by someone else cannot be fixed
        // from here; the operator has to, and the node should still start.
        log.warning(
            `[IDENTITY] ${file} is readable by other users (mode ${mode.toString(8)}) and could not be corrected: ${(e as Error).message}`,
        )
        return false
    }
    log.warning(
        `[IDENTITY] ${file} was readable by other users (mode ${mode.toString(8)}); permissions corrected to 600`,
    )
    return true
}
