/**
 * isPublicAddress is the address check behind the web2 proxy and the
 * TLSNotary relay, so its range edges are pinned here.
 */

import { describe, expect, it } from "bun:test"
import { isPublicAddress } from "./outboundAddress"

describe("isPublicAddress", () => {
    it.each([
        "0.0.0.0",
        "10.0.0.0",
        "10.255.255.255",
        "100.64.0.0",
        "100.127.255.255",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.0",
        "172.31.255.255",
        "192.0.0.1",
        "192.0.2.1",
        "192.168.255.255",
        "198.18.0.0",
        "198.19.255.255",
        "198.51.100.1",
        "203.0.113.255",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "64:ff9b::7f00:1",
        "64:ff9b:1::1",
        "100::1",
        "2001::1",
        "2001:db8::1",
        "2002:7f00:1::",
        "fc00::",
        "fdff:ffff::1",
        "fe80::",
        "febf::1",
        "fec0::1",
        "ff02::1",
        "[::1]",
    ])("blocks %s", addr => {
        expect(isPublicAddress(addr)).toBe(false)
    })

    it.each(["::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:10.0.0.1]", "::ffff:169.254.169.254"])(
        "judges the IPv4-mapped form %s by its IPv4 address",
        addr => {
            expect(isPublicAddress(addr)).toBe(false)
        },
    )

    it.each([
        "1.1.1.1",
        "100.63.255.255",
        "100.128.0.0",
        "172.15.255.255",
        "172.32.0.1",
        "198.17.255.255",
        "198.20.0.0",
        "198.51.101.1",
        "203.0.114.1",
        "223.255.255.255",
        "::ffff:8.8.8.8",
        "2001:4860:4860::8888",
        "[2606:4700::1111]",
    ])("allows %s", addr => {
        expect(isPublicAddress(addr)).toBe(true)
    })

    it.each(["", "example.com", "localhost", "127.1", "1.2.3.4.5"])(
        "treats the non-literal %p as not public",
        addr => {
            expect(isPublicAddress(addr)).toBe(false)
        },
    )
})
