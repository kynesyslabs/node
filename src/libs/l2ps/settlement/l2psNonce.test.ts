/**
 * The per-subnet L2PS nonce: the helpers every read and write goes through,
 * and the GCR routine that moves it. Subnet uids come off the wire, so a uid
 * that names an Object.prototype member must behave like any other.
 */
import { describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, warn: () => {}, error: () => {}, only: () => {} },
}))

import { hasL2PSNonces, isL2PSNonceEdit, l2psNonceOf, withL2PSNonce, type GCREditL2PSNonce } from "./l2psNonce"

const { default: GCRL2PSNonceRoutines } = await import(
    "@/libs/blockchain/gcr/gcr_routines/GCRL2PSNonceRoutines"
)

const ACCOUNT = "0x" + "11".repeat(32)
const PROTOTYPE_NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]

const edit = (over: Partial<GCREditL2PSNonce> = {}): GCREditL2PSNonce => ({
    type: "l2psNonce",
    operation: "add",
    account: ACCOUNT,
    l2psUid: "subnet_a",
    amount: 2,
    txhash: "h",
    isRollback: false,
    ...over,
})

describe("l2psNonceOf", () => {
    it("reads 0 for an absent account, map or entry, and for a value that is not a nonce", () => {
        expect(l2psNonceOf(null, "a")).toBe(0)
        expect(l2psNonceOf({}, "a")).toBe(0)
        expect(l2psNonceOf({ l2psNonces: null }, "a")).toBe(0)
        expect(l2psNonceOf({ l2psNonces: { b: 3 } }, "a")).toBe(0)
        for (const bad of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
            expect(l2psNonceOf({ l2psNonces: { a: bad } }, "a")).toBe(0)
        }
        expect(l2psNonceOf({ l2psNonces: { a: 3 } }, "a")).toBe(3)
    })

    it("never reads a uid off the prototype", () => {
        for (const uid of PROTOTYPE_NAMES) expect(l2psNonceOf({ l2psNonces: {} }, uid)).toBe(0)
    })
})

describe("withL2PSNonce", () => {
    it("returns a new map, keeps the other subnets and drops an entry set to 0", () => {
        const before = { a: 1, b: 2 }
        const after = withL2PSNonce(before, "a", 5)
        expect(after).toEqual({ a: 5, b: 2 })
        expect(before).toEqual({ a: 1, b: 2 })
        expect(after).not.toBe(before)
        expect(withL2PSNonce(after, "a", 0)).toEqual({ b: 2 })
    })

    it("stores a prototype-named uid as a plain entry that survives JSON and structuredClone", () => {
        for (const uid of PROTOTYPE_NAMES) {
            const nonces = withL2PSNonce({}, uid, 7)
            expect(Object.keys(nonces)).toEqual([uid])
            expect(l2psNonceOf({ l2psNonces: nonces }, uid)).toBe(7)
            // jsonb round trip, and the snapshot copy the apply path takes.
            const fromJson = JSON.parse(JSON.stringify(nonces))
            expect(l2psNonceOf({ l2psNonces: fromJson }, uid)).toBe(7)
            expect(l2psNonceOf({ l2psNonces: structuredClone(nonces) }, uid)).toBe(7)
            expect(Object.getPrototypeOf(nonces)).toBe(Object.prototype)
        }
    })
})

describe("hasL2PSNonces", () => {
    it("is true only once some subnet nonce has moved", () => {
        expect(hasL2PSNonces({})).toBe(false)
        expect(hasL2PSNonces({ l2psNonces: {} })).toBe(false)
        expect(hasL2PSNonces({ l2psNonces: { a: 0 } })).toBe(false)
        expect(hasL2PSNonces({ l2psNonces: { a: 1 } })).toBe(true)
    })
})

describe("GCRL2PSNonceRoutines.apply", () => {
    const account = (l2psNonces: Record<string, number> = {}) => ({ pubkey: ACCOUNT, nonce: 9, l2psNonces }) as any

    it("adds to one subnet's nonce and leaves the L1 nonce and the other subnets alone", async () => {
        const a = account({ subnet_b: 3 })
        const out = await GCRL2PSNonceRoutines.apply(edit(), a)
        expect(out.success).toBe(true)
        expect(a.l2psNonces).toEqual({ subnet_a: 2, subnet_b: 3 })
        expect(a.nonce).toBe(9)
    })

    it("reverses on rollback without changing the edit, so the block can be applied again", async () => {
        const a = account()
        const e = edit()
        await GCRL2PSNonceRoutines.apply(e, a)
        const back = { ...e, isRollback: true }
        const out = await GCRL2PSNonceRoutines.apply(back, a)
        expect(out.success).toBe(true)
        expect(a.l2psNonces).toEqual({})
        expect(back.operation).toBe("add")
        await GCRL2PSNonceRoutines.apply(e, a)
        expect(l2psNonceOf(a, "subnet_a")).toBe(2)
    })

    it("refuses to take a nonce below 0, a malformed edit and a missing account", async () => {
        const a = account({ subnet_a: 1 })
        expect((await GCRL2PSNonceRoutines.apply(edit({ operation: "remove" }), a)).message).toContain(
            "Insufficient L2PS nonce",
        )
        expect(a.l2psNonces).toEqual({ subnet_a: 1 })
        for (const bad of [{ l2psUid: "" }, { amount: -1 }, { amount: 1.5 }, { l2psUid: 5 as never }]) {
            expect((await GCRL2PSNonceRoutines.apply(edit(bad), a)).success).toBe(false)
        }
        expect((await GCRL2PSNonceRoutines.apply(edit({ operation: "set" as never }), a)).success).toBe(false)
        expect((await GCRL2PSNonceRoutines.apply(edit(), null)).success).toBe(false)
        expect(a.l2psNonces).toEqual({ subnet_a: 1 })
    })

    it("refuses a nonce past the safe integers", async () => {
        const a = account({ subnet_a: Number.MAX_SAFE_INTEGER })
        expect((await GCRL2PSNonceRoutines.apply(edit({ amount: 1 }), a)).message).toContain("overflow")
    })

    it("moves a prototype-named subnet like any other", async () => {
        const a = account()
        await GCRL2PSNonceRoutines.apply(edit({ l2psUid: "__proto__" }), a)
        expect(Object.keys(a.l2psNonces)).toEqual(["__proto__"])
        expect(l2psNonceOf(a, "__proto__")).toBe(2)
        await GCRL2PSNonceRoutines.apply(edit({ l2psUid: "__proto__" }), a)
        expect(l2psNonceOf(a, "__proto__")).toBe(4)
    })

    it("is recognised by its type", () => {
        expect(isL2PSNonceEdit(edit())).toBe(true)
        expect(isL2PSNonceEdit({ type: "nonce" })).toBe(false)
        expect(isL2PSNonceEdit(null)).toBe(false)
    })
})
