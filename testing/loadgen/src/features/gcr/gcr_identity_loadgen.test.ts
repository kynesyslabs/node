/**
 * The node lets one source address send 4 identity confirms per block and
 * answers the rest with HTTP 429 (src/libs/network/rpcRateLimit.ts). The
 * loadgen must start few enough workers by default to stay inside that, and
 * treat a 429 as back-pressure: wait for the next block and retry the step.
 *
 * The fake node below applies the same per-block rule. Requests reach it
 * through the real SDK transport (Demos.call), so the 429 arrives in the shape
 * the loadgen sees against a real node; only signing and nonces are stubbed.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { ConfirmError, RateLimitError, normalizeLoadgenError } from "../../framework/errors"
import {
  IDENTITY_CONFIRMS_PER_BLOCK,
  countStepFailure,
  errorRateOf,
  resolveWorkerCount,
  retryOnRateLimit,
  submitPqcTx,
  waitForNextBlock,
  workerCountWarnings,
  workerRateLimitRetry,
  type LoadgenConfig,
  type LoadgenCounters,
  type RateLimitRetry,
} from "./gcr_identity_loadgen"

describe("resolveWorkerCount", () => {
  it("defaults to 4 workers per target", () => {
    expect(IDENTITY_CONFIRMS_PER_BLOCK).toBe(4)
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 4 })).toEqual({ workers: 4, cap: 4 })
    expect(resolveWorkerCount({ requested: "", targetCount: 2, walletCount: 8 })).toEqual({ workers: 8, cap: 8 })
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 10 }).workers).toBe(4)
  })

  it("does not default to more workers than wallets", () => {
    expect(resolveWorkerCount({ requested: undefined, targetCount: 3, walletCount: 4 }).workers).toBe(4)
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 2 }).workers).toBe(2)
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 0 }).workers).toBe(1)
  })

  it("lets an explicit CONCURRENCY win", () => {
    expect(resolveWorkerCount({ requested: "6", targetCount: 1, walletCount: 4 })).toEqual({ workers: 6, cap: 4 })
    expect(resolveWorkerCount({ requested: "8", targetCount: 2, walletCount: 4 })).toEqual({ workers: 8, cap: 8 })
    expect(resolveWorkerCount({ requested: "1", targetCount: 1, walletCount: 4 })).toEqual({ workers: 1, cap: 4 })
    expect(resolveWorkerCount({ requested: "0", targetCount: 1, walletCount: 4 }).workers).toBe(1)
  })

  it("ignores a CONCURRENCY that is not a number", () => {
    expect(resolveWorkerCount({ requested: "many", targetCount: 1, walletCount: 4 })).toEqual({ workers: 4, cap: 4 })
  })
})

describe("workerCountWarnings", () => {
  const config = (concurrency: number, workerCap: number, walletCount: number, targetCount = 1) => ({
    concurrency,
    workerCap,
    rpcUrls: Array.from({ length: targetCount }, (_, i) => `http://node${i}:53550`),
    wallets: Array.from({ length: walletCount }, (_, i) => `wallet ${i}`),
  })

  it("warns above the cap, with the cap from config.workerCap", () => {
    const over = workerCountWarnings(config(6, 4, 6))
    expect(over).toHaveLength(1)
    expect(over[0]).toContain("CONCURRENCY=6 is above 4 (4 identity confirms per block per node x 1 target(s)")
    expect(workerCountWarnings(config(9, 8, 9, 2))[0]).toContain("CONCURRENCY=9 is above 8")
    // The printed cap is the configured one, not recomputed from the targets.
    expect(workerCountWarnings(config(6, 5, 6))[0]).toContain("CONCURRENCY=6 is above 5")
    expect(workerCountWarnings(config(4, 4, 4))).toEqual([])
    expect(workerCountWarnings(config(8, 8, 8, 2))).toEqual([])
  })

  it("warns once when workers share a wallet", () => {
    expect(workerCountWarnings(config(3, 4, 2))).toEqual([
      "[gcr_identity_loadgen] 3 workers but 2 wallet(s): workers will share wallets and their nonces.",
    ])
    expect(workerCountWarnings(config(2, 4, 2))).toEqual([])
    expect(workerCountWarnings(config(1, 4, 1))).toEqual([])

    const both = workerCountWarnings(config(6, 4, 2))
    expect(both).toHaveLength(2)
    expect(both[0]).toContain("CONCURRENCY=6 is above 4")
    expect(both[1]).toContain("6 workers but 2 wallet(s): workers will share wallets and their nonces")
  })
})

type FakeNode = {
  url: string
  /** Block of each accepted / rejected identity confirm, in arrival order. */
  accepted: number[]
  rejected: number[]
  broadcasts: number
  nextBlock: () => void
  stop: () => void
}

/** One node, one client address. Blocks advance only when the test says so. */
function startFakeNode(): FakeNode {
  let block = 1
  let countedBlock = -1
  let countInBlock = 0
  const node = {
    accepted: [] as number[],
    rejected: [] as number[],
    broadcasts: 0,
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "GET") return new Response("ok")
      const body: any = await req.json()
      const param = body?.params?.[0]
      if (body?.method === "nodeCall" && param?.message === "getLastBlockNumber") {
        return Response.json({ result: 200, response: block, require_reply: false, extra: null })
      }
      if (body?.method === "execute" && param?.extra === "confirmTx" && param?.data?.content?.data?.[0] === "identity") {
        // Same rule as handleIdentityTxRateLimit: count, then refuse past the cap.
        if (countedBlock === block) countInBlock++
        else {
          countedBlock = block
          countInBlock = 1
        }
        if (countInBlock > IDENTITY_CONFIRMS_PER_BLOCK) {
          node.rejected.push(block)
          return Response.json({ error: "Rate limit exceeded", retryAfter: null }, { status: 429 })
        }
        node.accepted.push(block)
        return Response.json({ result: 200, response: { data: { valid: true } }, require_reply: false, extra: null })
      }
      if (body?.method === "execute" && param?.extra === "broadcastTx") {
        node.broadcasts++
        return Response.json({ result: 200, response: { message: "ok" }, require_reply: false, extra: null })
      }
      return Response.json({ result: 400, response: "unknown message", require_reply: false, extra: null })
    },
  })
  return Object.assign(node, {
    url: `http://127.0.0.1:${server.port}`,
    nextBlock: () => {
      block++
    },
    stop: () => server.stop(true),
  })
}

/** A Demos whose transport is the real SDK's; signing and nonces are stubbed. */
async function demosWithSdkTransport(rpcUrl: string): Promise<Demos> {
  const transport = new Demos()
  await transport.connect(rpcUrl)
  await transport.connectWallet(transport.newMnemonic(), { algorithm: "ed25519" })
  return {
    getAddressNonce: async () => 0,
    tx: { empty: () => ({ content: {} }) },
    crypto: { sign: async () => ({ signature: new Uint8Array(64) }) },
    sign: async (tx: unknown) => tx,
    call: (...args: unknown[]) => (transport as any).call(...args),
  } as unknown as Demos
}

async function until(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the fake node")
    await Bun.sleep(5)
  }
}

const OWNER = "0x" + "11".repeat(32)

function freshCounters(): LoadgenCounters {
  return {
    startedAtMs: 0,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    confirmError: 0,
    broadcastError: 0,
    validationError: 0,
    networkError: 0,
    rateLimited: 0,
    rateLimitedAtDeadline: 0,
    rateLimitRetries: 0,
    cleanupError: 0,
  }
}
const identity = (i: number) => "0x" + i.toString(16).padStart(64, "0")

describe("identity confirm 429", () => {
  let node: FakeNode | null = null
  afterEach(() => {
    node?.stop()
    node = null
  })

  function addStep(demos: Demos, i: number) {
    return () => submitPqcTx({ demos, ownerAddress: OWNER, algorithm: "falcon", identityAddress: identity(i), operation: "add", opTimeoutMs: 5000 })
  }

  it("waits for the next block and retries the same step", async () => {
    node = startFakeNode()
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    let retries = 0
    const retry: RateLimitRetry = {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: () => waitForNextBlock(fake.url, 5000, 10),
      onRetry: () => {
        retries++
      },
    }

    // Six workers on one node, two more than the cap.
    const steps = Array.from({ length: 6 }, (_, i) => retryOnRateLimit(addStep(demos, i), retry))
    await until(() => fake.accepted.length + fake.rejected.length === 6)
    expect(fake.accepted).toEqual([1, 1, 1, 1])
    expect(fake.rejected).toEqual([1, 1])
    await until(() => retries === 2 && fake.broadcasts === 4)

    // The two refused steps are still waiting for block 2, not failed.
    await Bun.sleep(50)
    expect(fake.accepted.length).toBe(4)
    fake.nextBlock()

    await Promise.all(steps)
    expect(fake.accepted).toEqual([1, 1, 1, 1, 2, 2])
    expect(fake.rejected).toEqual([1, 1])
    expect(retries).toBe(2)
    expect(fake.broadcasts).toBe(6)
  })

  it("stops at the first 429 when stopOnRateLimit is set", async () => {
    node = startFakeNode()
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    let retries = 0
    const retry: RateLimitRetry = {
      stopOnRateLimit: true,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: () => waitForNextBlock(fake.url, 5000, 10),
      onRetry: () => {
        retries++
      },
    }
    for (let i = 0; i < IDENTITY_CONFIRMS_PER_BLOCK; i++) await retryOnRateLimit(addStep(demos, i), retry)

    const error = await retryOnRateLimit(addStep(demos, 99), retry).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RateLimitError)
    expect(normalizeLoadgenError(error).message).toContain("HTTP 429")
    expect(retries).toBe(0)
    expect(fake.rejected).toEqual([1])
  })

  it("gives up after maxRetries blocks and never retries other errors", async () => {
    let attempts = 0
    let waits = 0
    const retry: RateLimitRetry = {
      stopOnRateLimit: false,
      maxRetries: 2,
      shouldStop: () => false,
      waitForNextBlock: async () => {
        waits++
      },
      onRetry: () => {},
    }
    const limited = await retryOnRateLimit(async () => {
      attempts++
      throw new RateLimitError("confirm (add): node answered HTTP 429 (rate limit)")
    }, retry).catch((caught: unknown) => caught)
    expect(limited).toBeInstanceOf(RateLimitError)
    expect(attempts).toBe(3)
    expect(waits).toBe(2)

    attempts = 0
    waits = 0
    const failed = await retryOnRateLimit(async () => {
      attempts++
      throw new ConfirmError("confirm failed (add): invalid")
    }, retry).catch((caught: unknown) => caught)
    expect(failed).toBeInstanceOf(ConfirmError)
    expect(attempts).toBe(1)
    expect(waits).toBe(0)
  })

  it("stops retrying once the run is stopping", async () => {
    let attempts = 0
    const limited = await retryOnRateLimit(async () => {
      attempts++
      throw new RateLimitError("confirm (add): node answered HTTP 429 (rate limit)")
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => true,
      waitForNextBlock: async () => {},
      onRetry: () => {},
    }).catch((caught: unknown) => caught)
    expect(limited).toBeInstanceOf(RateLimitError)
    expect(attempts).toBe(1)
  })

  it("a worker's step waiting out 429s stops retrying once the run deadline passes", async () => {
    node = startFakeNode()
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    for (let i = 0; i < IDENTITY_CONFIRMS_PER_BLOCK; i++) await addStep(demos, i)()

    const counters = { rateLimitRetries: 0 } as LoadgenCounters
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 3, settleTimeoutSec: 1, settlePollMs: 10 } as LoadgenConfig
    const sharedStop = { value: false }
    // The run ends while the step waits for a block that never comes (the
    // wait gives up after settleTimeoutSec and the confirm is refused again).
    const retry = workerRateLimitRetry({ rpcUrl: fake.url, cfg, counters, sharedStop, stopAtMs: Date.now() + 300 })
    const error = await retryOnRateLimit(addStep(demos, 99), retry).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RateLimitError)
    expect(sharedStop.value).toBe(false)
    // One wait, started before the deadline; the 429 after it ends the step.
    expect(counters.rateLimitRetries).toBe(1)
    expect(fake.rejected).toEqual([1, 1])
    expect(fake.accepted).toEqual([1, 1, 1, 1])
  })

  it("a 429 that ends a worker's step after the run deadline is counted apart and is not an error", async () => {
    node = startFakeNode()
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    const counters = freshCounters()
    for (let i = 0; i < IDENTITY_CONFIRMS_PER_BLOCK; i++) {
      counters.total++
      await addStep(demos, i)()
      counters.ok++
    }

    // A fifth step in the same block is refused. The run ends while it waits
    // for a block that never comes, so its 429 reaches the worker after the deadline.
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 3, settleTimeoutSec: 1, settlePollMs: 10 } as LoadgenConfig
    const stopAtMs = Date.now() + 300
    const retry = workerRateLimitRetry({ rpcUrl: fake.url, cfg, counters, sharedStop: { value: false }, stopAtMs })
    counters.total++
    const error = await retryOnRateLimit(addStep(demos, 99), retry).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RateLimitError)
    expect(Date.now()).toBeGreaterThanOrEqual(stopAtMs)

    expect(countStepFailure(counters, error, stopAtMs)).toBe("rateLimitedAtDeadline")
    expect(counters.rateLimitedAtDeadline).toBe(1)
    expect(counters.rateLimited).toBe(0)
    // The unfinished step stays in total but does not raise the error rate.
    expect(counters.total).toBe(5)
    expect(errorRateOf(counters)).toEqual({ errorCount: 0, errorRate: 0 })
  })

  it("a 429 that ends a step before the run deadline is still an error", () => {
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    const error = new RateLimitError("confirm (add): node answered HTTP 429 (rate limit)")
    expect(countStepFailure(counters, error, Date.now() + 60_000)).toBe("rateLimited")
    expect(counters.rateLimited).toBe(1)
    expect(counters.rateLimitedAtDeadline).toBe(0)
    expect(errorRateOf(counters)).toEqual({ errorCount: 1, errorRate: 0.5 })
  })

  it("waitForNextBlock returns once the block moves, and false when it does not", async () => {
    node = startFakeNode()
    const fake = node
    expect(await waitForNextBlock(fake.url, 100, 10)).toBe(false)
    setTimeout(() => fake.nextBlock(), 30)
    expect(await waitForNextBlock(fake.url, 2000, 10)).toBe(true)
  })
})
