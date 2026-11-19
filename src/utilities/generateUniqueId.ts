import { randomBytes } from "node:crypto"

/**
 * 256 random bits as 64 hex characters. Callers use it as a bearer name (a
 * DAHR session id), so it must not be derivable from the clock.
 */
export function generateUniqueId(): string {
    return randomBytes(32).toString("hex")
}
