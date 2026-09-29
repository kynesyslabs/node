/**
 * History used to hand back whatever plaintext the row happened to carry.
 * Now the payload is stored encrypted, so these cover the read path that
 * replaces it — including the rows written before the change.
 */

import { describe, expect, it, jest } from "bun:test"

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

import { resolveHistoryMessage } from "./historyPayload"

const envelope = { content: { data: ["native", { message: "sealed" }] } }

function decryptorFor(plaintext: Record<string, any> | null) {
    return async () => plaintext
}

describe("resolveHistoryMessage", () => {
    it("decrypts the stored payload when the row keeps no plaintext", async () => {
        const message = await resolveHistoryMessage(
            { encrypted_payload: envelope, content: null },
            decryptorFor({ content: { data: ["native", { message: "hello" }] } }),
        )

        expect(message).toBe("hello")
    })

    it("still reads rows written before the payload was encrypted", async () => {
        const decrypt = jest.fn()

        const message = await resolveHistoryMessage(
            {
                encrypted_payload: null,
                content: { data: ["native", { message: "legacy" }] },
            },
            decrypt as never,
        )

        expect(message).toBe("legacy")
        expect(decrypt).not.toHaveBeenCalled()
    })

    it("prefers the node's own execution message", async () => {
        const message = await resolveHistoryMessage(
            { encrypted_payload: envelope, execution_message: "Transfer failed" },
            decryptorFor({ content: { data: ["native", { message: "hello" }] } }),
        )

        expect(message).toBe("Transfer failed")
    })

    it("returns nothing for a row it cannot read, rather than failing the page", async () => {
        const message = await resolveHistoryMessage(
            { encrypted_payload: envelope, content: null },
            async () => {
                throw new Error("wrong subnet key")
            },
        )

        expect(message).toBeNull()
    })

    it("returns nothing when there is no payload at all", async () => {
        const message = await resolveHistoryMessage(
            { encrypted_payload: null, content: null },
            decryptorFor(null),
        )

        expect(message).toBeNull()
    })
})
