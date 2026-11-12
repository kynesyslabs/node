import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals"

// NFT gating is off for the legacy lifecycle rules; the NFT suites turn it on.
jest.mock("@/features/staking/nftAllowlist", () => ({
    __esModule: true,
    isAllowlistedMint: jest.fn(() => true),
}))

jest.mock("@/features/staking/solanaProof", () => ({
    __esModule: true,
    verifyNftProof: jest.fn(async () => ({ status: "valid", slot: 1 })),
    verifyCurrentOwner: jest.fn(async () => ({ status: "valid", slot: 1 })),
    verifyChallengeEvidence: jest.fn(async () => ({ status: "valid", slot: 2 })),
}))

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        custom: jest.fn(),
    },
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn() },
}))

// GCR.getGCRValidatorStatus is the external dep we need to control.
jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorStatus: jest.fn(),
        getGCRValidatorByMint: jest.fn(async () => null),
    },
}))

import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import {
    UNSTAKE_LOCK_BLOCKS,
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "@/features/staking/constants"

let ValidatorsManagement: typeof import("@/libs/blockchain/routines/validatorsManagement").default

beforeAll(async () => {
    ValidatorsManagement = (
        await import("@/libs/blockchain/routines/validatorsManagement")
    ).default
})

const SENDER = "deadbeef"
const NFT = { mint: "4".repeat(44), owner: "5".repeat(44), proofTx: "6".repeat(88) }

function stakeTx(amount = "0", connectionUrl = "https://v.example", nft: object | null = NFT) {
    return {
        content: {
            type: "validatorStake",
            from: SENDER,
            from_ed25519_address: SENDER,
            data: ["validatorStake", { amount, connectionUrl, ...(nft && { nft }) }],
        },
        hash: "0xtxstake",
    } as any
}

/** A stake on a held seat: no proof travels with it. */
function topUpTx() {
    return stakeTx("0", "https://v.example", null)
}

function unstakeTx() {
    return {
        content: {
            type: "validatorUnstake",
            from: SENDER,
            from_ed25519_address: SENDER,
            data: ["validatorUnstake", {}],
        },
        hash: "0xtxunstake",
    } as any
}

function exitTx() {
    return {
        content: {
            type: "validatorExit",
            from: SENDER,
            from_ed25519_address: SENDER,
            data: ["validatorExit", {}],
        },
        hash: "0xtxexit",
    } as any
}

describe("ValidatorsManagement.manageValidatorStakeTx", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        jest.mocked(Chain.getLastBlockNumber).mockResolvedValue(100 as never)
    })

    it("accepts a first-time stake of 0 without reading the sender's balance", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx())
        expect(r.valid).toBe(true)
        expect((GCR as unknown as Record<string, unknown>).getAccountBalance).toBeUndefined()
    })

    it("rejects a first-time stake missing connectionUrl", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("0", ""),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("connectionUrl required")
    })

    it("rejects any amount but 0, since weight is a seat and never a number the sender picks", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        for (const amount of ["1", "-1", "1000000000000000000000000000000"]) {
            const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx(amount))
            expect(r.valid).toBe(false)
            expect(r.message).toContain("must be 0")
        }
    })

    it("rejects an unparseable amount", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("banana"),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Invalid stake amount")
    })

    it("allows a re-stake on an already active validator", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: "0",
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(topUpTx())
        expect(r.valid).toBe(true)
    })

    it("allows a top-up on an unstaking validator (top-up does not cancel unstake)", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            staked_amount: "0",
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            topUpTx(),
        )
        expect(r.valid).toBe(true)
    })

    it("treats a stake from an exited validator as a new entrance", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_EXITED,
            staked_amount: "0",
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx("0"))
        expect(r.valid).toBe(true)
        expect(r.message).toContain("entrance")
    })

    // CR-5 regression: stake-increase eligibility is an explicit allow-list
    // (ACTIVE | UNSTAKING). Anything else — null, undefined, or a status
    // string we haven't seen before — must be rejected so a future schema
    // addition cannot silently grant top-up rights.
    it("rejects a stake when existing validator status is null", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: null,
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("not eligible")
    })

    it("rejects a stake when existing validator status is an unknown string", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: "FROZEN",
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("not eligible")
    })

    it("rejects a stake when existing validator status is undefined", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: undefined,
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("not eligible")
    })

    it("rejects when sender is missing", async () => {
        const tx = stakeTx()
        tx.content.from = ""
        tx.content.from_ed25519_address = ""
        const r = await ValidatorsManagement.manageValidatorStakeTx(tx)
        expect(r.valid).toBe(false)
        expect(r.message).toContain("sender")
    })

})

describe("ValidatorsManagement.manageValidatorUnstakeTx", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        jest.mocked(Chain.getLastBlockNumber).mockResolvedValue(100 as never)
    })

    it("accepts an unstake from an active validator with no pending unstake", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            unstake_requested_at: null,
        } as never)
        const r = await ValidatorsManagement.manageValidatorUnstakeTx(
            unstakeTx(),
        )
        expect(r.valid).toBe(true)
    })

    it("rejects an unstake from a non-validator", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorUnstakeTx(
            unstakeTx(),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Not a validator")
    })

    it("rejects an unstake when status is not ACTIVE", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            unstake_requested_at: 50,
        } as never)
        const r = await ValidatorsManagement.manageValidatorUnstakeTx(
            unstakeTx(),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("not active")
    })

    it("rejects a duplicate unstake request", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            unstake_requested_at: 50,
        } as never)
        const r = await ValidatorsManagement.manageValidatorUnstakeTx(
            unstakeTx(),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("already requested")
    })
})

describe("ValidatorsManagement.manageValidatorExitTx", () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it("rejects an exit without a prior unstake request", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            unstake_available_at: null,
        } as never)
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(false)
        expect(r.message).toMatch(/unstaking|validatorUnstake/i)
    })

    it("rejects an exit before the lock has elapsed", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            unstake_requested_at: 10,
            unstake_available_at: 10 + UNSTAKE_LOCK_BLOCKS,
        } as never)
        jest.mocked(Chain.getLastBlockNumber).mockResolvedValue(500 as never)
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Lock not elapsed")
    })

    it("accepts an exit exactly at unstake_available_at", async () => {
        const availableAt = 10 + UNSTAKE_LOCK_BLOCKS
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            unstake_requested_at: 10,
            unstake_available_at: availableAt,
        } as never)
        jest.mocked(Chain.getLastBlockNumber).mockResolvedValue(
            availableAt as never,
        )
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(true)
    })

    it("rejects an exit from a non-validator", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Not a validator")
    })
})
