/**
 * Launch policy check only. Keep the eligibility calculation aligned with
 * src/libs/blockchain/routines/loadGenesisIdentities.ts; changing the node's
 * rule requires a separate network decision. No snapshot or unit conversion
 * contributes to the loader's set, and address matching is exact.
 */
export function botAllowlistReasons(
    genesis: { balances?: unknown } | null,
    expected: unknown,
): string[] {
    if (genesis === null) return []
    if (expected === undefined) {
        return ["pass --bots FILE containing the reviewed JSON array of bot addresses (use [] for no bots)"]
    }
    if (!Array.isArray(expected)) return ["--bots must contain a JSON array of addresses"]
    const reasons: string[] = []
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
    if (!Array.isArray(genesis?.balances)) {
        return [...reasons, "bot allowlist needs a genesis balances array"]
    }
    const authorized = new Set<string>()
    for (const entry of genesis.balances) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") {
            reasons.push("bot allowlist cannot read a malformed genesis balance entry")
            continue
        }
        const raw = entry[1]
        if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") continue
        try {
            if (BigInt(raw) >= 1_000_000_000_000n) authorized.add(entry[0])
        } catch {
            // The startup loader also skips amounts BigInt cannot parse.
        }
    }
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
