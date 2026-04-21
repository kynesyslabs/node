import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals"

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

// GCR.getGCRValidatorStatus is the one external dep we need to control.
jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorStatus: jest.fn() },
}))

import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import {
    DEFAULT_MIN_VALIDATOR_STAKE,
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

function stakeTx(amount: string, connectionUrl = "https://v.example") {
    return {
        content: {
            type: "validatorStake",
            from: SENDER,
            from_ed25519_address: SENDER,
            data: ["validatorStake", { amount, connectionUrl }],
        },
        hash: "0xtxstake",
    } as any
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
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(100 as never)
    })

    it("accepts a first-time stake at the minimum", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(DEFAULT_MIN_VALIDATOR_STAKE),
        )
        expect(r.valid).toBe(true)
    })

    it("rejects a first-time stake below the minimum", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("1"),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("below minimum")
    })

    it("rejects a first-time stake missing connectionUrl", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(DEFAULT_MIN_VALIDATOR_STAKE, ""),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("connectionUrl required")
    })

    it("rejects a negative or zero amount", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx("0"))
        expect(r.valid).toBe(false)
        expect(r.message).toContain("positive")
    })

    it("rejects an unparseable amount", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("banana"),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Invalid stake amount")
    })

    it("allows a top-up on an already active validator below the minimum amount", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: DEFAULT_MIN_VALIDATOR_STAKE,
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx("1"))
        expect(r.valid).toBe(true)
    })

    it("allows a top-up on an unstaking validator (top-up does not cancel unstake)", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            staked_amount: DEFAULT_MIN_VALIDATOR_STAKE,
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("100"),
        )
        expect(r.valid).toBe(true)
    })

    it("rejects a stake coming from an exited validator", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_EXITED,
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(DEFAULT_MIN_VALIDATOR_STAKE),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("exited")
    })

    it("rejects when sender is missing", async () => {
        const tx = stakeTx(DEFAULT_MIN_VALIDATOR_STAKE)
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
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(100 as never)
    })

    it("accepts an unstake from an active validator with no pending unstake", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
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
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorUnstakeTx(
            unstakeTx(),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Not a validator")
    })

    it("rejects an unstake when status is not ACTIVE", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
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
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
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
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            unstake_available_at: null,
        } as never)
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(false)
        expect(r.message).toContain("validatorUnstake first")
    })

    it("rejects an exit before the lock has elapsed", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            unstake_requested_at: 10,
            unstake_available_at: 10 + UNSTAKE_LOCK_BLOCKS,
        } as never)
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(500 as never)
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Lock not elapsed")
    })

    it("accepts an exit exactly at unstake_available_at", async () => {
        const availableAt = 10 + UNSTAKE_LOCK_BLOCKS
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            unstake_requested_at: 10,
            unstake_available_at: availableAt,
        } as never)
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            availableAt as never,
        )
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(true)
    })

    it("rejects an exit from a non-validator", async () => {
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorExitTx(exitTx())
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Not a validator")
    })
})

describe("ValidatorsManagement edit builders", () => {
    it("buildStakeEdit emits a well-formed GCREditValidatorStake", () => {
        const edit = ValidatorsManagement.buildStakeEdit(
            "abc",
            "42",
            "https://v.example",
            "0xtx",
        )
        expect(edit).toEqual({
            type: "validatorStake",
            isRollback: false,
            account: "abc",
            operation: "stake",
            amount: "42",
            connectionUrl: "https://v.example",
            txhash: "0xtx",
        })
    })

    it("buildUnstakeEdit and buildExitEdit set the correct operation", () => {
        expect(
            ValidatorsManagement.buildUnstakeEdit("abc", "0xtx").operation,
        ).toBe("unstake")
        expect(
            ValidatorsManagement.buildExitEdit("abc", "0xtx").operation,
        ).toBe("exit")
    })
})
