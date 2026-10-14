/**
 * Hostile rows and ciphertext in the history payload resolver.
 *
 * A page of history is assembled from many rows, any of which may hold a
 * damaged, foreign or hostile envelope. One of them must not cost the caller
 * the others, and what went wrong with it must stay in the log.
 */

import { describe, expect, it, jest } from "bun:test"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: new Proxy({}, { get: () => jest.fn() }),
}))

const { resolveHistoryEntry, resolveHistoryMessage, resolveHistoryContent, messageFromContent } = await import(
    "./historyPayload"
)

const content = (message: string) => ({ data: ["native", { message }] })
const envelope = { iv: "00", ct: "11" }

describe("a row whose ciphertext is not usable", () => {
    it.each([
        ["null", null],
        ["undefined", undefined],
        ["an empty string", ""],
        ["zero", 0],
        ["false", false],
    ])("%s yields nulls and never reaches the decryptor", async (_n, payload) => {
        const decrypt = jest.fn(async () => ({ content: content("x") }))
        const entry = await resolveHistoryEntry({ encrypted_payload: payload as any }, decrypt)

        expect(entry).toEqual({ message: null, content: null })
        expect(decrypt).not.toHaveBeenCalled()
    })

    it.each([
        ["a thrown error", () => { throw new Error("bad key") }],
        ["a rejected promise", async () => { throw new Error("bad key") }],
        ["a null result", async () => null],
        ["a string result", async () => "plain"],
        ["a result without content", async () => ({})],
        ["array content", async () => ({ content: [1, 2] })],
        ["string content", async () => ({ content: "text" })],
        ["null content", async () => ({ content: null })],
    ])("%s yields nulls", async (_n, decrypt) => {
        const entry = await resolveHistoryEntry({ encrypted_payload: envelope }, decrypt as any)
        expect(entry).toEqual({ message: null, content: null })
    })

    it("an unreadable row does not cost its neighbours theirs", async () => {
        const rows = [1, 2, 3, 4].map(id => ({ encrypted_payload: { id } }))
        const decrypt = async (e: Record<string, any>) => {
            if (e.id === 2) throw new Error("wrong subnet key")
            if (e.id === 3) return null
            return { content: content(`m${e.id}`) }
        }

        const entries = await Promise.all(rows.map(row => resolveHistoryEntry(row, decrypt)))

        expect(entries.map(e => e.message)).toEqual(["m1", null, null, "m4"])
    })

    it("keeps what the decryptor said out of the entry", async () => {
        const decrypt = async () => {
            throw new Error("key=deadbeef0123 at /srv/node/data/l2ps/a/private_key\n    at stack")
        }
        const entry = await resolveHistoryEntry({ encrypted_payload: envelope }, decrypt)

        expect(JSON.stringify(entry)).not.toContain("deadbeef")
        expect(JSON.stringify(entry)).not.toContain("/srv/node")
    })

    it("decrypts a shared envelope once for message and content together", async () => {
        const decrypt = jest.fn(async () => ({ content: content("hi") }))
        const entry = await resolveHistoryEntry({ encrypted_payload: envelope }, decrypt)

        expect(entry.message).toBe("hi")
        expect(decrypt).toHaveBeenCalledTimes(1)
    })

    it("a failing decrypt is attempted once, not once per field", async () => {
        const decrypt = jest.fn(async () => {
            throw new Error("nope")
        })
        await resolveHistoryEntry({ encrypted_payload: envelope }, decrypt)

        expect(decrypt).toHaveBeenCalledTimes(1)
    })
})

describe("hostile content", () => {
    it("passes a __proto__ key through as data and pollutes nothing", async () => {
        const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"data":["native",{"message":"hi"}]}')
        const entry = await resolveHistoryEntry({ encrypted_payload: envelope }, async () => ({ content: hostile }))

        expect(({} as any).polluted).toBeUndefined()
        expect((Object.prototype as any).polluted).toBeUndefined()
        expect(entry.message).toBe("hi")
        expect(Object.keys(entry.content as object)).toContain("__proto__")
    })

    it("takes a message only from a string in the second data slot", () => {
        expect(messageFromContent(JSON.parse('{"data":"native"}'))).toBeNull()
        expect(messageFromContent(JSON.parse('{"data":[null,null]}'))).toBeNull()
        expect(messageFromContent(JSON.parse('{"data":["n",{"message":{"a":1}}]}'))).toBeNull()
        expect(messageFromContent(JSON.parse('{"data":["n",{"message":""}]}'))).toBeNull()
    })

    it("treats content that is itself a history response as opaque data", async () => {
        const nested = {
            transactions: [{ encrypted_payload: envelope, content: null }],
            data: ["native", { message: "outer" }],
        }
        const decrypt = jest.fn(async () => ({ content: nested }))
        const entry = await resolveHistoryEntry({ encrypted_payload: envelope }, decrypt)

        expect(entry.content).toBe(nested)
        expect(entry.message).toBe("outer")
        expect(decrypt).toHaveBeenCalledTimes(1)
    })

    it("returns a very large message whole rather than truncating or throwing", async () => {
        const big = "x".repeat(5_000_000)
        const entry = await resolveHistoryEntry({ encrypted_payload: envelope }, async () => ({ content: content(big) }))

        expect(entry.message?.length).toBe(big.length)
    })

    it("a deeply nested payload does not make the resolver recurse", async () => {
        let deep: any = { leaf: true }
        for (let i = 0; i < 50_000; i++) deep = { n: deep }
        const entry = await resolveHistoryEntry(
            { encrypted_payload: envelope },
            async () => ({ content: { data: ["native", { message: "m" }], deep } }),
        )

        expect(entry.message).toBe("m")
    })
})

describe("which source wins", () => {
    it("the node's execution message beats a message in the payload", async () => {
        const entry = await resolveHistoryEntry(
            { execution_message: "failed: insufficient balance", encrypted_payload: envelope },
            async () => ({ content: content("sender says ok") }),
        )

        expect(entry.message).toBe("failed: insufficient balance")
    })

    it("an empty execution message does not hide the payload message", async () => {
        const entry = await resolveHistoryEntry(
            { execution_message: "", encrypted_payload: envelope },
            async () => ({ content: content("m") }),
        )

        expect(entry.message).toBe("m")
    })

    it("plaintext on the row wins over the ciphertext and spares the decrypt", async () => {
        const decrypt = jest.fn(async () => ({ content: content("from ciphertext") }))
        const entry = await resolveHistoryEntry(
            { content: content("from row"), encrypted_payload: envelope },
            decrypt,
        )

        expect(entry.message).toBe("from row")
        expect(decrypt).not.toHaveBeenCalled()
    })

    it("an array or string in the plaintext column is not content and falls back to the ciphertext", async () => {
        for (const bad of [[1], "text", 0]) {
            const entry = await resolveHistoryEntry(
                { content: bad as any, encrypted_payload: envelope },
                async () => ({ content: content("from ciphertext") }),
            )
            expect(entry.message).toBe("from ciphertext")
        }
    })

    it("message-only and content-only reads agree with the combined one", async () => {
        const row = { encrypted_payload: envelope }
        const decrypt = async () => ({ content: content("m") })

        expect(await resolveHistoryMessage(row, decrypt)).toBe("m")
        expect(await resolveHistoryContent(row, decrypt)).toEqual(content("m"))
    })

    it("a message read with an execution message does not decrypt", async () => {
        const decrypt = jest.fn(async () => ({ content: content("m") }))
        expect(await resolveHistoryMessage({ execution_message: "x", encrypted_payload: envelope }, decrypt)).toBe("x")
        expect(decrypt).not.toHaveBeenCalled()
    })
})
