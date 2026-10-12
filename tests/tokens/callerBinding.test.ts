import { beforeAll, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { lastBlockNumber: 0, lastBlockHash: "" },
}))

jest.mock("@/libs/scripting", () => ({
    __esModule: true,
    HookExecutor: jest.fn(),
    scriptExecutor: {},
    applyMutations: jest.fn(),
    createTransferMutations: jest.fn(() => []),
    createMintMutations: jest.fn(() => []),
    createBurnMutations: jest.fn(() => []),
}))

jest.mock("@/features/incentive/referrals", () => ({
    __esModule: true,
    Referrals: {},
}))

jest.mock("src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: jest.fn(),
}))

let GCRTokenRoutines: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines")["default"]

beforeAll(async () => {
    const mod = await import("src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines")
    GCRTokenRoutines = mod.default
})

const ATTACKER = "0x" + "aa".repeat(32)
const VICTIM = "0x" + "bb".repeat(32)
const TOKEN = "0x" + "cc".repeat(32)

function makeToken() {
    return {
        address: TOKEN,
        ticker: "TST",
        name: "Test",
        decimals: 18,
        paused: false,
        hasScript: false,
        script: null,
        balances: { [VICTIM]: "1000" } as Record<string, string>,
        allowances: {},
        customState: {},
    }
}

function mockRepo(token: any) {
    return {
        findOneBy: jest.fn(async () => token),
        findOne: jest.fn(async () => token),
        save: jest.fn(async (t: any) => t),
        manager: {
            transaction: jest.fn(async (fn: any) =>
                fn({
                    getRepository: () => ({
                        findOne: jest.fn(async () => token),
                        save: jest.fn(async (t: any) => t),
                    }),
                }),
            ),
        },
    } as any
}

function txFrom(sender: string) {
    return { hash: "0xtx", content: { from: sender, timestamp: 1 } } as any
}

function transferEdit(account: string, from: string, to: string) {
    return {
        type: "token",
        operation: "transfer",
        account,
        tokenAddress: TOKEN,
        txhash: "0xtx",
        isRollback: false,
        data: { from, to, amount: "500" },
    } as any
}

describe("GCRTokenRoutines transfer caller binding", () => {
    it.each([true, false])(
        "rejects a transfer whose data.from is not the signer (simulate=%s)",
        async simulate => {
            const token = makeToken()
            const repo = mockRepo(token)
            const result = await GCRTokenRoutines.apply(
                transferEdit(ATTACKER, VICTIM, ATTACKER),
                repo,
                simulate,
                txFrom(ATTACKER),
            )

            expect(result.success).toBe(false)
            expect(token.balances[VICTIM]).toBe("1000")
            expect(token.balances[ATTACKER]).toBeUndefined()
        },
    )

    it.each([true, false])(
        "allows the owner to transfer their own balance (simulate=%s)",
        async simulate => {
            const token = makeToken()
            const repo = mockRepo(token)
            const result = await GCRTokenRoutines.apply(
                transferEdit(VICTIM, VICTIM, ATTACKER),
                repo,
                simulate,
                txFrom(VICTIM),
            )

            expect(result.success).toBe(true)
            expect(token.balances[VICTIM]).toBe("500")
            expect(token.balances[ATTACKER]).toBe("500")
        },
    )

    it("still lets a rollback reverse a legitimate transfer", async () => {
        const token = makeToken()
        token.balances = { [VICTIM]: "500", [ATTACKER]: "500" }
        const repo = mockRepo(token)
        const edit = transferEdit(VICTIM, VICTIM, ATTACKER)
        edit.isRollback = true
        const result = await GCRTokenRoutines.apply(
            edit,
            repo,
            false,
            txFrom(VICTIM),
        )

        expect(result.success).toBe(true)
        expect(token.balances[VICTIM]).toBe("1000")
    })
})

describe("GCRTokenRoutines create caller binding", () => {
    function createEdit(account: string, deployer: string) {
        return {
            type: "token",
            operation: "create",
            account,
            txhash: "0xtx",
            isRollback: false,
            data: {
                tokenAddress: TOKEN,
                tokenData: {
                    metadata: {
                        name: "Test",
                        ticker: "TST",
                        decimals: 18,
                        deployer,
                        deployerNonce: 0,
                        deployedAt: 0,
                        hasScript: false,
                    },
                    state: {
                        totalSupply: "1000",
                        balances: { [deployer]: "1000" },
                        allowances: {},
                        customState: {},
                    },
                    accessControl: { owner: deployer, paused: false, entries: [] },
                    script: null,
                },
            },
        } as any
    }

    it("rejects a create whose deployer is not the signer", async () => {
        const repo = mockRepo(null)
        const result = await GCRTokenRoutines.apply(
            createEdit(ATTACKER, VICTIM),
            repo,
            true,
            txFrom(ATTACKER),
        )
        expect(result.success).toBe(false)
    })

    it("allows a create whose deployer is the signer", async () => {
        const repo = mockRepo(null)
        const result = await GCRTokenRoutines.apply(
            createEdit(ATTACKER, ATTACKER),
            repo,
            true,
            txFrom(ATTACKER),
        )
        expect(result.success).toBe(true)
    })
})
