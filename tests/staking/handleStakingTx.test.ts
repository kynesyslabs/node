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

jest.mock("@/libs/blockchain/routines/validatorsManagement", () => ({
    __esModule: true,
    default: {
        manageValidatorStakeTx: jest.fn(),
        manageValidatorUnstakeTx: jest.fn(),
        manageValidatorExitTx: jest.fn(),
        buildStakeEdit: jest.fn(
            (account: string, amount: string, url: string, txhash: string) => ({
                type: "validatorStake",
                isRollback: false,
                account,
                operation: "stake",
                amount,
                connectionUrl: url,
                txhash,
            }),
        ),
        buildUnstakeEdit: jest.fn((account: string, txhash: string) => ({
            type: "validatorStake",
            isRollback: false,
            account,
            operation: "unstake",
            amount: "0",
            txhash,
        })),
        buildExitEdit: jest.fn((account: string, txhash: string) => ({
            type: "validatorStake",
            isRollback: false,
            account,
            operation: "exit",
            amount: "0",
            txhash,
        })),
    },
}))

import ValidatorsManagement from "@/libs/blockchain/routines/validatorsManagement"

let handleStakingTx: typeof import("@/libs/network/routines/transactions/handleStakingTx").handleStakingTx

beforeAll(async () => {
    ({ handleStakingTx } = await import(
        "@/libs/network/routines/transactions/handleStakingTx"
    ))
})

function tx(type: string) {
    const payload =
        type === "validatorStake"
            ? { amount: "1", connectionUrl: "https://v.example" }
            : {}
    return {
        content: {
            type,
            from: "abc",
            from_ed25519_address: "abc",
            data: [type, payload],
            gcr_edits: [],
        },
        hash: "0xhash",
    } as any
}

describe("handleStakingTx dispatcher", () => {
    beforeEach(() => jest.clearAllMocks())

    it("routes validatorStake to manageValidatorStakeTx", async () => {
        (
            ValidatorsManagement.manageValidatorStakeTx as jest.Mock
        ).mockResolvedValue({ valid: true, message: "ok" } as never)

        const r = await handleStakingTx(tx("validatorStake"))
        expect(r.success).toBe(true)
        expect(r.message).toBe("ok")
        expect(
            ValidatorsManagement.manageValidatorStakeTx,
        ).toHaveBeenCalledTimes(1)
        expect(
            ValidatorsManagement.manageValidatorUnstakeTx,
        ).not.toHaveBeenCalled()
    })

    it("routes validatorUnstake to manageValidatorUnstakeTx", async () => {
        (
            ValidatorsManagement.manageValidatorUnstakeTx as jest.Mock
        ).mockResolvedValue({ valid: true, message: "unstake ok" } as never)

        const r = await handleStakingTx(tx("validatorUnstake"))
        expect(r.success).toBe(true)
        expect(r.message).toBe("unstake ok")
        expect(
            ValidatorsManagement.manageValidatorUnstakeTx,
        ).toHaveBeenCalledTimes(1)
    })

    it("routes validatorExit to manageValidatorExitTx", async () => {
        (
            ValidatorsManagement.manageValidatorExitTx as jest.Mock
        ).mockResolvedValue({ valid: true, message: "exit ok" } as never)

        const r = await handleStakingTx(tx("validatorExit"))
        expect(r.success).toBe(true)
        expect(r.message).toBe("exit ok")
    })

    it("bubbles validation failure from the underlying manager", async () => {
        (
            ValidatorsManagement.manageValidatorStakeTx as jest.Mock
        ).mockResolvedValue({ valid: false, message: "below minimum" } as never)

        const r = await handleStakingTx(tx("validatorStake"))
        expect(r.success).toBe(false)
        expect(r.message).toBe("below minimum")
    })

    it("returns an error for an unknown staking type", async () => {
        const r = await handleStakingTx(tx("validatorBogus"))
        expect(r.success).toBe(false)
        expect(r.message).toContain("Unknown staking tx type")
        expect(
            ValidatorsManagement.manageValidatorStakeTx,
        ).not.toHaveBeenCalled()
    })
})
