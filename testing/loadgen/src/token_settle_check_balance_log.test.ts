/**
 * A settled balance that BigInt() cannot parse falls back to "not present" in the
 * holder-pointer check. Bun's BigInt error does not name the value, so the log
 * record must carry the balance text itself (#708).
 *
 * Run this file in its own `bun test` process (scripts/test-consensus.sh does):
 * Bun's mock.module of ./token_shared and ./framework/io lasts for the whole process.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

const GOOD = "0x" + "a".repeat(64)
const BAD = "0x" + "b".repeat(64)

let holderPointerParams: { expectedPresent: Record<string, boolean> } | null = null

mock.module("./token_shared", () => ({
  getTokenTargets: () => ["http://node-a:53550"],
  getWalletAddresses: async () => [],
  maybeSilenceConsole: () => {},
  nodeCall: async () => null,
  readWalletMnemonics: async () => [],
  waitForCrossNodeHolderPointersMatchBalances: async (params: { expectedPresent: Record<string, boolean> }) => {
    holderPointerParams = params
    return { ok: true }
  },
  waitForCrossNodeTokenConsistency: async () => ({
    ok: true,
    perNode: [{ snapshot: { balances: { [GOOD]: "5", [BAD]: "12abc" } } }],
  }),
  waitForRpcReady: async () => {},
  waitForTxReady: async () => {},
}))

mock.module("./framework/io", () => ({
  getRunConfig: () => ({ runId: "test", runDir: "/nonexistent" }),
  writeJson: () => {},
}))

const { runTokenSettleCheck } = await import("./token_settle_check")

const ENV = {
  TOKEN_ADDRESS: "0x" + "c".repeat(64),
  ADDRESSES: `${GOOD},${BAD}`,
  SETTLE_WALLETS: "0",
  BLOCK_SYNC_ENABLE: "0",
  MEMPOOL_DRAIN_ENABLE: "0",
  HOLDER_POINTER_CHECK: "true",
  EXPECT_SCRIPT: "false",
}

describe("token_settle_check expectedPresent", () => {
  const savedEnv: Record<string, string | undefined> = {}
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    logSpy = spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    logSpy.mockRestore()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("logs the balance text it cannot parse and still treats it as not present", async () => {
    await runTokenSettleCheck()

    expect(holderPointerParams?.expectedPresent).toEqual({ [GOOD]: true, [BAD]: false })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStartWith("[loadgen] Non-critical error in token_settle_check.expectedPresent: ")
    expect(errors[0]).toEndWith(` {"address":"${BAD}","balance":"12abc"}`)
  })
})
