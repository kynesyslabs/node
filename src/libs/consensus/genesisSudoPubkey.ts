/**
 * The key allowed to sign the incentive award transaction, committed in block 0.
 *
 * It lives at the optional `properties.sudoPubkey` of `data/genesis.json`,
 * which block 0 embeds verbatim and hashes, next to `shardSize`. Apply decides
 * whether an award is valid from it, so every node must hold the same value by
 * construction: two validators configured differently would reach different
 * states from the same block. The per-node `SUDO_PUBKEY` setting is not used
 * for that; it only authorises the admin RPC on the node it is set on.
 *
 * Absent, no award transaction is accepted once `editBinding` is active.
 */

const ADDRESS = /^0x[0-9a-f]{64}$/

export class GenesisSudoPubkeyError extends Error {
    constructor(message: string) {
        super(`[GENESIS] properties.sudoPubkey: ${message}`)
        this.name = "GenesisSudoPubkeyError"
    }
}

/** The validated `properties.sudoPubkey` of a parsed genesis payload, or null when it declares none. */
export function readGenesisSudoPubkey(genesisData: unknown): string | null {
    if (genesisData === null || typeof genesisData !== "object") return null
    const properties = (genesisData as { properties?: unknown }).properties
    if (properties === null || typeof properties !== "object") return null
    const raw = (properties as { sudoPubkey?: unknown }).sudoPubkey
    if (raw === undefined || raw === null) return null
    if (typeof raw !== "string" || !ADDRESS.test(raw)) {
        throw new GenesisSudoPubkeyError(
            "must be a lowercase 0x-prefixed 32-byte hex address",
        )
    }
    return raw
}
