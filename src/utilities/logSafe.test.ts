import { describe, expect, it } from "bun:test"
import { sanitizeForLog } from "./logSafe"

describe("sanitizeForLog", () => {
    it("drops line breaks and other control characters", () => {
        expect(sanitizeForLog("ab\r\ncd\u0000e\u001b[31mf g h\u0085i")).toBe("abcde[31mfghi")
    })

    it("caps the length and marks the cut", () => {
        expect(sanitizeForLog("x".repeat(500), 10)).toBe("xxxxxxxxxx...")
        expect(sanitizeForLog("short", 10)).toBe("short")
    })

    it("renders a non-string without throwing", () => {
        expect(sanitizeForLog(undefined)).toBe("undefined")
        expect(sanitizeForLog({ toString: () => "a\nb" })).toBe("ab")
    })
})
