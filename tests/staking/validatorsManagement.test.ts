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

// GCR.getGCRValidatorStatus and getAccountBalance are the external deps
// we need to control.
jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorStatus: jest.fn(), getAccountBalance: jest.fn() },
}))

// sharedState pulls in the whole framework (Chain → Peer → SDK/utils);
// substitute a minimal stand-in so validatorsManagement's
// getMinValidatorStake() has something to read.
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { networkParameters: null },
}))

// calculateCurrentGas transitively imports Chain/GCR, which this isolated
// suite cannot resolve. Pin the flat fee breakdown (matches prod:
// networkFee + rpcFee + additionalFee = 1 + 1 + 0).
jest.mock("@/libs/blockchain/routines/calculateCurrentGas", () => ({
    __esModule: true,
    calculateFeeBreakdown: jest.fn(async () => ({
        network_fee: 1,
        rpc_fee: 1,
        additional_fee: 0,
        total: 2,
    })),
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

// Payload amounts ride as bigint-encoded strings; the constant itself is a
// bigint (demToOs result).
const MIN_STAKE = DEFAULT_MIN_VALIDATOR_STAKE.toString()
// Flat fee-breakdown total pinned by the calculateCurrentGas mock above.
const GAS_FEE = 2n

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
        jest.mocked(Chain.getLastBlockNumber).mockResolvedValue(100 as never)
        // Default: balance comfortably covers any stake in these tests.
        jest.mocked(GCR.getAccountBalance).mockResolvedValue(
            (DEFAULT_MIN_VALIDATOR_STAKE * 2n) as never,
        )
    })

    it("accepts a first-time stake at the minimum", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(MIN_STAKE),
        )
        expect(r.valid).toBe(true)
    })

    it("rejects a first-time stake below the minimum", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("1"),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("below minimum")
    })

    it("rejects a first-time stake missing connectionUrl", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(MIN_STAKE, ""),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("connectionUrl required")
    })

    it("rejects a negative or zero amount", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(
            null as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx("0"))
        expect(r.valid).toBe(false)
        expect(r.message).toContain("positive")
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

    it("allows a top-up on an already active validator below the minimum amount", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: DEFAULT_MIN_VALIDATOR_STAKE,
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(stakeTx("1"))
        expect(r.valid).toBe(true)
    })

    it("allows a top-up on an unstaking validator (top-up does not cancel unstake)", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
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
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_EXITED,
        } as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(MIN_STAKE),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("not eligible")
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
            stakeTx(MIN_STAKE),
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
            stakeTx(MIN_STAKE),
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
            stakeTx(MIN_STAKE),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("not eligible")
    })

    it("rejects when sender is missing", async () => {
        const tx = stakeTx(MIN_STAKE)
        tx.content.from = ""
        tx.content.from_ed25519_address = ""
        const r = await ValidatorsManagement.manageValidatorStakeTx(tx)
        expect(r.valid).toBe(false)
        expect(r.message).toContain("sender")
    })

    it("rejects a first-time stake when balance cannot cover stake + gas", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(null as never)
        // Balance equals the stake exactly — gas pushes it over.
        jest.mocked(GCR.getAccountBalance).mockResolvedValue(
            DEFAULT_MIN_VALIDATOR_STAKE as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(MIN_STAKE),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Insufficient balance")
    })

    it("accepts a stake when balance covers stake + gas exactly", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue(null as never)
        jest.mocked(GCR.getAccountBalance).mockResolvedValue(
            (DEFAULT_MIN_VALIDATOR_STAKE + GAS_FEE) as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx(MIN_STAKE),
        )
        expect(r.valid).toBe(true)
    })

    it("rejects a top-up when balance cannot cover the increase + gas", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: MIN_STAKE,
        } as never)
        jest.mocked(GCR.getAccountBalance).mockResolvedValue(50n as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("100"),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Insufficient balance")
    })

    // Double-stake regression: the stake is not debited from the balance,
    // so each increase must be checked against the cumulative staked total —
    // two stakes of 600 against a balance of 1000 must not yield 1200 staked.
    it("rejects a second stake when the cumulative total would exceed the balance", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: "600",
        } as never)
        jest.mocked(GCR.getAccountBalance).mockResolvedValue(1000n as never)
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("600"),
        )
        expect(r.valid).toBe(false)
        expect(r.message).toContain("Insufficient balance")
    })

    it("accepts a top-up when balance covers prior stake + increase + gas exactly", async () => {
        jest.mocked(GCR.getGCRValidatorStatus).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: "600",
        } as never)
        jest.mocked(GCR.getAccountBalance).mockResolvedValue(
            (600n + 300n + GAS_FEE) as never,
        )
        const r = await ValidatorsManagement.manageValidatorStakeTx(
            stakeTx("300"),
        )
        expect(r.valid).toBe(true)
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
