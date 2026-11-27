/**
 * The complex-policy amount helpers log a malformed RPC amount (#708). An amount
 * that is a plain object must show as JSON in that log, not as "[object Object]".
 * Each helper logs once per process, and token_script_complex_policy_amounts.test.ts
 * uses that one log for an amount String() cannot convert, so this case has its
 * own file (scripts/test-consensus.sh runs each file in its own process).
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

describe("complex-policy amount parsing, object amounts", () => {
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
    it(`${context} logs a plain-object amount as JSON`, () => {
      // For example an RPC that returns { amount, decimals } where an amount string was expected.
      expect(parse({ amount: "5", decimals: 18 })).toBe(0n)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(`[loadgen] Non-critical error in ${context}`)
      expect(errors[0]).toContain(String.raw`{"value":"{\"amount\":\"5\",\"decimals\":18}"}`)
      expect(errors[0]).not.toContain("\"value\":\"[object Object]\"")
    })
  }
})
