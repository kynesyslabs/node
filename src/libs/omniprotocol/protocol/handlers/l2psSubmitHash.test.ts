/**
 * The omni submit opcode refuses an outer transaction hash that is not
 * 64 lower-case hex characters, before anything is decrypted or stored.
 */

import { describe, expect, it, jest, mock } from "bun:test"

const addTransaction = jest.fn(async (..._args: unknown[]) => ({ success: true }))
const getL2PS = jest.fn(async (..._args: unknown[]) => ({}))

mock.module("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
mock.module("src/libs/blockchain/transaction", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/network/server_rpc", () => ({
    emptyResponse: { result: 200, response: "", require_reply: false, extra: null },
}))
mock.module("../../../network/server_rpc", () => ({
    emptyResponse: { result: 200, response: "", require_reply: false, extra: null },
}))
mock.module("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getL2PS, loadL2PS: getL2PS }) },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({ __esModule: true, default: { addTransaction } }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, L2PS_TX_FEE: 1, default: {} }))
mock.module("@/libs/l2ps/balanceCheck", () => ({ checkInnerTxBalance: async () => null }))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    getExecutedBacklogGuard: () => ({ check: async () => ({ admitted: true }), admit: async () => ({ admitted: true }) }),
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { handleL2PSSubmitEncryptedTx } = await import("./l2ps")
const { encodeJsonRequest, decodeRpcResponse } = await import("../../serialization/jsonEnvelope")

const tx = (hash: string) => ({
    hash,
    content: { data: ["l2psEncryptedTx", { l2ps_uid: "subnet_a", original_hash: "0xo" }] },
})

describe("L2PS_SUBMIT_ENCRYPTED_TX", () => {
    it("answers 400 for a malformed hash and stores nothing", async () => {
        for (const hash of ["enc-1", "\u{1F600}".repeat(32), "A".repeat(64)]) {
            const reply = await handleL2PSSubmitEncryptedTx({
                message: { payload: encodeJsonRequest({ l2psUid: "subnet_a", encryptedTx: JSON.stringify(tx(hash)) }) },
                context: {},
            } as any)
            const decoded = decodeRpcResponse(reply)
            expect(decoded.result).toBe(400)
            expect(String(decoded.extra)).toContain("hash")
        }
        expect(getL2PS).not.toHaveBeenCalled()
        expect(addTransaction).not.toHaveBeenCalled()
    })
})
