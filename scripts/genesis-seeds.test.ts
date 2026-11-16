import { describe, expect, it } from "bun:test"

import { parseSelection, seedRow } from "./genesis-seeds"

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
    it("is a genesis validator row with no DEM and no connection url", () => {
        expect(seedRow("0xab", "M", "O", "S")).toEqual({
            address: "0xab",
            status: "2",
            connection_url: null,
            staked_amount: "0",
            first_seen: 0,
            valid_at: 0,
            nft_mint: "M",
            nft_owner: "O",
            nft_proof_tx: "S",
        })
    })
})
