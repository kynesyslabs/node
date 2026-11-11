import { parseNodeUrl } from "src/config"

export const HELLO_AUTH_DOMAIN = "DEMOS_PEER_AUTH_V1"

/**
 * Message a node signs in its hello reply: bound to the caller's nonce so it
 * cannot be replayed, and to the URL the node advertises so the caller can
 * check it matches the URL it dialed. A standby reply signs a different
 * message, so the flag can be neither stripped nor added in transit; a
 * signing node keeps the message older nodes verify.
 */
export function helloResponseMessage(
    nonce: string,
    url: string,
    standby = false,
): Uint8Array {
    const base = `${HELLO_AUTH_DOMAIN}:${nonce}:${url}`
    return new TextEncoder().encode(standby ? `${base}:standby` : base)
}

/** Prefix of addPeer's refusal when another identity holds the URL. */
export const URL_BOUND_TO_OTHER = "URL already bound to another identity: "

/**
 * A copy of a key that stopped signing still syncs and says hello, but the
 * key's consensus calls must keep going to the copy that signs: a standby
 * claim never moves a known identity to another URL.
 */
export function standbyKeepsKnownUrl(
    knownUrl: string | undefined,
    claimedUrl: string,
    standby: unknown,
): boolean {
    if (standby !== true || knownUrl === undefined) return false
    return parseNodeUrl(knownUrl)?.origin !== parseNodeUrl(claimedUrl)?.origin
}
