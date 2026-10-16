import { describe, expect, it } from "bun:test"
import { isValidL2PSTxHash } from "./txHash"

describe("isValidL2PSTxHash", () => {
    it("accepts 64 lower-case hex characters", () => {
        expect(isValidL2PSTxHash("a".repeat(64))).toBe(true)
        expect(isValidL2PSTxHash("0123456789abcdef".repeat(4))).toBe(true)
    })

    it("refuses everything else", () => {
        const refused: unknown[] = [
            "",
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            `0x${"a".repeat(62)}`,
            `${"a".repeat(63)}g`,
            `${"a".repeat(63)}\n`,
            `${"a".repeat(32)}\u{1F600}${"a".repeat(30)}`,
            `${"a".repeat(64)}\u0000`,
            undefined,
            null,
            12,
            {},
            ["a".repeat(64)],
        ]
        for (const value of refused) expect(isValidL2PSTxHash(value)).toBe(false)
    })
})
