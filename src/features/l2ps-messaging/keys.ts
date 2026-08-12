/**
 * Canonical peer identity for L2PS messaging.
 *
 * External SDKs send the same public key in several equivalent forms — with a
 * `0x`/`0X` prefix or in mixed case. They all denote one peer, so every
 * identity, routing key, and DB lookup normalises through here. Kept in its
 * own module so the server (in-memory peer map) and the service (persistence
 * boundary) can share it without importing each other.
 *
 * NOT for the signed proof: the client signs over its own representation of
 * the key, so proof verification must use the raw form.
 */
export function canonicalizeKey(key: string): string {
    const stripped = key.startsWith("0x") || key.startsWith("0X") ? key.slice(2) : key
    return stripped.toLowerCase()
}
