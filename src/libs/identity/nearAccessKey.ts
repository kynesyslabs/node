import bs58 from "bs58"

/**
 * A NEAR named account (alice.near) is not derived from a key: any number of
 * access keys can be added to it and removed again. The only way to tie a
 * signing key to the account is to ask the chain whether the key is on it.
 * This runs when a node first accepts the transaction, never during block
 * application, which must not depend on the network.
 *
 * The endpoints are fixed so a client cannot pick the node that answers; an
 * operator can point them elsewhere through the environment.
 */
export const NEAR_RPC_DEFAULTS = {
    mainnet: "https://rpc.mainnet.near.org",
    testnet: "https://rpc.testnet.near.org",
} as const

export const NEAR_RPC_ENV = {
    mainnet: "NEAR_RPC_MAINNET_URL",
    testnet: "NEAR_RPC_TESTNET_URL",
} as const

export const NEAR_RPC_TIMEOUT_MS = 5000

export type NearNetwork = keyof typeof NEAR_RPC_DEFAULTS

export function nearRpcUrl(network: NearNetwork): string {
    return process.env[NEAR_RPC_ENV[network]] || NEAR_RPC_DEFAULTS[network]
}

/**
 * Whether `publicKey` (raw 32-byte ed25519, as base58 with or without the
 * "ed25519:" prefix) is a full-access key of `accountId`. A function-call key
 * can only call the contract it was issued for, so it does not speak for the
 * account. Any error, unexpected answer or timeout is a refusal.
 */
export async function verifyNearNamedAccountKey(args: {
    network: string | undefined
    accountId: string
    publicKey: Uint8Array
}): Promise<{ ok: true } | { ok: false; message: string }> {
    const { network, accountId, publicKey } = args
    if (network !== "mainnet" && network !== "testnet") {
        return { ok: false, message: `Unsupported NEAR network: ${network}` }
    }
    if (publicKey.length !== 32) {
        return { ok: false, message: "near proof has an invalid public key" }
    }

    const refused = {
        ok: false as const,
        message: `Could not confirm that the key is a full-access key of ${accountId}`,
    }

    try {
        const res = await fetch(nearRpcUrl(network), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: "demos",
                method: "query",
                params: {
                    request_type: "view_access_key",
                    finality: "final",
                    account_id: accountId,
                    public_key: `ed25519:${bs58.encode(publicKey)}`,
                },
            }),
            signal: AbortSignal.timeout(NEAR_RPC_TIMEOUT_MS),
        })
        if (!res.ok) return refused
        const body = (await res.json()) as {
            error?: unknown
            result?: { permission?: unknown; error?: unknown }
        }
        // Older RPC nodes report an unknown key as `result.error` with a 200.
        if (body?.error || body?.result?.error) return refused
        return body?.result?.permission === "FullAccess" ? { ok: true } : refused
    } catch {
        return refused
    }
}
