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

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn() },
}))

import Chain from "@/libs/blockchain/chain"
import {
    UNSTAKE_LOCK_BLOCKS,
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "@/features/staking/constants"

let GCRValidatorStakeRoutines: typeof import("@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines").default

beforeAll(async () => {
    GCRValidatorStakeRoutines = (
        await import("@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines")
    ).default
})

// ---------- helpers ----------

interface FakeRow {
    address: string | null
    status: string | null
    connection_url: string | null
    staked_amount: string | null
    first_seen: number | null
    valid_at: number | null
    unstake_requested_at: number | null
    unstake_available_at: number | null
}

function createMockRepo(seed: FakeRow | null = null) {
    const store: FakeRow | null = seed ? { ...seed } : null
    const state = { row: store }
    return {
        state,
        findOneBy: jest.fn(async ({ address }: { address: string }) =>
            state.row && state.row.address === address ? state.row : null,
        ),
        save: jest.fn(async (row: FakeRow) => {
            state.row = { ...row }
            return state.row
        }),
        create: jest.fn((row: FakeRow) => ({ ...row })),
    }
}

function validatorRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
        address: "aabbcc",
        status: VALIDATOR_STATUS_ACTIVE,
        connection_url: "https://v1.example",
        staked_amount: "10000000000000000000000000",
        first_seen: 10,
        valid_at: 10,
        unstake_requested_at: null,
        unstake_available_at: null,
        ...overrides,
    }
}

function stakeEdit(overrides: Record<string, unknown> = {}) {
    return {
        type: "validatorStake",
        isRollback: false,
        account: "aabbcc",
        operation: "stake",
        amount: "10000000000000000000000000",
        connectionUrl: "https://v1.example",
        txhash: "0xtxstake",
        ...overrides,
    }
}

// ---------- tests ----------

describe("GCRValidatorStakeRoutines", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(100 as never)
    })

    it("rejects an edit that is not a validatorStake", async () => {
        const repo = createMockRepo(null)
        const r = await GCRValidatorStakeRoutines.apply(
            { type: "balance" } as any,
            repo as any,
            100,
        )
        expect(r.success).toBe(false)
        expect(r.message).toContain("Invalid GCREdit type")
    })

    describe("stake", () => {
        it("creates a new validator row with the supplied amount", async () => {
            const repo = createMockRepo(null)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit() as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(true)
            expect(repo.save).toHaveBeenCalledTimes(1)
            expect(repo.state.row).toMatchObject({
                address: "aabbcc",
                status: VALIDATOR_STATUS_ACTIVE,
                connection_url: "https://v1.example",
                staked_amount: "10000000000000000000000000",
                first_seen: 100,
                valid_at: 100,
                unstake_requested_at: null,
                unstake_available_at: null,
            })
        })

        it("adds to the existing stake on a repeat stake tx", async () => {
            const existing = validatorRow({ staked_amount: "5" })
            const repo = createMockRepo(existing)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ amount: "7" }) as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(true)
            expect(repo.state.row?.staked_amount).toBe("12")
        })

        it("rejects a zero stake amount", async () => {
            const repo = createMockRepo(null)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ amount: "0" }) as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(false)
            expect(r.message).toContain("positive")
        })

        it("rejects a non-numeric stake amount", async () => {
            const repo = createMockRepo(null)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ amount: "banana" }) as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(false)
            expect(r.message).toContain("Invalid stake amount")
        })

        it("re-activates an UNSTAKING validator on top-up and clears the unstake window", async () => {
            // Restake of an unstaking validator must reset to ACTIVE and
            // clear unstake_*_at — otherwise an attacker could top up
            // freshly-added stake and exit using the old (already-elapsed)
            // lock window, bypassing the safety period for the new stake.
            const existing = validatorRow({
                status: VALIDATOR_STATUS_UNSTAKING,
                staked_amount: "10",
                unstake_requested_at: 50,
                unstake_available_at: 1050,
            } as any)
            const repo = createMockRepo(existing)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ amount: "3" }) as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(true)
            expect(repo.state.row?.status).toBe(VALIDATOR_STATUS_ACTIVE)
            expect(repo.state.row?.staked_amount).toBe("13")
            expect(repo.state.row?.unstake_requested_at).toBeNull()
            expect(repo.state.row?.unstake_available_at).toBeNull()
        })
    })

    describe("unstake", () => {
        it("arms the lock period and flips status to UNSTAKING", async () => {
            const existing = validatorRow()
            const repo = createMockRepo(existing)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ operation: "unstake", amount: "0" }) as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(true)
            expect(repo.state.row?.status).toBe(VALIDATOR_STATUS_UNSTAKING)
            expect(repo.state.row?.unstake_requested_at).toBe(100)
            expect(repo.state.row?.unstake_available_at).toBe(
                100 + UNSTAKE_LOCK_BLOCKS,
            )
        })

        it("fails when the validator row does not exist", async () => {
            const repo = createMockRepo(null)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ operation: "unstake", amount: "0" }) as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(false)
            expect(r.message).toContain("not found")
        })
    })

    describe("exit", () => {
        it("zeros out the stake and sets status to EXITED", async () => {
            const existing = validatorRow({
                status: VALIDATOR_STATUS_UNSTAKING,
                staked_amount: "100",
                unstake_requested_at: 10,
                unstake_available_at: 10 + UNSTAKE_LOCK_BLOCKS,
            })
            const repo = createMockRepo(existing)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ operation: "exit", amount: "0" }) as any,
                repo as any,
                10 + UNSTAKE_LOCK_BLOCKS,
            )
            expect(r.success).toBe(true)
            expect(repo.state.row?.status).toBe(VALIDATOR_STATUS_EXITED)
            expect(repo.state.row?.staked_amount).toBe("0")
        })
    })

    describe("rollback inversion", () => {
        it("rolls back a stake by exiting the validator", async () => {
            const existing = validatorRow({ staked_amount: "50" })
            const repo = createMockRepo(existing)
            const r = await GCRValidatorStakeRoutines.apply(
                stakeEdit({ isRollback: true }) as any,
                repo as any,
                100,
            )
            expect(r.success).toBe(true)
            expect(repo.state.row?.status).toBe(VALIDATOR_STATUS_EXITED)
            expect(repo.state.row?.staked_amount).toBe("0")
        })
    })
})
