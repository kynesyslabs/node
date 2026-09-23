import { describe, expect, it } from "bun:test"
import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { ATOMIC_WORK_ID_DOMAIN, computeWorkId } from "@/libs/atomic-work/workId"

describe("computeWorkId", () => {
    const intent = { b: "2", a: "1", nested: { y: 2, x: 1 } }

    it("is domain ‖ JCS(intent) hashed with sha256", () => {
        const expected = Hashing.sha256(
            ATOMIC_WORK_ID_DOMAIN + jcsCanonicalize(intent),
        )
        expect(computeWorkId(intent)).toBe(expected)
    })

    it("pins the domain string verbatim", () => {
        expect(ATOMIC_WORK_ID_DOMAIN).toBe("dacs-atomic-work:v1:")
    })

    it("is 64-char lowercase hex", () => {
        expect(computeWorkId(intent)).toMatch(/^[0-9a-f]{64}$/)
    })

    it("is independent of caller key order (JCS canonicalizes)", () => {
        expect(computeWorkId({ a: "1", b: "2" })).toBe(
            computeWorkId({ b: "2", a: "1" }),
        )
    })
})
