/**
 * A message's history row has to carry its ciphertext.
 *
 * With plaintext storage off (the default) the envelope is the only payload
 * the row has. Without it the row is unreadable, and history and peer sync
 * drop it as soon as the queue row it could fall back to is swept.
 */

import { describe, expect, it, jest } from "bun:test"

const ENVELOPE = { hash: "enc-hash", content: { data: ["l2psEncryptedTx", { ciphertext: "…" }] } }

const recordTransaction = jest.fn(async (..._args: unknown[]) => 1)

jest.mock("@/model/datasource", () => ({ dataSource: {} }))

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

jest.mock("@/libs/blockchain/transaction", () => {
    class Transaction {
        content: unknown
        hash?: string
        signature?: unknown
        constructor(init: { content: unknown }) {
            this.content = init.content
        }
        static hash(tx: Transaction) {
            tx.hash = "orig-hash"
        }
        static async sign() {
            return [true, { type: "ed25519", data: "sig" }]
        }
    }
    return { __esModule: true, default: Transaction }
})

jest.mock("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            getL2PS: async () => ({}),
            encryptTransaction: async () => ENVELOPE,
        }),
    },
}))

jest.mock("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {
        addTransaction: async () => ({ success: true }),
        updateStatus: async () => true,
    },
}))

jest.mock("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    default: {
        execute: async () => ({ success: true }),
        recordTransaction,
    },
}))

const { L2PSMessagingService } = await import("../L2PSMessagingService")

describe("submitToL2PS", () => {
    it("records the encrypted envelope in the message's history row", async () => {
        const service = L2PSMessagingService.getInstance() as any

        const result = await service.submitToL2PS(
            "subnet-1",
            "from-key",
            "to-key",
            "message-id",
            "message-hash",
            { ciphertext: "x", nonce: "y" },
            1_700_000_000_000,
        )

        expect(result).toEqual({ success: true, txHash: "enc-hash" })
        expect(recordTransaction).toHaveBeenCalledTimes(1)
        const args = recordTransaction.mock.calls[0]
        expect(args[3]).toBe("enc-hash")
        expect(args[6]).toBe(ENVELOPE)
    })
})
