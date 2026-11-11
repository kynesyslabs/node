import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/features/staking/nftAllowlist", () => ({
    __esModule: true,
    isAllowlistedMint: jest.fn((mint: string) => mint !== "3BadMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
}))

const verifyNftProof = jest.fn(async () => ({ status: "valid", slot: 1 }))
const verifyCurrentOwner = jest.fn(async () => ({ status: "valid", slot: 1 }))
jest.mock("@/features/staking/solanaProof", () => ({
    __esModule: true,
    verifyNftProof,
    verifyCurrentOwner,
}))

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { networkParameters: { minValidatorStake: "1000" } },
}))

import { seededNftReasons, verifySeededNfts } from "@/features/staking/seedNft"

const MINT = "7M7TxyCHoX3jmUNh68QxWWnUSbxJwEUTJoN5dHxTctGH"
const MINT2 = "2edqWDWbFkTjkcTb4zzj3PwQBHJeXbFuiAynm4bj46yP"
const OWNER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"

const row = (over: Record<string, unknown> = {}) => ({
    address: "0x" + "a".repeat(64),
    status: "2",
    staked_amount: "1000",
    nft_mint: MINT,
    nft_owner: OWNER,
    nft_proof_tx: SIG,
    ...over,
})

describe("a seeded validator set under NFT gating", () => {
    it("passes when every seat carries an allowlisted, unique NFT and the minimum stake", () => {
        expect(seededNftReasons([row(), row({ address: "0x" + "b".repeat(64), nft_mint: MINT2 })], "g")).toEqual([])
    })

    it("seats an nft_exempt row without NFT fields, still held to the minimum stake", () => {
        const exempt = { address: "0x" + "c".repeat(64), status: "2", staked_amount: "1000", nft_exempt: true }
        expect(seededNftReasons([row(), exempt], "g")).toEqual([])
        expect(seededNftReasons([{ ...exempt, staked_amount: "999" }], "g")[0]).toContain("below the minimum")
        expect(seededNftReasons([{ ...exempt, nft_mint: null, nft_owner: null, nft_proof_tx: null }], "g")).toEqual([])
    })

    it("refuses an nft_exempt row that also carries NFT fields, and a non-boolean flag", () => {
        expect(seededNftReasons([row({ nft_exempt: true })], "g")[0]).toContain("nft_exempt rows carry no nft_mint")
        expect(seededNftReasons([row({ nft_exempt: "yes" })], "g")[0]).toContain("nft_exempt must be a boolean")
        expect(seededNftReasons([row({ nft_mint: null, nft_exempt: false })], "g")[0]).toContain("nft_mint")
    })

    it("an exempt row does not reserve a mint, so another row may hold it", () => {
        const exempt = { address: "0x" + "c".repeat(64), status: "2", staked_amount: "1000", nft_exempt: true }
        expect(seededNftReasons([exempt, row()], "g")).toEqual([])
    })

    it("names the row missing a proof field", () => {
        expect(seededNftReasons([row({ nft_proof_tx: null })], "g")[0]).toContain("nft_proof_tx")
    })

    it("refuses a mint off the allowlist", () => {
        expect(seededNftReasons([row({ nft_mint: "3BadMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })], "g")[0]).toContain("allowlist")
    })

    it("refuses one mint backing two seats", () => {
        const reasons = seededNftReasons([row(), row({ address: "0x" + "b".repeat(64) })], "g")
        expect(reasons[0]).toContain("already backs")
    })

    it("refuses a stake below the minimum", () => {
        expect(seededNftReasons([row({ staked_amount: "999" })], "g")[0]).toContain("below the minimum")
    })

    it("ignores exited rows, which hold no seat", () => {
        expect(seededNftReasons([row({ status: "0", nft_mint: null, nft_owner: null, nft_proof_tx: null })], "g")).toEqual([])
    })
})

describe("a seeded validator set checked against Solana", () => {
    beforeEach(() => {
        verifyNftProof.mockClear()
        verifyCurrentOwner.mockClear()
        verifyNftProof.mockResolvedValue({ status: "valid", slot: 1 })
        verifyCurrentOwner.mockResolvedValue({ status: "valid", slot: 1 })
    })

    it("passes when every proof checks out, with the age bound lifted and no ask about today's owner", async () => {
        await expect(verifySeededNfts([row()], "g")).resolves.toEqual([])
        expect(verifyNftProof).toHaveBeenCalledWith(
            { mint: MINT, owner: OWNER, proofTx: SIG },
            "0x" + "a".repeat(64),
            expect.any(Number),
            Infinity,
        )
        expect(verifyCurrentOwner).not.toHaveBeenCalled()
    })

    it("refuses a proof an endpoint rejects", async () => {
        verifyNftProof.mockResolvedValue({ status: "invalid", reason: "proof memo names 0xbb, not 0xaa" })
        const bad = await verifySeededNfts([row()], "g")
        expect(bad[0]).toContain("NFT proof invalid")
    })

    it("refuses when Solana cannot be reached, and never asks for an exempt or exited row", async () => {
        verifyNftProof.mockResolvedValue({ status: "unreachable", reason: "all endpoints timed out" })
        const down = await verifySeededNfts([row()], "g")
        expect(down[0]).toContain("unreachable")
        verifyNftProof.mockClear()
        const exempt = { address: "0x" + "c".repeat(64), status: "2", staked_amount: "1000", nft_exempt: true }
        const exited = row({ status: "0", nft_mint: null, nft_owner: null, nft_proof_tx: null })
        await expect(verifySeededNfts([exempt, exited], "g")).resolves.toEqual([])
        expect(verifyNftProof).not.toHaveBeenCalled()
    })

    it("stops at the shape rules before touching Solana", async () => {
        const reasons = await verifySeededNfts([row({ staked_amount: "999" })], "g")
        expect(reasons[0]).toContain("below the minimum")
        expect(verifyNftProof).not.toHaveBeenCalled()
    })
})
