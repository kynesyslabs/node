import ipaddr from "ipaddr.js"

const PROXY_HEADERS = [
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "forwarded",
]

function isLoopback(address: string | undefined): boolean {
    if (!address) return false
    try {
        return ipaddr.process(address).range() === "loopback"
    } catch {
        return false
    }
}

export interface OperatorAuthInput {
    /** Auth context the rate limiter attached after verifying the signature. */
    auth: { verified: boolean; publicKey: string | null }
    /** The node's configured sudo public key, if any. */
    sudoPubkey: string | null | undefined
    /** Address of the TCP peer (not any forwarded header). */
    socketAddress: string | undefined
    headers: Headers
}

/**
 * Whether a request may use an operator-only GET endpoint: signed by the
 * sudo key, the same credential the JSON-RPC operator methods require, or
 * made from the node's own host.
 *
 * A request that carries proxy headers is never treated as local: a reverse
 * proxy on the same host connects over loopback for every public client, so
 * the socket address alone would hand the endpoint to the whole internet.
 */
export function isOperatorRequest(input: OperatorAuthInput): boolean {
    const { auth, sudoPubkey, socketAddress, headers } = input

    if (auth.verified && auth.publicKey && sudoPubkey) {
        const sender = auth.publicKey.includes(":")
            ? auth.publicKey.split(":")[1]
            : auth.publicKey
        if (sender === sudoPubkey) return true
    }

    if (PROXY_HEADERS.some(h => headers.has(h))) return false
    return isLoopback(socketAddress)
}
