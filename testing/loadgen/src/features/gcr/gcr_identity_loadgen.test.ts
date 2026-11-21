/**
 * The node lets one source address send 4 identity confirms per block and
 * answers the rest with HTTP 429 (src/libs/network/rpcRateLimit.ts). The
 * loadgen must start few enough workers by default to stay inside that, and
 * treat a 429 as back-pressure: wait for the next block and retry the step.
 *
 * The fake node below applies the same per-block rule. Requests reach it
 * through the real SDK transport (Demos.call), so the 429 arrives in the shape
 * the loadgen sees against a real node; only signing and nonces are stubbed.
 *
 * Block numbers are read through the fake node's own reader (the
 * readBlockNumber option), never through framework/rpc's nodeCall: other
 * loadgen tests mock that module, and bun keeps a module mock for the whole
 * process, so these tests must pass whichever nodeCall is loaded.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { ConfirmError, RateLimitError, loadgenErrorFromMessage, normalizeLoadgenError } from "../../framework/errors"
import {
  IDENTITY_CONFIRMS_PER_BLOCK,
  cleanupWorkerIdentities,
  countStepFailure,
  errorRateOf,
  getConfig,
  http429LimiterOf,
  resolveWorkerCount,
  retryOnRateLimit,
  runVerdict,
  submitPqcTx,
  waitForNextBlock,
  workerCountWarnings,
  workerRateLimitRetry,
  workerRpcUrl,
  type LoadgenConfig,
  type LoadgenCounters,
  type RateLimitRetry,
  type ReadBlockNumber,
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

  it("uses an explicit CONCURRENCY at or below the cap as given", () => {
    expect(resolveWorkerCount({ requested: "8", targetCount: 2, walletCount: 4 })).toEqual({ workers: 8, cap: 8 })
    expect(resolveWorkerCount({ requested: "3", targetCount: 1, walletCount: 4 })).toEqual({ workers: 3, cap: 4 })
    expect(resolveWorkerCount({ requested: "1", targetCount: 1, walletCount: 4 })).toEqual({ workers: 1, cap: 4 })
    expect(resolveWorkerCount({ requested: "0", targetCount: 1, walletCount: 4 }).workers).toBe(1)
  })

  it("clamps an explicit CONCURRENCY above the cap, unless overCap is set", () => {
    expect(resolveWorkerCount({ requested: "6", targetCount: 1, walletCount: 4 })).toEqual({ workers: 4, cap: 4, clampedFrom: 6 })
    expect(resolveWorkerCount({ requested: "50", targetCount: 4, walletCount: 50 })).toEqual({ workers: 16, cap: 16, clampedFrom: 50 })
    expect(resolveWorkerCount({ requested: "6", targetCount: 1, walletCount: 4, overCap: true })).toEqual({ workers: 6, cap: 4 })
    expect(resolveWorkerCount({ requested: "50", targetCount: 4, walletCount: 50, overCap: true })).toEqual({ workers: 50, cap: 16 })
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

  it("counts a target listed twice once", () => {
    const cfg = { ...config(6, 4, 6), rpcUrls: ["http://node0:53550", "http://node0:53550/"] }
    expect(workerCountWarnings(cfg)[0]).toContain("CONCURRENCY=6 is above 4 (4 identity confirms per block per node x 1 target(s)")
  })
})

describe("getConfig", () => {
  const saved = {
    TARGETS: process.env.TARGETS,
    CONCURRENCY: process.env.CONCURRENCY,
    GCR_IDENTITY_OVER_CAP: process.env.GCR_IDENTITY_OVER_CAP,
  }
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  /** getConfig's result and the lines it logged with console.warn. */
  function configWithWarnings(wallets: string[]): { cfg: LoadgenConfig; warnings: string[] } {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cfg = getConfig(wallets)
      return { cfg, warnings: warn.mock.calls.map(call => String(call[0])) }
    } finally {
      warn.mockRestore()
    }
  }

  it("clamps CONCURRENCY=50 (the Docker perf default) to the cap of 4 distinct targets", () => {
    const wallets = Array.from({ length: 50 }, (_, i) => `wallet ${i}`)
    process.env.TARGETS = "http://a:1,http://b:1,http://c:1,http://d:1,http://a:1/"
    process.env.CONCURRENCY = "50"
    delete process.env.GCR_IDENTITY_OVER_CAP
    const clamped = configWithWarnings(wallets)
    expect(clamped.cfg.workerCap).toBe(16)
    expect(clamped.cfg.concurrency).toBe(16)
    expect(clamped.warnings).toEqual([
      "[gcr_identity_loadgen] CONCURRENCY=50 is above the identity confirm cap of 16; using 16, set GCR_IDENTITY_OVER_CAP=true to keep 50.",
    ])

    process.env.GCR_IDENTITY_OVER_CAP = "true"
    const over = configWithWarnings(wallets)
    expect(over.cfg.concurrency).toBe(50)
    // The flag keeps the over-cap warning, and there is no clamp line.
    expect(over.warnings).toHaveLength(1)
    expect(over.warnings[0]).toContain("CONCURRENCY=50 is above 16")

    delete process.env.GCR_IDENTITY_OVER_CAP
    process.env.CONCURRENCY = "3"
    const below = configWithWarnings(wallets)
    expect(below.cfg.concurrency).toBe(3)
    expect(below.warnings).toEqual([])
  })

  it("gives TARGETS=a,a the same worker cap as TARGETS=a", () => {
    const wallets = Array.from({ length: 8 }, (_, i) => `wallet ${i}`)
    delete process.env.CONCURRENCY
    process.env.TARGETS = "http://node0:53550"
    const single = getConfig(wallets)
    process.env.TARGETS = "http://node0:53550,http://node0:53550/"
    const twice = getConfig(wallets)

    expect(single.workerCap).toBe(4)
    expect(twice.workerCap).toBe(single.workerCap)
    expect(twice.concurrency).toBe(single.concurrency)
    // rpcUrls stays as given; workers are spread over the distinct targets.
    expect(twice.rpcUrls).toEqual(["http://node0:53550/", "http://node0:53550/"])
    expect(twice.targetUrls).toEqual(["http://node0:53550/"])
  })

  const workersPerNode = (cfg: LoadgenConfig) => {
    const counts: Record<string, number> = {}
    for (let idx = 0; idx < cfg.concurrency; idx++) {
      const url = workerRpcUrl(cfg, idx)
      counts[url] = (counts[url] ?? 0) + 1
    }
    return counts
  }

  it("spreads the default workers evenly over the distinct targets", () => {
    const wallets = Array.from({ length: 20 }, (_, i) => `wallet ${i}`)
    delete process.env.CONCURRENCY
    process.env.TARGETS = "http://a:1,http://a:1,http://b:1"
    const cfg = getConfig(wallets)

    expect(cfg.workerCap).toBe(8)
    expect(cfg.concurrency).toBe(8)
    expect(cfg.targetUrls).toEqual(["http://a:1/", "http://b:1/"])
    // Round-robin over rpcUrls as given would put 6 workers on a and 2 on b.
    expect(workersPerNode(cfg)).toEqual({ "http://a:1/": 4, "http://b:1/": 4 })

    process.env.TARGETS = "http://a:1,http://b:1"
    expect(workersPerNode(getConfig(wallets))).toEqual({ "http://a:1/": 4, "http://b:1/": 4 })
  })
})

type FakeNode = {
  url: string
  /** Block of each accepted / rejected identity confirm, in arrival order. */
  accepted: number[]
  rejected: number[]
  broadcasts: number
  nextBlock: () => void
  /** The node's last block number, for waitForNextBlock's readBlockNumber. */
  readBlock: ReadBlockNumber
  stop: () => void
}

/**
 * The general limiter's 429 for a blocked address (rateLimiter.ts
 * blockedResponse): a Retry-After header and a numeric body retryAfter. Each
 * can be left out to check that either one marks it.
 */
type IpBlockReply = { retryAfterHeader: string | null; retryAfter: number | null }

/**
 * One node, one client address. Blocks advance only when the test says so.
 * With ipBlock, every identity confirm gets the general limiter's 429 instead.
 */
function startFakeNode(ipBlock?: IpBlockReply): FakeNode {
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
      if (body?.method === "execute" && param?.extra === "confirmTx" && param?.data?.content?.data?.[0] === "identity") {
        if (ipBlock) {
          node.rejected.push(block)
          const headers: Record<string, string> = { "Content-Type": "application/json" }
          if (ipBlock.retryAfterHeader !== null) headers["Retry-After"] = ipBlock.retryAfterHeader
          return new Response(JSON.stringify({ error: "Rate limit exceeded", retryAfter: ipBlock.retryAfter }), { status: 429, headers })
        }
        // Same rule as handleIdentityTxRateLimit: count, then refuse past the cap.
        if (countedBlock === block) countInBlock++
        else {
          countedBlock = block
          countInBlock = 1
        }
        if (countInBlock > IDENTITY_CONFIRMS_PER_BLOCK) {
          node.rejected.push(block)
          // The cap's reply as rpcRateLimit.ts sends it: no Retry-After header, no content type.
          return new Response(JSON.stringify({ error: "Rate limit exceeded", retryAfter: null }), { status: 429 })
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
    readBlock: async () => block,
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
/** The error submitPqcTx throws for the per-block cap's HTTP 429. */
const http429 = () =>
  new RateLimitError("confirm (add): node answered HTTP 429 (rate limit)", {
    operation: "add",
    status: 429,
    httpStatus: 429,
    limiter: "identity_cap",
  })
/** A rate-limit error from the node's text, with no HTTP 429 (loadgenErrorFromMessage). */
const ipBlocked = () => loadgenErrorFromMessage("confirm failed (add): IP blocked due to rate limiting", { operation: "add" })

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
    let waits = 0
    const retry: RateLimitRetry = {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: () => {
        waits++
        return waitForNextBlock(fake.url, 5000, 10, fake.readBlock)
      },
      onRetry: () => {
        retries++
      },
    }

    // Six workers on one node, two more than the cap.
    const steps = Array.from({ length: 6 }, (_, i) => retryOnRateLimit(addStep(demos, i), retry))
    await until(() => fake.accepted.length + fake.rejected.length === 6)
    expect(fake.accepted).toEqual([1, 1, 1, 1])
    expect(fake.rejected).toEqual([1, 1])
    await until(() => waits === 2 && fake.broadcasts === 4)

    // The two refused steps are still waiting for block 2, not failed, and
    // are not counted as retries until they are sent again.
    await Bun.sleep(50)
    expect(fake.accepted.length).toBe(4)
    expect(retries).toBe(0)
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
      waitForNextBlock: () => waitForNextBlock(fake.url, 5000, 10, fake.readBlock),
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
        return true
      },
      onRetry: () => {},
    }
    const limited = await retryOnRateLimit(async () => {
      attempts++
      throw http429()
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
      throw http429()
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => true,
      waitForNextBlock: async () => true,
      onRetry: () => {},
    }).catch((caught: unknown) => caught)
    expect(limited).toBeInstanceOf(RateLimitError)
    expect(attempts).toBe(1)
  })

  it("ends the step with its 429 when no new block arrives in time", async () => {
    let attempts = 0
    let waits = 0
    let retries = 0
    const refused = http429()
    const limited = await retryOnRateLimit(async () => {
      attempts++
      throw refused
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: async () => {
        waits++
        return false
      },
      onRetry: () => {
        retries++
      },
    }).catch((caught: unknown) => caught)
    expect(limited).toBe(refused)
    expect(attempts).toBe(1)
    expect(waits).toBe(1)
    expect(retries).toBe(0)
  })

  it("counts one retry when the next block arrives and the second attempt succeeds", async () => {
    let attempts = 0
    let retries = 0
    const result = await retryOnRateLimit(async () => {
      attempts++
      if (attempts === 1) throw http429()
      return "added"
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: async () => true,
      onRetry: () => {
        retries++
      },
    })
    expect(result).toBe("added")
    expect(attempts).toBe(2)
    expect(retries).toBe(1)
  })

  it("does not run the step again when the run ends during the block wait", async () => {
    let attempts = 0
    let stopping = false
    const refused = http429()
    const limited = await retryOnRateLimit(async () => {
      attempts++
      throw refused
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => stopping,
      waitForNextBlock: async () => {
        stopping = true
        return true
      },
      onRetry: () => {},
    }).catch((caught: unknown) => caught)
    expect(limited).toBe(refused)
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
    // wait gives up after settleTimeoutSec, past the deadline).
    const retry = workerRateLimitRetry({
      rpcUrl: fake.url,
      cfg,
      counters,
      sharedStop,
      stopAtMs: Date.now() + 300,
      readBlockNumber: fake.readBlock,
    })
    const error = await retryOnRateLimit(addStep(demos, 99), retry).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RateLimitError)
    expect(sharedStop.value).toBe(false)
    // One wait, started before the deadline. The run has ended when it gives
    // up, so the step is not sent again, its first 429 ends it, and no retry
    // is counted.
    expect(counters.rateLimitRetries).toBe(0)
    expect(fake.rejected).toEqual([1])
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
    // for a block that never comes, so its 429 is rethrown to the worker after the deadline.
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 3, settleTimeoutSec: 1, settlePollMs: 10 } as LoadgenConfig
    const stopAtMs = Date.now() + 300
    const retry = workerRateLimitRetry({
      rpcUrl: fake.url,
      cfg,
      counters,
      sharedStop: { value: false },
      stopAtMs,
      readBlockNumber: fake.readBlock,
    })
    counters.total++
    const error = await retryOnRateLimit(addStep(demos, 99), retry).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RateLimitError)
    expect(Date.now()).toBeGreaterThanOrEqual(stopAtMs)

    expect(countStepFailure(counters, error, stopAtMs, cfg.stopOnRateLimit)).toBe("rateLimitedAtDeadline")
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
    expect(countStepFailure(counters, http429(), Date.now() + 60_000, false)).toBe("rateLimited")
    expect(counters.rateLimited).toBe(1)
    expect(counters.rateLimitedAtDeadline).toBe(0)
    expect(errorRateOf(counters)).toEqual({ errorCount: 1, errorRate: 0.5 })
  })

  it("with stopOnRateLimit, a 429 at the run deadline is still an error", () => {
    // No retries then, so the 429 refused the step, it did not just outlast the run.
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    expect(countStepFailure(counters, http429(), Date.now() - 1, true)).toBe("rateLimited")
    expect(counters.rateLimited).toBe(1)
    expect(counters.rateLimitedAtDeadline).toBe(0)
    expect(errorRateOf(counters)).toEqual({ errorCount: 1, errorRate: 0.5 })
  })

  it.each([
    { label: "IP blocked", error: ipBlocked() },
    { label: "rate limit text", error: loadgenErrorFromMessage("confirm failed (add): rate limit") },
    { label: "RPC result 429 without an HTTP status", error: new RateLimitError("rate limit", { status: 429, httpStatus: null }) },
    { label: "HTTP 403", error: new RateLimitError("rate limit", { status: 429, httpStatus: 403 }) },
  ])("does not retry $label", async ({ error: blocked }) => {
    let attempts = 0
    let waits = 0
    const retry: RateLimitRetry = {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: async () => {
        waits++
        return true
      },
      onRetry: () => {},
    }
    expect(blocked).toBeInstanceOf(RateLimitError)
    const error = await retryOnRateLimit(async () => {
      attempts++
      throw blocked
    }, retry).catch((caught: unknown) => caught)
    expect(error).toBe(blocked)
    expect(attempts).toBe(1)
    expect(waits).toBe(0)
  })

  it.each([
    { label: "a Retry-After header and body retryAfter", ipBlock: { retryAfterHeader: "30", retryAfter: 30 } },
    { label: "a Retry-After header", ipBlock: { retryAfterHeader: "30", retryAfter: null } },
    { label: "body retryAfter", ipBlock: { retryAfterHeader: null, retryAfter: 30 } },
  ])("does not retry the general limiter's HTTP 429 with $label", async ({ ipBlock }) => {
    node = startFakeNode(ipBlock)
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    let attempts = 0
    let waits = 0
    const error = await retryOnRateLimit(() => {
      attempts++
      return addStep(demos, 0)()
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: async () => {
        waits++
        fake.nextBlock()
        return true
      },
      onRetry: () => {},
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RateLimitError)
    expect(normalizeLoadgenError(error).context).toMatchObject({ httpStatus: 429, limiter: "ip_block" })
    expect(attempts).toBe(1)
    expect(waits).toBe(0)
    expect(fake.rejected).toEqual([1])
    // Not retried, so it is an error even at the run deadline.
    const counters = freshCounters()
    expect(countStepFailure(counters, error, Date.now() - 1, false)).toBe("rateLimited")
  })

  it("retries the identity confirm cap's HTTP 429 (no Retry-After, body retryAfter null)", async () => {
    node = startFakeNode()
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    for (let i = 0; i < IDENTITY_CONFIRMS_PER_BLOCK; i++) await addStep(demos, i)()

    const refused = await addStep(demos, 98)().catch((caught: unknown) => caught)
    expect(normalizeLoadgenError(refused).context).toMatchObject({ httpStatus: 429, limiter: "identity_cap" })

    let attempts = 0
    await retryOnRateLimit(() => {
      attempts++
      return addStep(demos, 99)()
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => false,
      waitForNextBlock: async () => {
        fake.nextBlock()
        return true
      },
      onRetry: () => {},
    })
    expect(attempts).toBe(2)
    expect(fake.rejected).toEqual([1, 1])
    expect(fake.accepted).toEqual([1, 1, 1, 1, 2])
  })

  it("counts a 429 with only a status (no headers or body) as the identity confirm cap", () => {
    expect(http429LimiterOf({ result: 500, response: { cause: { status: 429 } } })).toBe("identity_cap")
    expect(http429LimiterOf({ result: 500, response: { cause: { response: { status: 429 } } } })).toBe("identity_cap")
    expect(
      http429LimiterOf({ result: 500, response: { cause: { response: { status: 429, headers: { "retry-after": "5" } } } } }),
    ).toBe("ip_block")
  })

  it("an 'IP blocked' error after the run deadline is still counted as rateLimited", () => {
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    expect(countStepFailure(counters, ipBlocked(), Date.now() - 1, false)).toBe("rateLimited")
    expect(counters.rateLimited).toBe(1)
    expect(counters.rateLimitedAtDeadline).toBe(0)
    expect(errorRateOf(counters)).toEqual({ errorCount: 1, errorRate: 0.5 })
  })

  it("waitForNextBlock returns once the block moves, and false when it does not", async () => {
    node = startFakeNode()
    const fake = node
    expect(await waitForNextBlock(fake.url, 100, 10, fake.readBlock)).toBe(false)
    setTimeout(() => fake.nextBlock(), 30)
    expect(await waitForNextBlock(fake.url, 2000, 10, fake.readBlock)).toBe(true)
  })
})

describe("cleanupWorkerIdentities", () => {
  const leftover = identity(7)
  const report = { workerId: 0, rpcUrl: "http://node0:53550", ownerAddress: OWNER, outstanding: [leftover] }
  const cfg = { algorithm: "falcon", settleTimeoutSec: 1, settlePollMs: 10 }

  it("waits for a cleanup remove to show before the leak check", async () => {
    const counters = freshCounters()
    const removed: string[] = []
    let reads = 0
    const result = await cleanupWorkerIdentities({
      report,
      cfg,
      counters,
      errorSamples: [],
      removeIdentity: async address => {
        removed.push(address)
      },
      // The remove shows only from the second read on.
      readIdentities: async () => (++reads === 1 ? new Set([leftover]) : new Set()),
    })

    expect(removed).toEqual([leftover])
    expect(result).toEqual({ ownerAddress: OWNER, stillPresent: [] })
    expect(counters.cleanupError).toBe(0)
    expect(reads).toBe(3)
  })

  it("reports an identity still present after the settle timeout as leaked", async () => {
    const counters = freshCounters()
    const result = await cleanupWorkerIdentities({
      report,
      cfg,
      counters,
      errorSamples: [],
      removeIdentity: async () => {},
      readIdentities: async () => new Set([leftover]),
    })

    expect(result).toEqual({ ownerAddress: OWNER, stillPresent: [leftover] })
    expect(counters.cleanupError).toBe(0)
  })

  it("counts a failed cleanup remove as a cleanup error and does not wait for it", async () => {
    const counters = freshCounters()
    const errorSamples: Parameters<typeof cleanupWorkerIdentities>[0]["errorSamples"] = []
    let reads = 0
    const result = await cleanupWorkerIdentities({
      report,
      cfg,
      counters,
      errorSamples,
      removeIdentity: async () => {
        throw http429()
      },
      readIdentities: async () => {
        reads++
        return new Set([leftover])
      },
    })

    expect(result.stillPresent).toEqual([leftover])
    expect(counters.cleanupError).toBe(1)
    expect(errorSamples).toHaveLength(1)
    expect(reads).toBe(1)
  })
})

describe("runVerdict", () => {
  const verdict = (counters: LoadgenCounters) =>
    runVerdict({ counters, maxErrorRate: 0.05, leakedIdentityCount: 0, sampleCodeCounts: {} })

  it("fails a run with no successful step, even when every step ended in a 429 at the deadline", () => {
    // A node that answers 429 for the whole run: no step succeeds, and every
    // step is cut off at the deadline, so the error rate stays 0.
    const counters = { ...freshCounters(), total: 4, rateLimitedAtDeadline: 4 }
    expect(errorRateOf(counters)).toEqual({ errorCount: 0, errorRate: 0 })

    const result = verdict(counters)
    expect(result.ok).toBe(false)
    expect(result.primaryIssues).toContain("rate_limit")
  })

  it("passes a run with successful steps and a few 429s at the deadline", () => {
    const counters = { ...freshCounters(), total: 24, ok: 20, rateLimitedAtDeadline: 4 }
    expect(verdict(counters)).toEqual({ ok: true, primaryIssues: ["rate_limit"] })
  })

  it("still fails on the error rate and on leaked identities", () => {
    const counters = { ...freshCounters(), total: 10, ok: 8, confirmError: 2 }
    expect(verdict(counters)).toEqual({ ok: false, primaryIssues: ["tx_pipeline"] })
    const clean = { ...freshCounters(), total: 10, ok: 10 }
    expect(verdict(clean)).toEqual({ ok: true, primaryIssues: [] })
    expect(runVerdict({ counters: clean, maxErrorRate: 0.05, leakedIdentityCount: 1, sampleCodeCounts: {} })).toEqual({
      ok: false,
      primaryIssues: ["leaked_identities"],
    })
  })
})
