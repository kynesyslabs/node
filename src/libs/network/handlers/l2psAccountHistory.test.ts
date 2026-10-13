/**
 * The authenticated history reply used to carry only the message string, so a
 * member could not recover a structured payload sent to them through the
 * subnet. These pin the reply shape with the real payload resolver and only
 * the signature check, the table read and the subnet key stubbed.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getAccountTransactions = jest.fn()
const decryptTx = jest.fn()
const verify = jest.fn(() => true)

jest.mock("../../l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    default: { getAccountTransactions },
}))

jest.mock("../../blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {},
    L2PS_STATUS: {},
}))

jest.mock("../../crypto/cryptography", () => ({
    __esModule: true,
    default: { verify },
}))

jest.mock("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            getL2PS: async () => ({ decryptTx }),
            loadL2PS: async () => null,
        }),
    },
}))

jest.mock("src/utilities/sharedState", () => ({ getSharedState: {} }))

jest.mock("src/utilities/logger", () => ({
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

const { l2psHandlers } = await import("./l2psHandlers")

const structured = {
    data: ["native", { message: "rfq", envelope: { id: "chan-1", sig: "0xabc" } }],
}

const row = (id: number, overrides: Record<string, unknown> = {}) => ({
    hash: `h-${id}`,
    encrypted_hash: `e-${id}`,
    l1_batch_hash: null,
    type: "native",
    from_address: "0xfrom",
    to_address: "0xto",
    amount: 5n,
    status: "executed",
    timestamp: 10n,
    l1_block_number: null,
    execution_message: null,
    content: null,
    encrypted_payload: { id },
    ...overrides,
})

const request = () => ({
    l2psUid: "subnet-1",
    address: "0xfrom",
    signature: "0xsig",
    timestamp: String(Date.now()),
})

beforeEach(() => {
    getAccountTransactions.mockReset()
    decryptTx.mockReset()
    verify.mockReset()
    verify.mockReturnValue(true)
})

describe("getL2PSAccountTransactions", () => {
    it("returns the decrypted content next to the existing fields", async () => {
        getAccountTransactions.mockResolvedValue([row(1)])
        decryptTx.mockResolvedValue({ content: structured })

        const response: any = {}
        await l2psHandlers.getL2PSAccountTransactions(request() as any, response)

        expect(response.result).toBe(200)
        expect(response.response.transactions).toEqual([
            {
                hash: "h-1",
                encrypted_hash: "e-1",
                l1_batch_hash: null,
                type: "native",
                from: "0xfrom",
                to: "0xto",
                amount: "5",
                status: "executed",
                timestamp: "10",
                l1_block_number: null,
                execution_message: "rfq",
                content: structured,
            },
        ])
        expect(decryptTx).toHaveBeenCalledTimes(1)
    })

    it("answers null content for an unreadable row without failing the page", async () => {
        getAccountTransactions.mockResolvedValue([row(1), row(2)])
        decryptTx
            .mockRejectedValueOnce(new Error("wrong subnet key"))
            .mockResolvedValueOnce({ content: structured })

        const response: any = {}
        await l2psHandlers.getL2PSAccountTransactions(request() as any, response)

        expect(response.result).toBe(200)
        expect(response.response.transactions[0].content).toBeNull()
        expect(response.response.transactions[0].execution_message).toBeNull()
        expect(response.response.transactions[1].content).toEqual(structured)
    })

    it("returns no content to a caller whose signature does not verify", async () => {
        verify.mockReturnValue(false)

        const response: any = {}
        await l2psHandlers.getL2PSAccountTransactions(request() as any, response)

        expect(response.result).toBe(403)
        expect(getAccountTransactions).not.toHaveBeenCalled()
        expect(decryptTx).not.toHaveBeenCalled()
    })
})
