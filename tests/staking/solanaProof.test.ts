import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))

const core = { validatorNftRequired: true }
jest.mock("src/config", () => ({
    __esModule: true,
    Config: { getInstance: () => ({ core }) },
}))

// Every read goes through withSolana; the test decides what the chain says.
const reads: Array<(connection: unknown) => Promise<unknown>> = []
const withSolana = jest.fn(async (_what: string, read: (c: unknown) => Promise<unknown>) => {
    reads.push(read)
    return read(connection)
})
class SolanaUnreachableError extends Error {}
jest.mock("@/features/staking/solanaRpc", () => ({
    __esModule: true,
    withSolana,
    SolanaUnreachableError,
}))

import {
    resetSolanaProofCacheForTesting,
    verifyChallengeEvidence,
    verifyProofSupersedes,
    verifyCurrentOwner,
    verifyNftProof,
} from "@/features/staking/solanaProof"

const MINT = "7M7TxyCHoX3jmUNh68QxWWnUSbxJwEUTJoN5dHxTctGH"
const OWNER = "2edqWDWbFkTjkcTb4zzj3PwQBHJeXbFuiAynm4bj46yP"
const BUYER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
const SIG2 = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM9hxRbmg6uMLCpjxvBuHFTaN8wPBaDJVHxuN6Lw6dZZMCt"
const VALIDATOR = "0x" + "a".repeat(64)
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

const key = (s: string) => ({ toBase58: () => s })

function parsedTx(over: {
    slot?: number
    blockTime?: number | null
    err?: unknown
    signers?: string[]
    memos?: string[]
    pre?: Array<[string, string, string]>
    post?: Array<[string, string, string]>
} = {}) {
    const balances = (rows: Array<[string, string, string]> | undefined) =>
        (rows ?? []).map(([mint, owner, amount]) => ({ mint, owner, uiTokenAmount: { amount } }))
    return {
        slot: over.slot ?? 100,
        blockTime: over.blockTime === undefined ? 1_700_000_000 : over.blockTime,
        meta: {
            err: over.err ?? null,
            preTokenBalances: balances(over.pre),
            postTokenBalances: balances(over.post ?? [[MINT, OWNER, "1"]]),
        },
        transaction: {
            message: {
                accountKeys: (over.signers ?? [OWNER]).map(s => ({ pubkey: key(s), signer: true })),
                instructions: (over.memos ?? [`demos-validator:${VALIDATOR}`]).map(memo => ({
                    programId: key(MEMO),
                    parsed: memo,
                })),
            },
        },
    }
}

const connection = {
    getParsedTransaction: jest.fn<(sig: string) => Promise<unknown>>(),
    getParsedTokenAccountsByOwner: jest.fn<() => Promise<unknown>>(),
}

const STAKE_TS = 1_700_000_600_000 // 10 minutes after the proof's block time

beforeEach(() => {
    jest.clearAllMocks()
    reads.length = 0
    resetSolanaProofCacheForTesting()
    connection.getParsedTransaction.mockResolvedValue(parsedTx())
})

describe("verifyNftProof", () => {
    it("accepts a finalized self-transfer with the memo naming the validator", async () => {
        const r = await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect(r).toEqual({ status: "valid", slot: 100 })
    })

    it.each([
        ["failed on chain", parsedTx({ err: { InstructionError: [0, "Custom"] } }), "failed"],
        ["not signed by the owner", parsedTx({ signers: [BUYER] }), "not signed"],
        ["NFT not left with the owner", parsedTx({ post: [[MINT, BUYER, "1"]] }), "does not leave"],
        ["no memo", parsedTx({ memos: [] }), "exactly one"],
        ["two memos", parsedTx({ memos: [`demos-validator:${VALIDATOR}`, `demos-validator:${VALIDATOR}`] }), "exactly one"],
        ["memo not an address", parsedTx({ memos: ["demos-validator:hello"] }), "does not name"],
        ["no block time", parsedTx({ blockTime: null }), "no block time"],
    ])("rejects a proof that is %s", async (_label, tx, reason) => {
        connection.getParsedTransaction.mockResolvedValue(tx)
        const r = await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect(r.status).toBe("invalid")
        expect((r as { reason: string }).reason).toContain(reason)
    })

    it("rejects a proof whose memo names another validator", async () => {
        const r = await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, "0x" + "b".repeat(64), STAKE_TS)
        expect(r.status).toBe("invalid")
        expect((r as { reason: string }).reason).toContain("names")
    })

    it("rejects a proof older than the max age or later than the stake", async () => {
        const old = await verifyNftProof(
            { mint: MINT, owner: OWNER, proofTx: SIG },
            VALIDATOR,
            (1_700_000_000 + 86_400 + 1) * 1000,
        )
        expect((old as { reason: string }).reason).toContain("older than")
        const future = await verifyNftProof(
            { mint: MINT, owner: OWNER, proofTx: SIG },
            VALIDATOR,
            (1_700_000_000 - 61) * 1000,
        )
        expect((future as { reason: string }).reason).toContain("later than")
        // A seeded proof is as old as the launch: the age bound can be lifted.
        const ageless = await verifyNftProof(
            { mint: MINT, owner: OWNER, proofTx: SIG },
            VALIDATOR,
            (1_700_000_000 + 86_400 + 1) * 1000,
            Infinity,
        )
        expect(ageless.status).toBe("valid")
    })

    it("reports unreachable, not invalid, when no endpoint answers or the tx is unknown", async () => {
        connection.getParsedTransaction.mockRejectedValue(new SolanaUnreachableError("down"))
        const down = await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect(down.status).toBe("unreachable")

        connection.getParsedTransaction.mockResolvedValue(null)
        const missing = await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect(missing.status).toBe("unreachable")
    })

    it("caches a verdict by signature and never caches unreachable", async () => {
        connection.getParsedTransaction.mockRejectedValueOnce(new Error("timeout"))
        await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect(connection.getParsedTransaction).toHaveBeenCalledTimes(2)
    })

    it("does not serve a cached verdict for the same signature under another mint or owner", async () => {
        expect((await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)).status).toBe("valid")
        const otherMint = await verifyNftProof({ mint: BUYER, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect((otherMint as { reason: string }).reason).toContain("does not leave")
        const otherOwner = await verifyNftProof({ mint: MINT, owner: BUYER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect((otherOwner as { reason: string }).reason).toContain("not signed")
        // A wrong claim cached as invalid must not block the true one.
        expect((await verifyNftProof({ mint: MINT, owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)).status).toBe("valid")
        expect(connection.getParsedTransaction).toHaveBeenCalledTimes(3)
    })

    it("rejects malformed fields before touching the chain", async () => {
        const r = await verifyNftProof({ mint: "0OIl", owner: OWNER, proofTx: SIG }, VALIDATOR, STAKE_TS)
        expect(r.status).toBe("invalid")
        expect(connection.getParsedTransaction).not.toHaveBeenCalled()
    })
})

describe("verifyCurrentOwner", () => {
    it("is valid when the wallet holds one unit of the mint", async () => {
        connection.getParsedTokenAccountsByOwner.mockResolvedValue({
            context: { slot: 7 },
            value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "1" } } } } } }],
        })
        expect(await verifyCurrentOwner(MINT, OWNER)).toEqual({ status: "valid", slot: 7 })
    })

    it("is invalid when the wallet no longer holds it", async () => {
        connection.getParsedTokenAccountsByOwner.mockResolvedValue({ context: { slot: 7 }, value: [] })
        expect((await verifyCurrentOwner(MINT, OWNER)).status).toBe("invalid")
    })

    it("is unreachable on a transport failure", async () => {
        connection.getParsedTokenAccountsByOwner.mockRejectedValue(new Error("429"))
        expect((await verifyCurrentOwner(MINT, OWNER)).status).toBe("unreachable")
    })
})

describe("verifyChallengeEvidence", () => {
    const recorded = { mint: MINT, owner: OWNER, proofTx: SIG }

    function chain(proof: unknown, evidence: unknown) {
        connection.getParsedTransaction.mockImplementation(async (sig: string) =>
            sig === SIG ? proof : sig === SIG2 ? evidence : null,
        )
    }

    it("accepts a later finalized transfer that moves the NFT out of the recorded wallet", async () => {
        chain(parsedTx({ slot: 100 }), parsedTx({ slot: 200, pre: [[MINT, OWNER, "1"]], post: [[MINT, BUYER, "1"]], signers: [OWNER], memos: [] }))
        expect(await verifyChallengeEvidence(SIG2, recorded)).toEqual({ status: "valid", slot: 200 })
    })

    it("rejects evidence from before the proof", async () => {
        chain(parsedTx({ slot: 300 }), parsedTx({ slot: 200, pre: [[MINT, OWNER, "1"]], post: [[MINT, BUYER, "1"]], memos: [] }))
        expect((await verifyChallengeEvidence(SIG2, recorded)).status).toBe("invalid")
    })

    it("rejects a transfer that does not move this NFT out of this wallet", async () => {
        chain(parsedTx({ slot: 100 }), parsedTx({ slot: 200, pre: [[MINT, OWNER, "1"]], post: [[MINT, OWNER, "1"]], memos: [] }))
        expect((await verifyChallengeEvidence(SIG2, recorded)).status).toBe("invalid")
    })

    it("is unreachable when either transaction cannot be fetched", async () => {
        chain(null, parsedTx({ slot: 200 }))
        expect((await verifyChallengeEvidence(SIG2, recorded)).status).toBe("unreachable")
    })
})

describe("verifyProofSupersedes", () => {
    it("is valid only when the new proof's slot is later than the recorded proof's", async () => {
        connection.getParsedTransaction.mockResolvedValue(parsedTx({ slot: 100 }))
        expect(await verifyProofSupersedes(101, SIG)).toEqual({ status: "valid", slot: 101 })
        expect((await verifyProofSupersedes(100, SIG)).status).toBe("invalid")
    })

    it("is unreachable when the recorded proof cannot be fetched, invalid when it is not base58", async () => {
        connection.getParsedTransaction.mockResolvedValue(null)
        expect((await verifyProofSupersedes(5, SIG)).status).toBe("unreachable")
        expect((await verifyProofSupersedes(5, "not-a-signature")).status).toBe("invalid")
    })
})
