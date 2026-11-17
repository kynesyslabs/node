/**
 * The complex-policy scenarios parse RPC amounts with a 0n fallback. Logging the
 * malformed value must not throw from inside that fallback, even when String()
 * itself throws on the value (#708).
 *
 * Run this file in its own `bun test` process.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("@kynesyslabs/demosdk/websdk", () => ({ Demos: class {} }))

const { safeBigIntFromString } = await import("./token_script_complex_policy_smoke")
const escrow = await import("./token_script_complex_policy_escrow_state_machine")
const vesting = await import("./token_script_complex_policy_vesting_lockup")

const helpers: Array<[string, (value: any) => bigint]> = [
  ["token_script_complex_policy_smoke.safeBigIntFromString", safeBigIntFromString],
  ["token_script_complex_policy_escrow_state_machine.parseBigintOrZero", escrow.parseBigintOrZero],
  ["token_script_complex_policy_vesting_lockup.parseBigintOrZero", vesting.parseBigintOrZero],
]

describe("complex-policy amount parsing", () => {
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

  for (const [context, parse] of helpers) {
    it(`${context} parses valid amounts without logging`, () => {
      expect(parse("12")).toBe(12n)
      expect(parse(7)).toBe(7n)
      expect(parse(5n)).toBe(5n)
      expect(parse(null)).toBe(0n)
      expect(errors).toEqual([])
    })

    it(`${context} returns 0n for an amount String() cannot convert`, () => {
      const value = JSON.parse('{"toString":null}')
      expect(() => String(value)).toThrow(TypeError)
      expect(parse(value)).toBe(0n)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(`[loadgen] Non-critical error in ${context}`)
      expect(errors[0]).toContain('{"value":"object"}')
    })
  }
})
