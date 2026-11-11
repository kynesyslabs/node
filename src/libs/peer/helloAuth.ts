export const HELLO_AUTH_DOMAIN = "DEMOS_PEER_AUTH_V1"
const HELLO_OMNI_DOMAIN = "DEMOS_PEER_OMNI_V1"

/**
 * Message a node signs in its hello reply: bound to the caller's nonce so it
 * cannot be replayed, and to the URL the node advertises so the caller can
 * check it matches the URL it dialed.
 */
export function helloResponseMessage(nonce: string, url: string): Uint8Array {
    return new TextEncoder().encode(`${HELLO_AUTH_DOMAIN}:${nonce}:${url}`)
}

/**
 * Message a node signs over the Omni port in its hello reply. The port is
 * signed apart from helloResponseMessage, which rc.7 nodes verify as is,
 * under its own domain so neither signature can stand in for the other.
 */
export function helloOmniAdvertMessage(
    nonce: string,
    url: string,
    port: number,
): Uint8Array {
    return new TextEncoder().encode(
        `${HELLO_OMNI_DOMAIN}:${nonce}:${url}:${port}`,
    )
}

/** Prefix of addPeer's refusal when another identity holds the URL. */
export const URL_BOUND_TO_OTHER = "URL already bound to another identity: "
