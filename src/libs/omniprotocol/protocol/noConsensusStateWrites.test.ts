/**
 * Consensus state changes only through block apply. An Omni handler that
 * writes GCRMain directly changes one node's state outside consensus, and
 * the next block hash comparison splits the network.
 */

import { describe, expect, it, jest, mock } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

const save = jest.fn(async (entity: unknown) => entity)
const findOneBy = jest.fn(async () => ({ pubkey: "0xvictim", identities: {} }))
const identityApply = jest.fn(async () => ({ success: true, message: "ok" }))
const createAccount = jest.fn(async () => ({ pubkey: "0xvictim", identities: {} }))

mock.module("src/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({ getRepository: () => ({ save, findOneBy }) }),
        }),
    },
}))
mock.module("src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines", () => ({
    __esModule: true,
    default: { apply: identityApply },
}))
mock.module("@/libs/blockchain/gcr/handleGCR", () => ({
    __esModule: true,
    default: { createAccount },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { getHandler } = await import("./registry")
const { OmniOpcode } = await import("./opcodes")
const { encodeJsonRequest, decodeRpcResponse } = await import("../serialization/jsonEnvelope")

const HANDLERS_DIR = join(import.meta.dir, "handlers")

// Imports and calls that only block apply and genesis may use.
const STATE_WRITERS = [
    /GCR_Main/,
    /GCRIdentityRoutines/,
    /gcr\/handleGCR/,
    /\bcreateAccount\s*\(/,
    /\.save\s*\(/,
    /\.insert\s*\(/,
]

describe("Omni handlers never write consensus state", () => {
    it("GCR_IDENTITY_ASSIGN (0x41) is refused and touches nothing", async () => {
        const descriptor = getHandler(OmniOpcode.GCR_IDENTITY_ASSIGN)
        expect(descriptor).toBeDefined()

        const payload = encodeJsonRequest({
            editOperation: {
                type: "identity",
                isRollback: false,
                account: "0xvictim",
                context: "xm",
                operation: "add",
                data: { chain: "eth", subchain: "mainnet", targetAddress: "0xattacker" },
                txhash: "0x" + "ab".repeat(32),
            },
        })
        const reply = await descriptor!.handler({
            message: { payload },
            context: { peerIdentity: "0xpeer", isAuthenticated: true },
            fallbackToHttp: async () => Buffer.alloc(0),
        } as any)

        const decoded = decodeRpcResponse(reply)
        expect(decoded.result).not.toBe(200)
        expect(identityApply).not.toHaveBeenCalled()
        expect(createAccount).not.toHaveBeenCalled()
        expect(save).not.toHaveBeenCalled()
    })

    it("no handler module imports a GCR writer", () => {
        const offenders: string[] = []
        for (const file of readdirSync(HANDLERS_DIR)) {
            if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
            const source = readFileSync(join(HANDLERS_DIR, file), "utf8")
            for (const pattern of STATE_WRITERS) {
                if (pattern.test(source)) offenders.push(`${file}: ${pattern}`)
            }
        }
        expect(offenders).toEqual([])
    })
})
