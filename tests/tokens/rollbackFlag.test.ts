import { beforeAll, describe, expect, it, jest } from "@jest/globals"

// A token edit's isRollback flag arrives inside the client-signed tx and token edits are
// excluded from the ingress edit-hash check, so the flag must come from the caller, never
// from the client. These tests drive HandleGCR's two token entry points.

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock("src/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
    dataSource: { getRepository: jest.fn() },
}))
jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
    dataSource: { getRepository: jest.fn() },
}))
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { lastBlockNumber: 0, lastBlockHash: "" },
}))
jest.mock("src/utilities/sharedState", () => ({
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
jest.mock("@/features/incentive/referrals", () => ({ __esModule: true, Referrals: {} }))
jest.mock("src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("src/libs/network/server_rpc", () => ({ __esModule: true, emptyResponse: {} }))
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
jest.mock("src/libs/blockchain/gcr/gcr_routines/identityManager", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/manageNative", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/GCRTLSNotaryRoutines", () => ({
    __esModule: true,
    GCRTLSNotaryRoutines: {},
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines", () => ({
    __esModule: true,
    GCRStorageProgramRoutines: {},
}))
jest.mock("@/features/tlsnotary/tokenManager", () => ({
    __esModule: true,
    createToken: jest.fn(),
    extractDomain: jest.fn(),
}))

jest.mock("src/libs/blockchain/gcr/gcr_routines/assignXM", () => ({ __esModule: true, assignXM: jest.fn() }))
jest.mock("src/libs/blockchain/gcr/gcr_routines/assignWeb2", () => ({ __esModule: true, assignWeb2: jest.fn() }))
jest.mock("src/libs/blockchain/gcr/gcr_routines/hashGCR", () => ({ __esModule: true, default: jest.fn() }))
jest.mock("src/libs/blockchain/gcr/gcr_routines/gcrStateSaverHelper", () => ({ __esModule: true, default: jest.fn() }))

let HandleGCR: typeof import("src/libs/blockchain/gcr/handleGCR")["default"]

beforeAll(async () => {
    const mod = await import("src/libs/blockchain/gcr/handleGCR")
    HandleGCR = mod.default
})

const ATTACKER = "0x" + "aa".repeat(32)
const VICTIM = "0x" + "bb".repeat(32)
const TOKEN = "0x" + "cc".repeat(32)

function makeToken(balances: Record<string, string>) {
    return {
        address: TOKEN,
        ticker: "TST",
        name: "Test",
        decimals: 18,
        paused: false,
        hasScript: false,
        script: null,
        balances,
        allowances: {},
        customState: {},
    }
}

function mockRepo(token: any) {
    const inner = {
        findOne: jest.fn(async () => token),
        findOneBy: jest.fn(async () => token),
        save: jest.fn(async (t: any) => t),
    }
    return {
        ...inner,
        manager: { transaction: jest.fn(async (fn: any) => fn({ getRepository: () => inner })) },
    } as any
}

// Attacker signs a "transfer" from itself to the victim, flagged as a rollback. A rollback
// reverses direction, so if the flag were honoured the victim's balance would move to the attacker.
function forgedRollbackTx() {
    return {
        hash: "0xtx",
        content: {
            from: ATTACKER,
            timestamp: 1,
            gcr_edits: [
                {
                    type: "token",
                    operation: "transfer",
                    account: ATTACKER,
                    tokenAddress: TOKEN,
                    txhash: "0xtx",
                    isRollback: true,
                    data: { from: ATTACKER, to: VICTIM, amount: "500" },
                },
            ],
        },
    } as any
}

describe("client-supplied isRollback on token edits is ignored", () => {
    it.each([true, false])(
        "applyTokenEditsToTx does not reverse a forged rollback transfer (simulate=%s)",
        async simulate => {
            const token = makeToken({ [VICTIM]: "1000" })
            const repo = mockRepo(token)
            const em = { getRepository: () => repo } as any
            const result = await HandleGCR.applyTokenEditsToTx(forgedRollbackTx(), false, simulate, em)

            expect(result.success).toBe(false)
            expect(token.balances[VICTIM]).toBe("1000")
            expect(token.balances[ATTACKER]).toBeUndefined()
        },
    )

    it.each([true, false])(
        "applyGCREdit does not reverse a forged rollback transfer (simulate=%s)",
        async simulate => {
            const token = makeToken({ [VICTIM]: "1000" })
            const repo = mockRepo(token)
            jest.spyOn(HandleGCR as any, "getRepositories").mockResolvedValue({ token: repo } as never)
            const tx = forgedRollbackTx()
            const result = await HandleGCR.applyGCREdit(tx.content.gcr_edits[0], null, false, simulate, tx)

            expect(result.success).toBe(false)
            expect(token.balances[VICTIM]).toBe("1000")
            expect(token.balances[ATTACKER]).toBeUndefined()
        },
    )

    it("a caller-requested rollback still reverses a legitimate transfer", async () => {
        const token = makeToken({ [VICTIM]: "500", [ATTACKER]: "500" })
        const repo = mockRepo(token)
        const em = { getRepository: () => repo } as any
        const tx = forgedRollbackTx()
        // Legitimate tx: the attacker sent 500 to the victim. Rolling it back returns it.
        tx.content.gcr_edits[0].isRollback = false
        token.balances = { [VICTIM]: "500", [ATTACKER]: "500" }
        const result = await HandleGCR.applyTokenEditsToTx(tx, true, false, em)

        expect(result.success).toBe(true)
        expect(token.balances[ATTACKER]).toBe("1000")
        expect(token.balances[VICTIM] ?? "0").toBe("0")
    })

    it("applyGCREdit does not mutate the tx's own edit object", async () => {
        const token = makeToken({ [VICTIM]: "500", [ATTACKER]: "500" })
        const repo = mockRepo(token)
        jest.spyOn(HandleGCR as any, "getRepositories").mockResolvedValue({ token: repo } as never)
        const tx = forgedRollbackTx()
        tx.content.gcr_edits[0].isRollback = false
        await HandleGCR.applyGCREdit(tx.content.gcr_edits[0], null, true, true, tx)

        expect(tx.content.gcr_edits[0].isRollback).toBe(false)
    })
})

// Consensus rollback (vote failure, finalize failure) reverses only the native edits applied
// before forge; token edits were never persisted there, so they must be stripped first.
describe("HandleGCR.stripTokenEdits", () => {
    const nativeEdit = { type: "balance", operation: "remove", account: ATTACKER, amount: 1 }

    it("drops token edits, keeps native edits and does not mutate the input", () => {
        const tx = forgedRollbackTx()
        tx.content.gcr_edits.unshift(nativeEdit)
        const [stripped] = HandleGCR.stripTokenEdits([tx])

        expect(stripped.content.gcr_edits).toEqual([nativeEdit])
        expect(tx.content.gcr_edits).toHaveLength(2)
        expect(stripped.hash).toBe(tx.hash)
    })

    it("returns txs without token edits unchanged", () => {
        const tx = { hash: "0xn", content: { gcr_edits: [nativeEdit] } } as any
        const noEdits = { hash: "0xe", content: {} } as any
        const out = HandleGCR.stripTokenEdits([tx, noEdits])
        expect(out[0]).toBe(tx)
        expect(out[1]).toBe(noEdits)
    })
})
