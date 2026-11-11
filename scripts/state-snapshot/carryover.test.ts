import { describe, expect, it } from "bun:test"

import { launchValidatorRows } from "./carryover"

const id = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")
const entry = (i: number, over: Record<string, unknown> = {}) => ({
    address: id(i),
    status: "2",
    connection_url: `http://v${i}.example:53550`,
    staked_amount: "1000000000000000000",
    first_seen: 0,
    valid_at: 0,
    ...over,
})
const MINT = "7M7TxyCHoX3jmUNh68QxWWnUSbxJwEUTJoN5dHxTctGH"
const OWNER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"

describe("launchValidatorRows", () => {
    it("carries the NFT fields of a launch entry into validators.jsonl", () => {
        const [row] = launchValidatorRows([entry(0, { nft_mint: MINT, nft_owner: OWNER, nft_proof_tx: SIG })])
        expect(row).toMatchObject({ nft_mint: MINT, nft_owner: OWNER, nft_proof_tx: SIG })
        expect(row).not.toHaveProperty("nft_exempt")
    })

    it("writes null NFT fields for an entry without them", () => {
        const [row] = launchValidatorRows({ validators: [entry(0)] })
        expect(row).toMatchObject({ nft_mint: null, nft_owner: null, nft_proof_tx: null })
        expect(JSON.stringify(row)).not.toContain("nft_exempt")
    })

    it("refuses an nft_exempt entry: the exemption is a genesis rule", () => {
        expect(() => launchValidatorRows([entry(0, { nft_exempt: true })])).toThrow("nft_exempt is a genesis rule")
        expect(launchValidatorRows([entry(1, { nft_exempt: false })])[0]).not.toHaveProperty("nft_exempt")
    })

    it("rejects malformed NFT fields", () => {
        expect(() => launchValidatorRows([entry(0, { nft_mint: "" })])).toThrow("nft_mint must be null")
        expect(() => launchValidatorRows([entry(0, { nft_proof_tx: 5 })])).toThrow("nft_proof_tx must be null")
    })
})
