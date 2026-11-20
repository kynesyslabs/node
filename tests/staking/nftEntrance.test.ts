import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

// Entrance and challenge policy with NFT gating on. Solana answers are
// scripted per test; the lifecycle rules themselves are covered in
// validatorsManagement.test.ts.

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn(async () => 100) },
}))

jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorStatus: jest.fn(),
        getAccountBalance: jest.fn(),
        getGCRValidatorByMint: jest.fn(),
        getGCRValidatorsAtBlock: jest.fn(),
    },
}))

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    // A committee of 10 has a floor of 7 active validators
    getSharedState: { shardSize: 10, networkParameters: null, forkConfig: { nftValidatorGating: { activationHeight: 0 } } },
}))

jest.mock("@/libs/blockchain/routines/calculateCurrentGas", () => ({
    __esModule: true,
    calculateFeeBreakdown: jest.fn(async () => ({ total: 2 })),
}))

const allowlisted = new Set<string>()
jest.mock("@/features/staking/nftAllowlist", () => ({
    __esModule: true,
    isAllowlistedMint: jest.fn((mint: string) => allowlisted.has(mint)),
}))

const solana = {
    proof: jest.fn<() => Promise<unknown>>(),
    owner: jest.fn<() => Promise<unknown>>(),
    evidence: jest.fn<() => Promise<unknown>>(),
    order: jest.fn<() => Promise<unknown>>(),
}
jest.mock("@/features/staking/solanaProof", () => ({
    __esModule: true,
    verifyNftProof: (...args: unknown[]) => solana.proof(...(args as [])),
    verifyCurrentOwner: (...args: unknown[]) => solana.owner(...(args as [])),
    verifyChallengeEvidence: (...args: unknown[]) => solana.evidence(...(args as [])),
    verifyProofSupersedes: (...args: unknown[]) => solana.order(...(args as [])),
}))

import GCR from "@/libs/blockchain/gcr/gcr"
import { resetSeatAdmissionForTesting } from "@/features/staking/seatAdmission"
import {
    DEFAULT_MIN_VALIDATOR_STAKE,
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "@/features/staking/constants"

// bun's jest shim has no jest.mocked.
const asMock = (fn: unknown) => fn as { mockResolvedValue: (value: never) => void }

let ValidatorsManagement: typeof import("@/libs/blockchain/routines/validatorsManagement").default
beforeAll(async () => {
    ValidatorsManagement = (await import("@/libs/blockchain/routines/validatorsManagement")).default
})

const SENDER = "a".repeat(64)
const OTHER = "b".repeat(64)
const MINT = "7M7TxyCHoX3jmUNh68QxWWnUSbxJwEUTJoN5dHxTctGH"
const MINT2 = "2edqWDWbFkTjkcTb4zzj3PwQBHJeXbFuiAynm4bj46yP"
const OWNER = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
const SIG2 = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM9hxRbmg6uMLCpjxvBuHFTaN8wPBaDJVHxuN6Lw6dZZMCt"
const MIN = DEFAULT_MIN_VALIDATOR_STAKE.toString()
const nft = { mint: MINT, owner: OWNER, proofTx: SIG }

function stakeTx(payload: Record<string, unknown>) {
    return {
        content: {
            type: "validatorStake",
            from: SENDER,
            from_ed25519_address: SENDER,
            timestamp: 1_700_000_600_000,
            data: ["validatorStake", { amount: "0", connectionUrl: "https://v.example", ...payload }],
        },
        hash: "0xstake",
    } as any
}

function challengeTx(validator: string, evidenceTx = SIG, proofTx = SIG) {
    return {
        content: {
            type: "validatorChallenge",
            from: OTHER,
            from_ed25519_address: OTHER,
            data: ["validatorChallenge", { validator, evidenceTx, proofTx }],
        },
        hash: "0xchallenge",
    } as any
}

const seat = (over: Record<string, unknown> = {}) => ({
    address: SENDER,
    status: VALIDATOR_STATUS_ACTIVE,
    staked_amount: MIN,
    nft_mint: MINT,
    nft_owner: OWNER,
    nft_proof_tx: SIG,
    unstake_requested_at: null,
    unstake_available_at: null,
    ...over,
})

const activeSet = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `v${i}` }))

beforeEach(() => {
    jest.clearAllMocks()
    resetSeatAdmissionForTesting()
    asMock(GCR.getGCRValidatorsAtBlock).mockResolvedValue(activeSet(10) as never)
    allowlisted.clear()
    allowlisted.add(MINT).add(MINT2)
    asMock(GCR.getAccountBalance).mockResolvedValue(BigInt(MIN) * 10n as never)
    asMock(GCR.getGCRValidatorStatus).mockResolvedValue(null as never)
    asMock(GCR.getGCRValidatorByMint).mockResolvedValue(null as never)
    solana.proof.mockResolvedValue({ status: "valid", slot: 10 })
    solana.owner.mockResolvedValue({ status: "valid", slot: 11 })
    solana.evidence.mockResolvedValue({ status: "valid", slot: 12 })
    solana.order.mockResolvedValue({ status: "valid", slot: 10 })
})

describe("taking a seat", () => {
    it("accepts a first stake with a valid, allowlisted, unused proof", async () => {
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(r).toMatchObject({ valid: true })
        expect(solana.proof).toHaveBeenCalledWith(nft, `0x${SENDER}`, 1_700_000_600_000, undefined, {})
        expect(solana.owner).toHaveBeenCalledWith(MINT, OWNER, {})
    })

    it("rejects a first stake without a proof", async () => {
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({}))
        expect(r.valid).toBe(false)
        expect(r.message).toContain("NFT proof is required")
    })

    it("rejects a mint that is not on the allowlist", async () => {
        allowlisted.delete(MINT)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(r.message).toContain("not eligible")
        expect(solana.proof).not.toHaveBeenCalled()
    })

    it("accepts a later proof for a mint backing another seat, naming the eviction", async () => {
        asMock(GCR.getGCRValidatorByMint).mockResolvedValue(seat({ address: OTHER }) as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(r.valid).toBe(true)
        expect(r.message).toContain(`evicts ${OTHER}`)
        expect(solana.order).toHaveBeenCalledWith(10, SIG, {})
    })

    it("rejects a proof not later than the held seat's, and reports its proof unreachable", async () => {
        asMock(GCR.getGCRValidatorByMint).mockResolvedValue(seat({ address: OTHER }) as never)
        solana.order.mockResolvedValue({ status: "invalid", reason: "not later than the seat's proof" })
        const stale = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(stale.valid).toBe(false)
        expect(stale.message).toContain("not later than the seat's proof")

        resetSeatAdmissionForTesting()
        solana.order.mockResolvedValue({ status: "unreachable", reason: "all endpoints down" })
        const down = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(down.valid).toBe(false)
        expect(down.unreachable).toBe(true)
    })

    it("skips the ordering check when the held seat has no proof on record", async () => {
        asMock(GCR.getGCRValidatorByMint).mockResolvedValue(seat({ address: OTHER, nft_proof_tx: null }) as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(r.valid).toBe(true)
        expect(solana.order).not.toHaveBeenCalled()
    })

    it("rejects when the proof fails on chain, and marks an unanswered proof unreachable", async () => {
        solana.proof.mockResolvedValue({ status: "invalid", reason: "memo names another" })
        const bad = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(bad.valid).toBe(false)
        expect(bad.unreachable).toBeUndefined()
        expect(bad.message).toContain("memo names another")

        resetSeatAdmissionForTesting()
        solana.proof.mockResolvedValue({ status: "unreachable", reason: "all endpoints down" })
        const down = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(down.valid).toBe(false)
        expect(down.unreachable).toBe(true)
    })

    it("rejects when the wallet no longer holds the NFT", async () => {
        solana.owner.mockResolvedValue({ status: "invalid", reason: "no longer holds" })
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(r.valid).toBe(false)
        expect(r.message).toContain("no longer holds")
    })

    it("treats re-entry after an exit as taking a seat", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(
            seat({ status: VALIDATOR_STATUS_EXITED, staked_amount: "0" }) as never,
        )
        const without = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({}))
        expect(without.message).toContain("NFT proof is required")
        const withProof = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(withProof.valid).toBe(true)
    })
})

describe("topping up", () => {
    it("needs no proof and skips Solana", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({}))
        expect(r.valid).toBe(true)
        expect(solana.proof).not.toHaveBeenCalled()
    })

    it("refuses any proof, even for the seat's own mint, since it would go unchecked", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(r.valid).toBe(false)
        expect(r.message).toContain("cannot carry an NFT proof")
        expect(solana.proof).not.toHaveBeenCalled()
    })
})

describe("challenging a seat", () => {
    it("accepts evidence that moves the recorded NFT, from any sender", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        const r = await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))
        expect(r.valid).toBe(true)
        expect(solana.evidence).toHaveBeenCalledWith(SIG, { mint: MINT, owner: OWNER, proofTx: SIG }, {})
    })

    it("also applies to a validator that is unstaking", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(
            seat({ status: VALIDATOR_STATUS_UNSTAKING }) as never,
        )
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))).valid).toBe(true)
    })

    it("rejects a target that holds no seat or has no NFT on record", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(null as never)
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))).message).toContain("not found")

        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat({ status: VALIDATOR_STATUS_EXITED }) as never)
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))).message).toContain("no seat")

        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat({ nft_mint: null }) as never)
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))).message).toContain("no NFT on record")
    })

    it("rejects a challenge judged against a proof the seat no longer rests on", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        const r = await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER, SIG, SIG2))
        expect(r.valid).toBe(false)
        expect(r.message).toContain("rests on")
        expect(solana.evidence).not.toHaveBeenCalled()
    })

    it("rejects bad evidence and flags unanswered evidence as unreachable", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        solana.evidence.mockResolvedValue({ status: "invalid", reason: "not later than the proof" })
        const bad = await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))
        expect(bad.valid).toBe(false)
        expect(bad.unreachable).toBeUndefined()

        resetSeatAdmissionForTesting()
        solana.evidence.mockResolvedValue({ status: "unreachable", reason: "down" })
        const down = await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))
        expect(down.unreachable).toBe(true)
    })
})

describe("refused verdicts held at admission", () => {
    it("refuses the same proof for the same validator again without reading Solana", async () => {
        solana.proof.mockResolvedValue({ status: "invalid", reason: "memo names another" })
        const first = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(first.valid).toBe(false)
        solana.proof.mockResolvedValue({ status: "valid", slot: 10 })
        const again = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(again).toEqual({ valid: false, message: first.message })
        expect(solana.proof).toHaveBeenCalledTimes(1)
    })

    it("reads Solana again for another proof", async () => {
        solana.proof.mockResolvedValue({ status: "invalid", reason: "memo names another" })
        await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        solana.proof.mockResolvedValue({ status: "valid", slot: 10 })
        const other = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft: { ...nft, proofTx: SIG2 } }))
        expect(other.valid).toBe(true)
        expect(solana.proof).toHaveBeenCalledTimes(2)
    })

    it("holds a refused ownership check under the proof as well", async () => {
        solana.owner.mockResolvedValue({ status: "invalid", reason: "no longer holds" })
        await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        const again = await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(again.message).toContain("no longer holds")
        expect(solana.proof).toHaveBeenCalledTimes(1)
        expect(solana.owner).toHaveBeenCalledTimes(1)
    })

    it("never holds an unanswered proof: the next attempt reads Solana and can pass", async () => {
        solana.proof.mockResolvedValue({ status: "unreachable", reason: "all endpoints down" })
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))).unreachable).toBe(true)
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))).unreachable).toBe(true)
        solana.proof.mockResolvedValue({ status: "valid", slot: 10 })
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))).valid).toBe(true)
        expect(solana.proof).toHaveBeenCalledTimes(3)
    })

    it("refuses the same challenge again without reading Solana, and never holds unanswered evidence", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        solana.evidence.mockResolvedValue({ status: "invalid", reason: "not later than the proof" })
        const first = await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))
        const again = await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))
        expect(again).toEqual({ valid: false, message: first.message })
        expect(solana.evidence).toHaveBeenCalledTimes(1)

        // Other evidence against the same seat is a new question
        solana.evidence.mockResolvedValue({ status: "unreachable", reason: "down" })
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER, SIG2))).unreachable).toBe(true)
        solana.evidence.mockResolvedValue({ status: "valid", slot: 12 })
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER, SIG2))).valid).toBe(true)
        expect(solana.evidence).toHaveBeenCalledTimes(3)
    })
})

describe("the active-set floor at challenge admission", () => {
    it("refuses a challenge whose eviction would take the active set below the floor, before any Solana read", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        asMock(GCR.getGCRValidatorsAtBlock).mockResolvedValue(activeSet(7) as never)
        const r = await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))
        expect(r).toEqual({ valid: false, message: "Eviction would leave 6 active validators, below the committee floor of 7" })
        expect(solana.evidence).not.toHaveBeenCalled()
        asMock(GCR.getGCRValidatorsAtBlock).mockResolvedValue(activeSet(8) as never)
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))).valid).toBe(true)
    })

    it("admits a challenge to an unstaking seat at the floor, which leaves the active set alone", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat({ status: VALIDATOR_STATUS_UNSTAKING }) as never)
        asMock(GCR.getGCRValidatorsAtBlock).mockResolvedValue(activeSet(7) as never)
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))).valid).toBe(true)
    })
})

describe("the merge re-judge reads fresh", () => {
    const fresh = { fresh: true }

    it("passes { fresh: true } to every Solana read of a stake", async () => {
        asMock(GCR.getGCRValidatorByMint).mockResolvedValue(seat({ address: OTHER }) as never)
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }), fresh)).valid).toBe(true)
        expect(solana.proof).toHaveBeenCalledWith(nft, `0x${SENDER}`, 1_700_000_600_000, undefined, fresh)
        expect(solana.owner).toHaveBeenCalledWith(MINT, OWNER, fresh)
        expect(solana.order).toHaveBeenCalledWith(10, SIG, fresh)
    })

    it("passes { fresh: true } to the challenge evidence read", async () => {
        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER), fresh)).valid).toBe(true)
        expect(solana.evidence).toHaveBeenCalledWith(SIG, nft, fresh)
    })

    it("admission reads with the cached default", async () => {
        await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))
        expect(solana.owner).toHaveBeenCalledWith(MINT, OWNER, {})
    })

    it("is not short-circuited by a refusal held at admission", async () => {
        solana.owner.mockResolvedValue({ status: "invalid", reason: "no longer holds" })
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }))).valid).toBe(false)
        // The wallet holds the NFT again; peers that did not admit the tx read it so.
        solana.owner.mockResolvedValue({ status: "valid", slot: 11 })
        expect((await ValidatorsManagement.manageValidatorStakeTx(stakeTx({ nft }), fresh)).valid).toBe(true)
        expect(solana.owner).toHaveBeenCalledTimes(2)

        asMock(GCR.getGCRValidatorStatus).mockResolvedValue(seat() as never)
        solana.evidence.mockResolvedValue({ status: "invalid", reason: "not finalized" })
        await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER))
        solana.evidence.mockResolvedValue({ status: "valid", slot: 12 })
        expect((await ValidatorsManagement.manageValidatorChallengeTx(challengeTx(SENDER), fresh)).valid).toBe(true)
        expect(solana.evidence).toHaveBeenCalledTimes(2)
    })
})
