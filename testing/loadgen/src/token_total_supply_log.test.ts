/**
 * The mint and burn smoke tests poll token.get for totalSupply and log a value that
 * BigInt() rejects (#708). The peer chooses that value and its size, so the log
 * record must stay bounded and must not carry raw control characters.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("@kynesyslabs/demosdk/websdk", () => ({ Demos: class {} }))

const { waitForTotalSupplyDelta } = await import("./token_mint_smoke")
const { waitForTotalSupplyDecrease } = await import("./token_burn_smoke")

// C0 and C1 controls, DEL and the bidi embedding, override and isolate controls.
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]/u

// 1,000,001 characters: a forged log line and controls up front, then digits, then
// a letter so BigInt() throws.
const FORGED = "\u001b[2K\n[loadgen] Non-critical error in token_mint_smoke: none\r\u{202e}\u0085\u007f"
const BAD_TOTAL = FORGED + "9".repeat(1_000_000 - FORGED.length) + "x"

const cases = [
  { name: "token_mint_smoke", wait: waitForTotalSupplyDelta, goodTotal: "15" },
  { name: "token_burn_smoke", wait: waitForTotalSupplyDecrease, goodTotal: "5" },
]

describe.each(cases)("$name waitForTotalSupply", ({ name, wait, goodTotal }) => {
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    // First poll returns the malformed supply, later polls a supply that meets the target.
    const totals = [BAD_TOTAL, goodTotal]
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      const totalSupply = totals.length > 1 ? totals.shift() : totals[0]
      return new Response(JSON.stringify({ result: 200, response: { state: { totalSupply } } }))
    }) as unknown as typeof fetch)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    fetchSpy.mockRestore()
  })

  it("logs a 1,000,001-character totalSupply as one record under 2,000 bytes", async () => {
    expect(BAD_TOTAL).toHaveLength(1_000_001)

    const total = await wait({ rpcUrl: "http://node-1:53550", tokenAddress: "0xtoken", before: 10n, delta: 5n, timeoutSec: 10 })

    expect(total).toBe(BigInt(goodTotal))
    expect(errors).toHaveLength(1)
    const record = errors[0]
    expect(Buffer.byteLength(record, "utf8")).toBeLessThan(2_000)
    expect(record).not.toMatch(RAW_CONTROL)
    expect(record).toStartWith(`[loadgen] Non-critical error in ${name}.waitForTotalSupply: `)
    expect(record).toContain(`"rpcUrl":"http://node-1:53550","tokenAddress":"0xtoken"`)
    expect(record).toContain(`"totalSupply":"\\u001b[2K\\n[loadgen] Non-critical error in token_mint_smoke: none\\r\\u202e\\u0085\\u007f999`)
    expect(record).toContain("…(1000001 chars)")
  })
})
