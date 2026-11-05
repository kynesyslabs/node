/**
 * Absolute paths for the host tools the drills shell out to (docker,
 * python3). A bare command name is looked up through the caller's PATH, so a
 * writable directory early in PATH could swap in another binary; the drills
 * only take the tool from fixed system directories instead.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

// Linux distro and snap installs, then the Homebrew prefix for macOS hosts.
export const TRUSTED_BIN_DIRS = [
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/snap/bin",
    "/opt/homebrew/bin",
] as const

const cache = new Map<string, string>()

/** The absolute path of `name` in the first trusted directory holding it. */
export function systemBinary(name: string): string {
    const hit = cache.get(name)
    if (hit) return hit
    for (const dir of TRUSTED_BIN_DIRS) {
        const path = join(dir, name)
        if (existsSync(path)) {
            cache.set(name, path)
            return path
        }
    }
    throw new Error(
        `${name} not found in any of ${TRUSTED_BIN_DIRS.join(", ")}; install it there or link it in`,
    )
}
