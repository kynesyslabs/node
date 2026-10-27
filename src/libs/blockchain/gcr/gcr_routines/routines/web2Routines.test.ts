import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { dataSource } from "@/model/datasource"
import Hashing from "@/libs/crypto/hashing"
import {
    canonicalWeb2UserId,
    sameWeb2UserId,
    web2UserIdLookupKey,
} from "@/libs/identity/web2UserId"
import { applyWeb2IdentityAdd } from "./web2Routines"
import { isFirstConnection } from "./utils"

const ACCOUNT = "0x" + "11".repeat(32)
const PROOF = "https://x.com/alice/status/1"

function accountWith(context: string, linked: Array<Record<string, unknown>>): any {
    return { pubkey: ACCOUNT, identities: { web2: { [context]: linked } } }
}

const addEdit = (context: string, username: string, userId: unknown) => ({
    account: ACCOUNT,
    data: {
        context,
        data: {
            username,
            userId,
            proof: PROOF,
            proofHash: Hashing.sha256(PROOF),
            timestamp: 1,
        },
    },
})

describe("web2 account ids have one comparable form", () => {
    it("accepts safe integers and plain decimal strings only", () => {
        expect(canonicalWeb2UserId(42)).toBe("42")
        expect(canonicalWeb2UserId("42")).toBe("42")
        expect(canonicalWeb2UserId("0")).toBe("0")
        for (const id of [" 42", "42 ", "042", "+42", "-1", "4.2e1", 4.2, -1, 2 ** 60, "", null, undefined, {}]) {
            expect({ id, c: canonicalWeb2UserId(id) }).toEqual({ id, c: null })
        }
    })

    it("matches a number with its decimal string and nothing else", () => {
        expect(sameWeb2UserId(42, "42")).toBe(true)
        expect(sameWeb2UserId("42", "042")).toBe(false)
        expect(sameWeb2UserId(" 42 ", " 42 ")).toBe(false)
    })
})

describe("a second link of the same web2 account", () => {
    it("is a duplicate whether the id was stored as a number or a string", async () => {
        for (const [stored, sent] of [
            [42, "42"],
            ["42", 42],
            ["42", "42"],
        ] as const) {
            const r = await applyWeb2IdentityAdd(
                addEdit("github", "alice", sent),
                accountWith("github", [{ username: "Alice", userId: stored }]),
            )
            expect({ stored, sent, r: r.success, m: r.message }).toEqual({
                stored,
                sent,
                r: false,
                m: "Identity already exists",
            })
        }
    })

    it("is a duplicate under another handle case", async () => {
        const r = await applyWeb2IdentityAdd(
            addEdit("twitter", "ALICE", "42"),
            accountWith("twitter", [{ username: "alice", userId: "42" }]),
        )
        expect(r).toEqual({ success: false, message: "Identity already exists" })
    })

    it("still adds a different account", async () => {
        const r = await applyWeb2IdentityAdd(
            addEdit("github", "bob", 43),
            accountWith("github", [{ username: "Alice", userId: 42 }]),
        )
        expect(r.success).toBe(true)
    })
})

describe("isFirstConnection looks an id up by its comparable form", () => {
    let params: Array<Record<string, unknown>>
    let restore: () => void

    beforeEach(() => {
        params = []
        const builder: any = {
            where: (_sql: string, p: Record<string, unknown>) => {
                params.push(p)
                return builder
            },
            andWhere: () => builder,
            // Another account already holds the stored id "42" (jsonb ->>
            // renders a stored 42 the same way).
            getOne: async () =>
                params.at(-1)?.userId === "42" ? { pubkey: "0xother" } : null,
        }
        const spy = spyOn(dataSource, "getRepository").mockReturnValue({
            createQueryBuilder: () => builder,
        } as any)
        restore = () => spy.mockRestore()
    })
    afterEach(() => restore())

    it("is not a first connection when another account linked the id under the other type", async () => {
        expect(await isFirstConnection("github", { userId: 42 as any }, ACCOUNT)).toBe(false)
        expect(await isFirstConnection("github", { userId: "42" }, ACCOUNT)).toBe(false)
        expect(params.map(p => p.userId)).toEqual(["42", "42"])
    })

    it("uses the same key for both spellings", () => {
        expect(web2UserIdLookupKey(42)).toBe(web2UserIdLookupKey("42"))
    })
})
