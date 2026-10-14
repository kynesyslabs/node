/**
 * Loopback recognition against the spellings a hostile peer URL can use.
 *
 * isLoopbackHost decides which advertised URLs are not an identity and which
 * peer URLs point back at the node itself, so a spelling it misses is a way to
 * name this machine without being recognised as doing so. Callers hand it the
 * hostname the URL parser produced, so most exotic spellings are normalised
 * before it sees them; the tests go through the parser the way the callers do.
 */

import { describe, expect, it } from "bun:test"
import { isLoopbackHost, parseNodeUrl, validateExposedUrl } from "./nodeUrl"

const viaUrl = (host: string): boolean => {
    const url = parseNodeUrl(`http://${host}:53550`)
    return url !== null && isLoopbackHost(url.hostname)
}

describe("loopback spellings a peer URL can carry", () => {
    it.each([
        "localhost",
        "LocalHost",
        "127.0.0.1",
        "127.1",
        "127.0.1",
        "0177.0.0.1",
        "0x7f.0.0.1",
        "0x7f000001",
        "2130706433",
        "017700000001",
        "127.255.255.254",
        "[::1]",
        "[0:0:0:0:0:0:0:1]",
        "[0000:0000:0000:0000:0000:0000:0000:0001]",
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "[::ffff:7F00:0001]",
        "[::ffff:127.1.2.3]",
        "0.0.0.0",
        "0",
        "[::]",
        "[0:0:0:0:0:0:0:0]",
        "localhost.",
        "LOCALHOST.",
        "foo.localhost",
        "a.b.localhost.",
    ])("%s names this machine", host => {
        expect(viaUrl(host)).toBe(true)
    })

    it.each([
        "node-a.example.org",
        "128.0.0.1",
        "126.255.255.255",
        "1.1.1.1",
        "[::ffff:10.0.0.1]",
        "[::ffff:808:808]",
        "[2001:db8::1]",
        "localhost.example.org",
        "notlocalhost",
        "localhostx",
        "xlocalhost",
        "127.0.0.1.example.org",
        "[::2]",
        "[fe80::1]",
    ])("%s does not", host => {
        expect(viaUrl(host)).toBe(false)
    })
})

describe("isLoopbackHost on a raw string", () => {
    it.each([
        [" 127.0.0.1 "],
        ["127.0.0.1\n"],
        ["[::1]\t"],
        ["::1%lo"],
        ["[::1%lo]"],
        ["localhost."],
        ["::"],
        ["[::]"],
        ["::FFFF:7F00:0001"],
        ["::ffff:127.0.0.1"],
        ["0:0:0:0:0:0:0:1"],
    ])("%j is loopback or unspecified", host => {
        expect(isLoopbackHost(host)).toBe(true)
    })

    it.each([
        [""],
        ["   "],
        ["."],
        ["::2"],
        ["fe80::1%lo"],
        ["1.2.3.4"],
        ["127.0.0.1.evil.com"],
        ["x127.0.0.1"],
        ["127.0.0.1x"],
        ["localhost:80"],
        ["::ffff:127.1"],
    ])("%j is not", host => {
        expect(isLoopbackHost(host)).toBe(false)
    })

    it("does not throw on non-string input", () => {
        for (const bad of [undefined, null, 5, {}, []]) {
            expect(() => isLoopbackHost(bad as any)).not.toThrow()
            expect(isLoopbackHost(bad as any)).toBe(false)
        }
    })
})

describe("validateExposedUrl under PROD", () => {
    it.each(["localhost.", "foo.localhost", "[::]", "[0:0:0:0:0:0:0:1]", "0177.0.0.1", "127.1", "[::ffff:7f00:1]"])(
        "refuses %s as the advertised host",
        host => {
            expect(() => validateExposedUrl(`http://${host}:53550`, true, 53550)).toThrow(/loopback/)
        },
    )
})

describe("isLoopbackHost on hostile length", () => {
    // The quadratic cases for the patterns this replaced: a long run of the
    // character a pattern repeats, ending in one that makes it fail.
    const hostile = [
        "." .repeat(100_000) + "x",
        "x" + ".".repeat(100_000) + "x",
        "%".repeat(100_000) + "x",
        "[".repeat(100_000),
        "]".repeat(100_000),
        "127." + "1.".repeat(50_000),
        "::ffff:" + "7f".repeat(50_000),
        "a".repeat(100_000) + ".localhost.",
        ":".repeat(100_000),
        " ".repeat(100_000) + "127.0.0.1",
    ]

    it.each(hostile.map((h, i) => [i, h]))("input %p returns quickly", (_i, input) => {
        const start = performance.now()
        isLoopbackHost(input as string)
        expect(performance.now() - start).toBeLessThan(50)
    })

    it("still answers correctly around the scans", () => {
        expect(isLoopbackHost("[127.1.2.3]")).toBe(true)
        expect(isLoopbackHost("[[::1]]")).toBe(true)
        expect(isLoopbackHost("]")).toBe(false)
        expect(isLoopbackHost("[")).toBe(false)
        expect(isLoopbackHost("....")).toBe(false)
        expect(isLoopbackHost("127.0.0.1....")).toBe(true)
        expect(isLoopbackHost("127.0.0.256x")).toBe(false)
        expect(isLoopbackHost("127.0.0")).toBe(false)
        expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true)
    })
})
