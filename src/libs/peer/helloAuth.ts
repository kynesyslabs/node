export const HELLO_AUTH_DOMAIN = "DEMOS_PEER_AUTH_V1"

/**
 * Message a node signs in its hello reply: bound to the caller's nonce so it
 * cannot be replayed, and to the URL the node advertises so the caller can
 * check it matches the URL it dialed.
 */
export function helloResponseMessage(nonce: string, url: string): Uint8Array {
    return new TextEncoder().encode(`${HELLO_AUTH_DOMAIN}:${nonce}:${url}`)
}

/** Prefix of addPeer's refusal when another identity holds the URL. */
export const URL_BOUND_TO_OTHER = "URL already bound to another identity: "
