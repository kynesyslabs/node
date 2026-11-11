/**
 * GCR_IDENTITY_ASSIGN (0x41) used to load or create any account's GCR_Main
 * row and apply an identity edit to it. Only an auth block was required,
 * nothing tied the caller to editOperation.account, and the write skipped
 * the mempool, block and consensus path. The handler must refuse every
 * request before it decodes the payload or touches the database.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

import { decodeRpcResponse, encodeJsonRequest } from "../../serialization/jsonEnvelope"
import { SignatureAlgorithm, SignatureMode } from "../../auth/types"

const CALLER = "0x" + "11".repeat(32)
const VICTIM = "0x" + "22".repeat(32)

const findOneBy = jest.fn(async (..._args: unknown[]) => null as any)
const save = jest.fn(async (entity: unknown) => entity)
const getRepository = jest.fn((..._args: unknown[]) => ({ findOneBy, save }))
const getInstance = jest.fn(async () => ({
    getDataSource: () => ({ getRepository }),
}))
const createAccount = jest.fn(async (pubkey: string) => ({ pubkey, identities: {} }) as any)
const apply = jest.fn(async (..._args: unknown[]) => ({ success: true, message: "applied" }))
const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }

mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))

mock.module("src/model/datasource", () => ({
    __esModule: true,
    default: { getInstance },
}))
mock.module("@/model/entities/GCRv2/GCR_Main", () => ({
    GCRMain: class GCRMain {},
}))
mock.module("@/libs/blockchain/gcr/handleGCR", () => ({
    __esModule: true,
    default: { createAccount },
}))
mock.module("src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines", () => ({
    __esModule: true,
    default: { apply },
}))

const { handleIdentityAssign } = await import("./gcr")

const editOperation = {
    type: "identity",
    isRollback: false,
    account: VICTIM,
    context: "web2",
    operation: "add",
    data: { context: "twitter", data: { username: "someone" } },
    txhash: "0x" + "ab".repeat(32),
}

const call = (payload: Buffer) =>
    (handleIdentityAssign as any)({
        message: {
            header: { version: 1, opcode: 0x41, sequence: 1, payloadLength: payload.length },
            auth: {
                algorithm: SignatureAlgorithm.ED25519,
                signatureMode: SignatureMode.SIGN_TIMESTAMPED_PAYLOAD_HASH,
                timestamp: Date.now(),
                identity: Buffer.from(CALLER.slice(2), "hex"),
                signature: Buffer.alloc(64, 1),
            },
            payload,
        },
        context: { peerIdentity: CALLER, isAuthenticated: true },
        fallbackToHttp: async () => Buffer.alloc(0),
    }) as Promise<Buffer>

const expectNoDatabaseWork = () => {
    expect(getInstance).not.toHaveBeenCalled()
    expect(getRepository).not.toHaveBeenCalled()
    expect(findOneBy).not.toHaveBeenCalled()
    expect(createAccount).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
}

beforeEach(() => {
    for (const fn of [findOneBy, save, getRepository, getInstance, createAccount, apply]) {
        fn.mockClear()
    }
})

describe("handleIdentityAssign (0x41)", () => {
    it("refuses a well-formed authenticated request with 403 and writes nothing", async () => {
        const response = decodeRpcResponse(await call(encodeJsonRequest({ editOperation })))

        expect(response.result).toBe(403)
        expect(String(response.response)).toContain("gcr_identityAssign is disabled")
        expectNoDatabaseWork()
    })

    it("refuses before decoding the payload", async () => {
        const response = decodeRpcResponse(await call(Buffer.from([0xff, 0xff, 0xff])))

        expect(response.result).toBe(403)
        expectNoDatabaseWork()
    })
})
