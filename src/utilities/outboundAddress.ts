import dns from "node:dns"
import net from "node:net"

// Addresses a caller must not be able to make the node connect to: its own
// host, the operator's private networks, cloud metadata, and ranges that
// tunnel or translate into those (NAT64, 6to4, Teredo).
const V4_BLOCKED: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
]
const V6_BLOCKED: Array<[string, number]> = [
    ["::", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
]

const blocked = new net.BlockList()
for (const [addr, prefix] of V4_BLOCKED) blocked.addSubnet(addr, prefix, "ipv4")
for (const [addr, prefix] of V6_BLOCKED) blocked.addSubnet(addr, prefix, "ipv6")

/**
 * True for a routable public IP literal. Anything that is not an IP literal
 * is false. IPv4-mapped IPv6 forms are judged by the IPv4 address they carry.
 */
export function isPublicAddress(address: string): boolean {
    const bare = address.replace(/^\[(.*)\]$/, "$1")
    const family = net.isIP(bare)
    if (family === 0) return false
    return !blocked.check(bare, family === 6 ? "ipv6" : "ipv4")
}

export class DisallowedAddressError extends Error {
    readonly code = "EDISALLOWEDADDR"
    constructor(host: string) {
        super(
            `Target ${host} resolves to a private, loopback or link-local address`,
        )
        this.name = "DisallowedAddressError"
    }
}

type LookupAll = (
    hostname: string,
    cb: (err: Error | null, addresses: dns.LookupAddress[]) => void,
) => void

const systemLookupAll: LookupAll = (hostname, cb) =>
    dns.lookup(hostname, { all: true }, cb)

/**
 * A `lookup` for http(s) agents and sockets that refuses a host when any of
 * its addresses is not public. The socket connects to the address checked
 * here, so a DNS answer that changes between a check and the connection
 * (rebinding) cannot slip a private address through.
 */
export function makePublicOnlyLookup(
    resolveAll: LookupAll = systemLookupAll,
): net.LookupFunction {
    return function publicOnlyLookup(
        hostname: string,
        options: unknown,
        callback?: (...args: unknown[]) => void,
    ): void {
        const cb = (
            typeof options === "function" ? options : callback
        ) as (...args: unknown[]) => void
        const wantAll =
            typeof options === "object" &&
            options !== null &&
            (options as { all?: boolean }).all === true

        resolveAll(hostname, (err, addresses) => {
            if (err) return cb(err)
            if (
                !addresses?.length ||
                addresses.some(a => !isPublicAddress(a.address))
            ) {
                return cb(new DisallowedAddressError(hostname))
            }
            if (wantAll) return cb(null, addresses)
            cb(null, addresses[0].address, addresses[0].family)
        })
    } as net.LookupFunction
}

export const publicOnlyLookup = makePublicOnlyLookup()

/**
 * Resolve `host` once and return an address to connect to, refusing the host
 * when any of its addresses is not public. Callers connect to the returned
 * address, never to the name again.
 */
export async function resolvePublicAddress(
    host: string,
    resolveAll: LookupAll = systemLookupAll,
): Promise<string> {
    const bare = host.replace(/^\[(.*)\]$/, "$1")
    if (net.isIP(bare)) {
        if (!isPublicAddress(bare)) throw new DisallowedAddressError(host)
        return bare
    }
    const addresses = await new Promise<dns.LookupAddress[]>(
        (resolve, reject) =>
            resolveAll(bare, (err, all) => (err ? reject(err) : resolve(all))),
    )
    if (!addresses?.length || addresses.some(a => !isPublicAddress(a.address))) {
        throw new DisallowedAddressError(host)
    }
    return addresses[0].address
}
