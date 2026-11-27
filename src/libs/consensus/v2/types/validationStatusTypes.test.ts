import { describe, expect, it } from "bun:test"

import { emptyValidationPhase, isKnownPhase } from "./validationStatusTypes"

describe("isKnownPhase", () => {
    it("accepts every phase number in the table", () => {
        for (const key of Object.keys(emptyValidationPhase.phases)) {
            expect(isKnownPhase(Number(key))).toBe(true)
        }
    })

    it.each(["__proto__", "constructor", "toString", "3", 0, 99, 1.5, null, undefined])(
        "refuses %p",
        value => {
            expect(isKnownPhase(value)).toBe(false)
        },
    )
})
