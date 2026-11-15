/**
 * parseBigintOrZero falls back to 0n for a malformed amount. That fallback must
 * still happen, and the malformed value must show up in the log (#708).
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("@kynesyslabs/demosdk/websdk", () => ({ Demos: class {} }))

const { parseBigintOrZero } = await import("./token_holders_export")

describe("token_holders_export parseBigintOrZero", () => {
  let errors: string[]
  let spy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it("parses valid amounts without logging", () => {
    expect(parseBigintOrZero("12")).toBe(12n)
    expect(parseBigintOrZero(7)).toBe(7n)
    expect(parseBigintOrZero(5n)).toBe(5n)
    expect(parseBigintOrZero(null)).toBe(0n)
    expect(errors).toEqual([])
  })

  it("returns 0n for a malformed amount and logs it once with context", () => {
    expect(parseBigintOrZero("not-a-number")).toBe(0n)
    expect(parseBigintOrZero("still-bad")).toBe(0n)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("[loadgen] Non-critical error in token_holders_export.parseBigintOrZero")
    expect(errors[0]).toContain("not-a-number")
  })
})
