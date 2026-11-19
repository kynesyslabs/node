/**
 * Launch policy check only. Keep the eligibility calculation aligned with
 * src/libs/blockchain/routines/loadGenesisIdentities.ts; changing the node's
 * rule requires a separate network decision. No snapshot or unit conversion
 * contributes to the loader's set, and address matching is exact.
 * genesisIsJsonString: the file's first JSON.parse gave a string, which the
 * launch tool parses again but the loader does not.
 */
export function botAllowlistReasons(
    genesis: { balances?: unknown } | null,
    expected: unknown,
    genesisIsJsonString = false,
): string[] {
    if (genesis === null) return []
    const reasons = genesisIsJsonString
        ? ["genesis file is a JSON-encoded string; the node's bot loader parses it once and fails at boot on it"]
        : []
    if (expected === undefined) {
        return [...reasons, "pass --bots FILE containing the reviewed JSON array of bot addresses (use [] for no bots)"]
    }
    if (!Array.isArray(expected)) return [...reasons, "--bots must contain a JSON array of addresses"]
    const intended = inventoryAddresses(expected, reasons)
    if (!Array.isArray(genesis?.balances)) {
        return [...reasons, "bot allowlist needs a genesis balances array"]
    }
    const authorized = authorizedBots(genesis.balances, reasons)
    for (const address of intended) {
        if (!authorized.has(address)) {
            reasons.push(`intended bot is not authorized: ${address}; needs a raw genesis balance >= 1000000000000`)
        }
    }
    for (const address of authorized) {
        if (!intended.has(address)) reasons.push(`unreviewed authorized bot: ${address}`)
    }
    return reasons
}

/** The valid, distinct --bots addresses; adds a reason for each invalid or repeated entry. */
function inventoryAddresses(expected: unknown[], reasons: string[]): Set<string> {
    const intended = new Set<string>()
    for (const address of expected) {
        if (typeof address !== "string" || !/^0x[0-9a-f]{64}$/.test(address)) {
            reasons.push(`--bots entry ${JSON.stringify(address)} is not a lowercase 0x-prefixed 64-hex address`)
        } else if (intended.has(address)) {
            reasons.push(`--bots repeats ${address}`)
        } else {
            intended.add(address)
        }
    }
    return intended
}

/** The addresses the startup loader authorizes; adds a reason for each malformed entry. */
function authorizedBots(balances: unknown[], reasons: string[]): Set<string> {
    const authorized = new Set<string>()
    for (const entry of balances) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") {
            reasons.push("bot allowlist cannot read a malformed genesis balance entry")
            continue
        }
        if (meetsBotThreshold(entry[1])) authorized.add(entry[0])
    }
    return authorized
}

function meetsBotThreshold(raw: unknown): boolean {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") return false
    try {
        return BigInt(raw) >= 1_000_000_000_000n
    } catch {
        // The startup loader also skips amounts BigInt cannot parse.
        return false
    }
}
