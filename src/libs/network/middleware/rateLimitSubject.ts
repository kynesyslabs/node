import ipaddr from "ipaddr.js"

/**
 * What a client is counted as. An IPv6 customer is routinely handed a whole
 * /64, so counting each address separately would give one client as many
 * quotas as it has addresses; every address in a /64 shares one.
 */
export function rateLimitSubject(ip: string): string {
    if (!ip.includes(":")) return ip
    try {
        const parsed = ipaddr.parse(ip)
        if (parsed.kind() !== "ipv6") return ip
        const v6 = parsed as ipaddr.IPv6
        if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().toString()
        const network = ipaddr.IPv6.networkAddressFromCIDR(`${ip}/64`)
        return `${network.toRFC5952String()}/64`
    } catch {
        return ip
    }
}
