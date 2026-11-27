import { describe, expect, it } from "bun:test"

import { parseSeatUrl, parseSelection, seedRow } from "./genesis-seeds"

describe("parseSelection", () => {
    it("keeps the order given and accepts commas", () => {
        expect(parseSelection("3, 1 2", 3)).toEqual([3, 1, 2])
    })
    it("refuses a number out of range, a repeat, and nothing", () => {
        expect(() => parseSelection("4", 3)).toThrow("between 1 and 3")
        expect(() => parseSelection("1 1", 3)).toThrow("once")
        expect(() => parseSelection(" ", 3)).toThrow("at least one")
    })
})

describe("seedRow", () => {
    it("is a genesis validator row with no DEM, at the seat's URL", () => {
        expect(seedRow("0xab", "M", "O", "S", "https://v1.example:53550")).toEqual({
            address: "0xab",
            status: "2",
            connection_url: "https://v1.example:53550",
            staked_amount: "0",
            first_seen: 0,
            valid_at: 0,
            nft_mint: "M",
            nft_owner: "O",
            nft_proof_tx: "S",
        })
    })
})

describe("parseSeatUrl", () => {
    it("keeps an http(s) URL with a host and drops a trailing slash", () => {
        expect(parseSeatUrl(" https://v1.example:53550/ ", new Set())).toBe("https://v1.example:53550")
        expect(parseSeatUrl("http://10.0.0.5:53550", new Set())).toBe("http://10.0.0.5:53550")
    })
    it("writes the canonical spelling, so equal endpoints compare equal", () => {
        expect(parseSeatUrl("HTTPS://V1.Example:53550", new Set())).toBe("https://v1.example:53550")
        expect(parseSeatUrl("https://v1.example:443/", new Set())).toBe("https://v1.example")
        expect(() => parseSeatUrl("https://V1.example:443", new Set(["https://v1.example"]))).toThrow("another seat")
        expect(() => parseSeatUrl("https://v1.example/?a=1", new Set())).toThrow("query or fragment")
    })
    it("refuses an empty URL, a non-http URL, a bad port and a URL another seat has", () => {
        expect(() => parseSeatUrl("  ", new Set())).toThrow("EXPOSED_URL")
        expect(() => parseSeatUrl("ws://v1.example", new Set())).toThrow("http or https")
        expect(() => parseSeatUrl("https://v1.example:70000", new Set())).toThrow("1-65535")
        expect(() => parseSeatUrl("https://v1.example", new Set(["https://v1.example"]))).toThrow("another seat")
    })
})
