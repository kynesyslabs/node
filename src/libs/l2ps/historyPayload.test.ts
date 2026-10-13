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

import {
    resolveHistoryContent,
    resolveHistoryEntry,
    resolveHistoryMessage,
} from "./historyPayload"

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

describe("resolveHistoryContent", () => {
    const structured = {
        data: ["native", { message: "hello", envelope: { id: "chan-1", sig: "0xabc" } }],
    }

    it("returns the plaintext content when the row keeps it", async () => {
        const decrypt = jest.fn()

        const content = await resolveHistoryContent(
            { encrypted_payload: envelope, content: structured },
            decrypt as never,
        )

        expect(content).toEqual(structured)
        expect(decrypt).not.toHaveBeenCalled()
    })

    it("returns the decrypted content when the row keeps no plaintext", async () => {
        const content = await resolveHistoryContent(
            { encrypted_payload: envelope, content: null },
            decryptorFor({ content: structured }),
        )

        expect(content).toEqual(structured)
    })

    it("still returns content when the node's execution message wins for the message", async () => {
        const entry = await resolveHistoryEntry(
            { encrypted_payload: envelope, execution_message: "Transfer failed" },
            decryptorFor({ content: structured }),
        )

        expect(entry).toEqual({ message: "Transfer failed", content: structured })
    })

    it("returns null when decryption throws, rather than failing the page", async () => {
        const content = await resolveHistoryContent(
            { encrypted_payload: envelope, content: null },
            async () => {
                throw new Error("wrong subnet key")
            },
        )

        expect(content).toBeNull()
    })

    it("returns null when the decryptor throws synchronously", async () => {
        const content = await resolveHistoryContent(
            { encrypted_payload: envelope, content: null },
            (() => {
                throw new Error("boom")
            }) as never,
        )

        expect(content).toBeNull()
    })

    it("returns null when the envelope carries no content", async () => {
        expect(
            await resolveHistoryContent(
                { encrypted_payload: envelope, content: null },
                decryptorFor({}),
            ),
        ).toBeNull()
        expect(
            await resolveHistoryContent(
                { encrypted_payload: envelope, content: null },
                decryptorFor(null),
            ),
        ).toBeNull()
    })

    it("returns null when there is no payload at all", async () => {
        expect(
            await resolveHistoryContent({ encrypted_payload: null, content: null }, decryptorFor(null)),
        ).toBeNull()
    })
})

describe("resolveHistoryEntry", () => {
    it("decrypts a row once for both the message and the content", async () => {
        const decrypt = jest.fn(async () => ({
            content: { data: ["native", { message: "hello" }] },
        }))

        const entry = await resolveHistoryEntry(
            { encrypted_payload: envelope, content: null },
            decrypt,
        )

        expect(decrypt).toHaveBeenCalledTimes(1)
        expect(entry.message).toBe("hello")
        expect(entry.content).toEqual({ data: ["native", { message: "hello" }] })
    })

    it("yields nulls for an unreadable row", async () => {
        const entry = await resolveHistoryEntry(
            { encrypted_payload: envelope, content: null },
            async () => {
                throw new Error("wrong subnet key")
            },
        )

        expect(entry).toEqual({ message: null, content: null })
    })

    it("keeps plaintext content but still reads the envelope once for a missing message", async () => {
        const plaintext = { data: ["native", { envelope: { id: "chan-1" } }] }
        const decrypt = jest.fn(async () => ({
            content: { data: ["native", { message: "from envelope" }] },
        }))

        const entry = await resolveHistoryEntry(
            { encrypted_payload: envelope, content: plaintext },
            decrypt,
        )

        expect(decrypt).toHaveBeenCalledTimes(1)
        expect(entry.content).toEqual(plaintext)
        expect(entry.message).toBe("from envelope")
    })

    it("treats array content as unreadable, stored or decrypted", async () => {
        const stored = await resolveHistoryEntry(
            { encrypted_payload: null, content: ["not", "an", "object"] as any },
            async () => null,
        )
        expect(stored.content).toBeNull()

        const decrypted = await resolveHistoryEntry(
            { encrypted_payload: envelope, content: null },
            async () => ({ content: ["not", "an", "object"] }),
        )
        expect(decrypted.content).toBeNull()
        expect(decrypted.message).toBeNull()
    })
})

describe("resolveHistoryMessage", () => {
    it("does not decrypt when the execution message already answers", async () => {
        const decrypt = jest.fn()

        await resolveHistoryMessage(
            { encrypted_payload: envelope, execution_message: "Transfer failed" },
            decrypt as never,
        )

        expect(decrypt).not.toHaveBeenCalled()
    })
})
