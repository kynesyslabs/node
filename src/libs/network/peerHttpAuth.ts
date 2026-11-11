import Hashing from "src/libs/crypto/hashing"

/**
 * Body-bound HTTP auth. The signature covers the identity, the timestamp and
 * the SHA-256 of the exact body bytes, so captured headers cannot carry
 * another body. The older form (identity and timestamp only) is still what
 * SDK clients send.
 */
export const HTTP_AUTH_DOMAIN = "DEMOS_HTTP_AUTH_V2"

/** Header carrying the hex SHA-256 of the request body the signature covers. */
export const BODY_HASH_HEADER = "body-hash"

/** Methods only the genesis sudo key may call. */
export const SUDO_METHODS: ReadonlySet<string> = new Set([
    "rate-limit/unblock",
    "getCampaignData",
    "awardPoints",
])

/**
 * Methods where the sender identity decides what the request may do: peer
 * methods and the sudo methods. They refuse the older form: its signature
 * leaves the body free, so captured headers could carry any body for that
 * identity.
 */
export const BODY_BOUND_METHODS: ReadonlySet<string> = new Set([
    "hello_peer",
    "mempool",
    "consensus_routine",
    ...SUDO_METHODS,
])

let lastAuthTimestamp = 0

/**
 * A timestamp for a body-bound signature, strictly increasing within this
 * process. Two identical requests in the same millisecond would otherwise
 * carry the same signed message, and the receiver refuses the second as a
 * replay.
 */
export function nextAuthTimestamp(now = Date.now()): number {
    lastAuthTimestamp = Math.max(now, lastAuthTimestamp + 1)
    return lastAuthTimestamp
}

/**
 * The headers of a body-bound request. `body` must be sent as these exact
 * bytes; `sign` signs with the key `identity` ("algorithm:publicKeyHex")
 * names.
 */
export async function bodyBoundAuthHeaders(params: {
    genesisHash: string
    identity: string
    body: string
    sign: (message: Uint8Array) => Promise<Uint8Array>
    timestamp?: number
}): Promise<Record<string, string>> {
    const timestamp = params.timestamp ?? nextAuthTimestamp()
    const bodyHash = Hashing.sha256(params.body)
    const signature = await params.sign(
        new TextEncoder().encode(
            httpAuthMessage(params.genesisHash, params.identity, timestamp, bodyHash),
        ),
    )
    return {
        identity: params.identity,
        signature: Buffer.from(signature).toString("hex"),
        timestamp: String(timestamp),
        [BODY_HASH_HEADER]: bodyHash,
    }
}

/**
 * The genesis hash names the network, so a request captured on one network
 * is refused on another.
 */
export function httpAuthMessage(
    genesisHash: string,
    identity: string,
    timestamp: string | number,
    bodyHash: string,
): string {
    return Hashing.sha256(
        `${HTTP_AUTH_DOMAIN}:${genesisHash}:${identity}:${timestamp}:${bodyHash}`,
    )
}

/** The genesis block hash a node serves, which body-bound signatures name. */
export async function fetchGenesisHash(rpcUrl: string): Promise<string> {
    const res = await fetch(new URL("/genesisBlock", rpcUrl))
    const block = (await res.json().catch(() => null)) as { hash?: unknown } | null
    if (!res.ok || typeof block?.hash !== "string") {
        throw new Error(`${rpcUrl} did not serve its genesis block (HTTP ${res.status})`)
    }
    return block.hash
}
