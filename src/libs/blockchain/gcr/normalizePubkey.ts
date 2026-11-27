import { forgeToHex } from "@/libs/crypto/forgeUtils"

/**
 * Helper to normalize pubkey from different formats
 */
export function normalizePubkey(account: string | Uint8Array): string {
    return typeof account === "string" ? account : forgeToHex(account)
}
