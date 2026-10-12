import { beforeAll, describe, expect, it, jest } from "@jest/globals"

// TOKEN_SCRIPTS_ENABLED=false: script-bearing token edits are rejected at ingress validation
// and at GCR apply, while plain token create and transfer keep working.

const logMock = {
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), warn: jest.fn(), error: jest.fn() },
}
jest.mock("@/utilities/logger", () => logMock)
jest.mock("src/utilities/logger", () => logMock)
jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { lastBlockNumber: 0, lastBlockHash: "", signingAlgorithm: "ed25519" },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { lastBlockNumber: 0, lastBlockHash: "", signingAlgorithm: "ed25519" },
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
jest.mock("@/features/incentive/referrals", () => ({ __esModule: true, Referrals: {} }))
jest.mock("src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
jest.mock("src/libs/blockchain/routines/validateTransaction", () => ({
    __esModule: true,
    confirmTransaction: jest.fn(async () => ({
        data: { valid: true, message: "ok" },
        signature: null,
        rpc_public_key: null,
    })),
}))
jest.mock("@kynesyslabs/demosdk/websdk", () => ({
    __esModule: true,
    // SDK GCRGeneration never produces token edits, so ingress sees only the client's token edits.
    GCRGeneration: { generate: jest.fn(async () => []) },
}))
jest.mock("@/model/entities/GCRv2/GCR_Main", () => ({ __esModule: true, GCRMain: class {} }))

let GCRTokenRoutines: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines")["default"]
let getScriptedTokenEditRejection: typeof import("src/libs/blockchain/gcr/types/token/GCREditToken")["getScriptedTokenEditRejection"]
let handleValidateTransaction: typeof import("src/libs/network/endpointValidation")["handleValidateTransaction"]
let TOKEN_SCRIPTS_ENABLED: boolean

beforeAll(async () => {
    GCRTokenRoutines = (await import("src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines")).default
    const editTypes = await import("src/libs/blockchain/gcr/types/token/GCREditToken")
    getScriptedTokenEditRejection = editTypes.getScriptedTokenEditRejection
    handleValidateTransaction = (await import("src/libs/network/endpointValidation")).handleValidateTransaction
    TOKEN_SCRIPTS_ENABLED = (await import("src/utilities/constants")).TOKEN_SCRIPTS_ENABLED
})

const OWNER = "0x" + "aa".repeat(32)
const OTHER = "0x" + "bb".repeat(32)
const TOKEN = "0x" + "cc".repeat(32)
const SCRIPT = { code: "export const hooks = {}", methods: [] }

function createEdit(opts: { hasScript?: boolean; script?: unknown } = {}) {
    return {
        type: "token",
        operation: "create",
        account: OWNER,
        txhash: "0xtx",
        isRollback: false,
        data: {
            tokenAddress: TOKEN,
            tokenData: {
                metadata: {
                    name: "Test",
                    ticker: "TST",
                    decimals: 18,
                    deployer: OWNER,
                    deployerNonce: 0,
                    deployedAt: 0,
                    hasScript: opts.hasScript ?? false,
                },
                state: { totalSupply: "1000", balances: { [OWNER]: "1000" }, allowances: {}, customState: {} },
                accessControl: { owner: OWNER, paused: false, entries: [] },
                script: opts.script ?? null,
            },
        },
    } as any
}

function upgradeEdit() {
    return {
        type: "token",
        operation: "upgradeScript",
        account: OWNER,
        tokenAddress: TOKEN,
        txhash: "0xtx",
        isRollback: false,
        data: { newScript: SCRIPT },
    } as any
}

function customEdit() {
    return {
        type: "token",
        operation: "custom",
        account: OWNER,
        tokenAddress: TOKEN,
        txhash: "0xtx",
        isRollback: false,
        data: { method: "stake", params: [] },
    } as any
}

function transferEdit() {
    return {
        type: "token",
        operation: "transfer",
        account: OWNER,
        tokenAddress: TOKEN,
        txhash: "0xtx",
        isRollback: false,
        data: { from: OWNER, to: OTHER, amount: "400" },
    } as any
}

function makeToken() {
    return {
        address: TOKEN,
        ticker: "TST",
        name: "Test",
        decimals: 18,
        owner: OWNER,
        paused: false,
        hasScript: false,
        script: null,
        balances: { [OWNER]: "1000" } as Record<string, string>,
        allowances: {},
        customState: {},
        toAccessControl: () => ({ owner: OWNER, paused: false, entries: [] }),
    }
}

function mockRepo(token: any) {
    const inner = {
        findOne: jest.fn(async () => token),
        findOneBy: jest.fn(async () => token),
        save: jest.fn(async (t: any) => t),
        delete: jest.fn(async () => undefined),
    }
    return {
        ...inner,
        manager: { transaction: jest.fn(async (fn: any) => fn({ getRepository: () => inner })) },
    } as any
}

function tx(edit: any) {
    return { hash: "0xtx", content: { from: OWNER, timestamp: 1, gcr_edits: [edit] } } as any
}

describe("TOKEN_SCRIPTS_ENABLED protocol constant", () => {
    it("is off", () => {
        expect(TOKEN_SCRIPTS_ENABLED).toBe(false)
    })
})

describe("getScriptedTokenEditRejection", () => {
    it.each([
        ["create with hasScript=true", createEdit({ hasScript: true })],
        ["create with a script but hasScript=false", createEdit({ script: SCRIPT })],
        ["upgradeScript", upgradeEdit()],
        ["custom method", customEdit()],
        ["upgradeScript flagged as rollback", { ...upgradeEdit(), isRollback: true }],
    ])("rejects %s", (_name, edit) => {
        expect(getScriptedTokenEditRejection(edit)).toMatch(/Scripted tokens are disabled/)
    })

    it.each([
        ["plain create", createEdit()],
        ["transfer", transferEdit()],
    ])("allows %s", (_name, edit) => {
        expect(getScriptedTokenEditRejection(edit)).toBeNull()
    })
})

describe("GCRTokenRoutines.apply with scripts disabled", () => {
    it.each([true, false])("rejects a script-bearing create (simulate=%s)", async simulate => {
        for (const edit of [createEdit({ hasScript: true, script: SCRIPT }), createEdit({ script: SCRIPT })]) {
            const repo = mockRepo(null)
            const result = await GCRTokenRoutines.apply(edit, repo, simulate, tx(edit))
            expect(result.success).toBe(false)
            expect(result.message).toMatch(/Scripted tokens are disabled/)
            expect(repo.save).not.toHaveBeenCalled()
        }
    })

    it.each([true, false])("rejects upgradeScript and custom (simulate=%s)", async simulate => {
        for (const edit of [upgradeEdit(), customEdit()]) {
            const token = makeToken()
            const repo = mockRepo(token)
            const result = await GCRTokenRoutines.apply(edit, repo, simulate, tx(edit))
            expect(result.success).toBe(false)
            expect(result.message).toMatch(/Scripted tokens are disabled/)
            expect(repo.save).not.toHaveBeenCalled()
            expect(token.hasScript).toBe(false)
            expect(token.script).toBeNull()
        }
    })

    it("still creates a plain token", async () => {
        const edit = createEdit()
        const repo = mockRepo(null)
        const result = await GCRTokenRoutines.apply(edit, repo, false, tx(edit))
        expect(result.success).toBe(true)
        expect(repo.save).toHaveBeenCalledTimes(1)
        const saved = repo.save.mock.calls[0][0]
        expect(saved.hasScript).toBe(false)
        expect(saved.address).toBe(TOKEN)
    })

    it("still transfers a plain token", async () => {
        const edit = transferEdit()
        const token = makeToken()
        const repo = mockRepo(token)
        const result = await GCRTokenRoutines.apply(edit, repo, false, tx(edit))
        expect(result.success).toBe(true)
        expect(token.balances[OWNER]).toBe("600")
        expect(token.balances[OTHER]).toBe("400")
    })
})

describe("ingress validation with scripts disabled", () => {
    it.each([
        ["script-bearing create", createEdit({ hasScript: true, script: SCRIPT })],
        ["upgradeScript", upgradeEdit()],
        ["custom method", customEdit()],
    ])("rejects a tx carrying a %s", async (_name, edit) => {
        const result = await handleValidateTransaction(tx(edit), OWNER)
        expect(result.data.valid).toBe(false)
        expect(result.data.message).toMatch(/Scripted tokens are disabled/)
    })

    it.each([
        ["plain create", createEdit()],
        ["plain transfer", transferEdit()],
    ])("accepts a tx carrying a %s", async (_name, edit) => {
        const result = await handleValidateTransaction(tx(edit), OWNER)
        expect(result.data.valid).toBe(true)
    })
})
