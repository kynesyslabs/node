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
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { ConfirmError, ConvergenceError, RateLimitError, loadgenErrorFromMessage, normalizeLoadgenError } from "../../framework/errors"
import { ReservoirSampler } from "../../framework/metrics"
import {
  IDENTITY_CONFIRMS_PER_BLOCK,
  cleanupWorkerIdentities,
  countStepFailure,
  errorRateOf,
  getConfig,
  http429LimiterOf,
  isCutOffAtDeadline,
  resolveWorkerCount,
  retryOnRateLimit,
  runVerdict,
  runWithTimeseries,
  submitPqcTx,
  waitForIdentityPresence,
  waitForNextBlock,
  workerCountWarnings,
  workerRateLimitRetry,
  workerRpcUrl,
  type LoadgenConfig,
  type LoadgenCounters,
  type RateLimitRetry,
  type ReadBlockNumber,
  type TimeseriesPoint,
  type WaitClock,
} from "./gcr_identity_loadgen"

/**
 * A fake clock for the block and settle waits, so they make no real waits.
 * Each sleep is a timer due at now + ms. Once nothing else can run, the
 * earliest timer fires and moves the clock to its due time. A sleep cancelled
 * by its signal never fires, so it does not move the clock. sleeps records
 * each sleep asked for.
 */
function fakeWaitClock(): WaitClock & { sleeps: number[] } {
  let nowMs = 0
  const sleeps: number[] = []
  const timers: { at: number; fire: () => void }[] = []
  let scheduled = false
  const schedule = () => {
    if (scheduled || timers.length === 0) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      timers.sort((a, b) => a.at - b.at)
      const next = timers.shift()
      if (!next) return
      nowMs = Math.max(nowMs, next.at)
      next.fire()
      schedule()
    })
  }
  return {
    sleeps,
    now: () => nowMs,
    sleep: (ms, signal) =>
      new Promise<void>(resolve => {
        sleeps.push(ms)
        const timer = { at: nowMs + ms, fire: resolve }
        timers.push(timer)
        signal?.addEventListener("abort", () => {
          const idx = timers.indexOf(timer)
          if (idx >= 0) timers.splice(idx, 1)
        })
        schedule()
      }),
  }
}

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

  it("uses an explicit CONCURRENCY at or below the cap and the wallet count as given", () => {
    expect(resolveWorkerCount({ requested: "8", targetCount: 2, walletCount: 8 })).toEqual({ workers: 8, cap: 8 })
    expect(resolveWorkerCount({ requested: "3", targetCount: 1, walletCount: 4 })).toEqual({ workers: 3, cap: 4 })
    expect(resolveWorkerCount({ requested: "1", targetCount: 1, walletCount: 4 })).toEqual({ workers: 1, cap: 4 })
    expect(resolveWorkerCount({ requested: "0", targetCount: 1, walletCount: 4 }).workers).toBe(1)
  })

  it("clamps an explicit CONCURRENCY above the cap, unless overCap is set", () => {
    expect(resolveWorkerCount({ requested: "6", targetCount: 1, walletCount: 4 })).toEqual({
      workers: 4,
      cap: 4,
      clampedFrom: 6,
      clampedBy: "cap",
    })
    expect(resolveWorkerCount({ requested: "50", targetCount: 4, walletCount: 50 })).toEqual({
      workers: 16,
      cap: 16,
      clampedFrom: 50,
      clampedBy: "cap",
    })
    expect(resolveWorkerCount({ requested: "6", targetCount: 1, walletCount: 4, overCap: true })).toEqual({ workers: 6, cap: 4 })
    expect(resolveWorkerCount({ requested: "50", targetCount: 4, walletCount: 50, overCap: true })).toEqual({ workers: 50, cap: 16 })
  })

  it("clamps an explicit CONCURRENCY above the wallet count to one worker per wallet, unless overCap is set", () => {
    // The Docker perf defaults: 4 targets, 4 wallets, CONCURRENCY=50.
    expect(resolveWorkerCount({ requested: "50", targetCount: 4, walletCount: 4 })).toEqual({
      workers: 4,
      cap: 16,
      clampedFrom: 50,
      clampedBy: "wallets",
    })
    expect(resolveWorkerCount({ requested: "50", targetCount: 4, walletCount: 20 })).toEqual({
      workers: 16,
      cap: 16,
      clampedFrom: 50,
      clampedBy: "cap",
    })
    expect(resolveWorkerCount({ requested: "8", targetCount: 2, walletCount: 4 })).toEqual({
      workers: 4,
      cap: 8,
      clampedFrom: 8,
      clampedBy: "wallets",
    })
    expect(resolveWorkerCount({ requested: "50", targetCount: 4, walletCount: 4, overCap: true })).toEqual({ workers: 50, cap: 16 })
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

  it("gives the Docker perf defaults (CONCURRENCY=50, 4 targets, 4 wallets) one worker per wallet", () => {
    process.env.TARGETS = "http://a:1,http://b:1,http://c:1,http://d:1"
    process.env.CONCURRENCY = "50"
    delete process.env.GCR_IDENTITY_OVER_CAP
    const fourWallets = Array.from({ length: 4 }, (_, i) => `wallet ${i}`)
    const perWallet = configWithWarnings(fourWallets)
    expect(perWallet.cfg.workerCap).toBe(16)
    expect(perWallet.cfg.concurrency).toBe(4)
    // One worker on each node, each with its own wallet.
    expect(workersPerNode(perWallet.cfg)).toEqual({ "http://a:1/": 1, "http://b:1/": 1, "http://c:1/": 1, "http://d:1/": 1 })
    expect(perWallet.warnings).toEqual([
      "[gcr_identity_loadgen] CONCURRENCY=50 is above the wallet count of 4 (workers sharing a wallet race on its nonce); " +
        "using 4, set GCR_IDENTITY_OVER_CAP=true to keep 50.",
    ])

    const twentyWallets = Array.from({ length: 20 }, (_, i) => `wallet ${i}`)
    const capped = configWithWarnings(twentyWallets)
    expect(capped.cfg.concurrency).toBe(16)
    expect(capped.warnings).toEqual([
      "[gcr_identity_loadgen] CONCURRENCY=50 is above the identity confirm cap of 16; using 16, set GCR_IDENTITY_OVER_CAP=true to keep 50.",
    ])

    process.env.GCR_IDENTITY_OVER_CAP = "true"
    const over = configWithWarnings(fourWallets)
    expect(over.cfg.concurrency).toBe(50)
    // No clamp line: the over-cap and shared-wallet warnings instead.
    expect(over.warnings).toHaveLength(2)
    expect(over.warnings[0]).toContain("CONCURRENCY=50 is above 16")
    expect(over.warnings[1]).toContain("50 workers but 4 wallet(s)")
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
/** A height reader for retries whose block wait is stubbed: the read fails. */
const noHeight = async (): Promise<number | null> => null

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
      readHeight: () => fake.readBlock(fake.url),
      waitForNextBlock: start => {
        waits++
        return waitForNextBlock(fake.url, 5000, 10, fake.readBlock, start)
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
      readHeight: () => fake.readBlock(fake.url),
      waitForNextBlock: start => waitForNextBlock(fake.url, 5000, 10, fake.readBlock, start),
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
      readHeight: noHeight,
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
      readHeight: noHeight,
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
      readHeight: noHeight,
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
      readHeight: noHeight,
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
      readHeight: noHeight,
      waitForNextBlock: async () => {
        stopping = true
        return true
      },
      onRetry: () => {},
    }).catch((caught: unknown) => caught)
    expect(limited).toBe(refused)
    expect(attempts).toBe(1)
  })

  it("does not send the retry when the run ends during the height read before it", async () => {
    let attempts = 0
    let reads = 0
    let retries = 0
    let stopping = false
    const refused = http429()
    const limited = await retryOnRateLimit(async () => {
      attempts++
      throw refused
    }, {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => stopping,
      // The second read, after the new block, is slow: the run ends during it.
      readHeight: async () => {
        reads++
        if (reads === 2) stopping = true
        return 100 + reads
      },
      waitForNextBlock: async () => true,
      onRetry: () => {
        retries++
      },
    }).catch((caught: unknown) => caught)
    expect(limited).toBe(refused)
    expect(attempts).toBe(1)
    expect(reads).toBe(2)
    expect(retries).toBe(0)
    expect(isCutOffAtDeadline(limited)).toBe(true)
  })

  it("reads no height before the last allowed attempt", async () => {
    // maxRetries 1: the second attempt cannot be retried, so nothing would use
    // a height read before it.
    let attempts = 0
    let reads = 0
    let waits = 0
    let retries = 0
    let last: unknown
    const limited = await retryOnRateLimit(async () => {
      attempts++
      last = http429()
      throw last
    }, {
      stopOnRateLimit: false,
      maxRetries: 1,
      shouldStop: () => false,
      readHeight: async () => {
        reads++
        return 100
      },
      waitForNextBlock: async () => {
        waits++
        return true
      },
      onRetry: () => {
        retries++
      },
    }).catch((caught: unknown) => caught)
    expect(limited).toBe(last)
    expect(limited).toBeInstanceOf(RateLimitError)
    expect(isCutOffAtDeadline(limited)).toBe(false)
    expect(attempts).toBe(2)
    expect(reads).toBe(1)
    expect(waits).toBe(1)
    expect(retries).toBe(1)
  })

  it("a worker's step waiting out 429s stops retrying once the run deadline passes", async () => {
    node = startFakeNode()
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    for (let i = 0; i < IDENTITY_CONFIRMS_PER_BLOCK; i++) await addStep(demos, i)()

    const counters = { rateLimitRetries: 0 } as LoadgenCounters
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 3, settleTimeoutSec: 1, settlePollMs: 10, opTimeoutMs: 15000 } as LoadgenConfig
    const sharedStop = { value: false }
    // The run ends while the step waits for a block that never comes. The test
    // ends it, not the wall clock: the first height read after the 429 (the
    // block wait's) moves the run deadline into the past, so however long the
    // step takes, the run is still on when its 429 arrives. The wait gives up
    // after settleTimeoutSec on a fake clock, after the deadline.
    let stopAtMs = Number.POSITIVE_INFINITY
    const retry = workerRateLimitRetry({
      rpcUrl: fake.url,
      cfg,
      counters,
      sharedStop,
      get stopAtMs() {
        return stopAtMs
      },
      readBlockNumber: rpcUrl => {
        if (fake.rejected.length > 0) stopAtMs = Number.NEGATIVE_INFINITY
        return fake.readBlock(rpcUrl)
      },
      clock: fakeWaitClock(),
    })
    const error = await retryOnRateLimit(addStep(demos, 99), retry).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RateLimitError)
    expect(sharedStop.value).toBe(false)
    // The run had ended by the time the wait gave up.
    expect(retry.shouldStop()).toBe(true)
    // One wait, started before the deadline. The run has ended when it gives
    // up, so the step is not sent again, its first 429 ends it, and no retry
    // is counted.
    expect(counters.rateLimitRetries).toBe(0)
    expect(fake.rejected).toEqual([1])
    expect(fake.accepted).toEqual([1, 1, 1, 1])
    // No new block came, so the cap was still spent and the deadline cut off
    // no retry: the 429 is an error, though it ends the step after the deadline.
    expect(isCutOffAtDeadline(error)).toBe(false)
    expect(countStepFailure(freshCounters(), error)).toBe("rateLimited")
  })

  it("a 429 whose retry the run deadline cut off is counted apart and is not an error", async () => {
    node = startFakeNode()
    const fake = node
    const demos = await demosWithSdkTransport(fake.url)
    const counters = freshCounters()
    for (let i = 0; i < IDENTITY_CONFIRMS_PER_BLOCK; i++) {
      counters.total++
      await addStep(demos, i)()
      counters.ok++
    }

    // A fifth step in the same block is refused. The next block shows up
    // only after the run has ended, so the step is not sent again and its 429
    // is rethrown to the worker after the deadline. The test drives both, not
    // the wall clock: the block wait's first read after the 429 moves the run
    // deadline into the past and still shows block 1; its next read, one poll
    // later on a fake clock, shows block 2.
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 3, settleTimeoutSec: 1, settlePollMs: 10, opTimeoutMs: 15000 } as LoadgenConfig
    let stopAtMs = Number.POSITIVE_INFINITY
    let readsAfter429 = 0
    const retry = workerRateLimitRetry({
      rpcUrl: fake.url,
      cfg,
      counters,
      sharedStop: { value: false },
      get stopAtMs() {
        return stopAtMs
      },
      readBlockNumber: rpcUrl => {
        if (fake.rejected.length > 0) {
          readsAfter429++
          if (readsAfter429 === 1) stopAtMs = Number.NEGATIVE_INFINITY
          if (readsAfter429 === 2) fake.nextBlock()
        }
        return fake.readBlock(rpcUrl)
      },
      clock: fakeWaitClock(),
    })
    counters.total++
    const error = await retryOnRateLimit(addStep(demos, 99), retry).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RateLimitError)
    // The deadline passed during the wait, and the wait then saw block 2.
    expect(retry.shouldStop()).toBe(true)
    expect(readsAfter429).toBe(2)
    expect(await fake.readBlock(fake.url)).toBe(2)
    expect(fake.rejected).toEqual([1])
    expect(counters.rateLimitRetries).toBe(0)
    expect(isCutOffAtDeadline(error)).toBe(true)
    // The mark keeps the error's code and limiter.
    expect(normalizeLoadgenError(error).context).toMatchObject({ httpStatus: 429, limiter: "identity_cap" })

    expect(countStepFailure(counters, error)).toBe("rateLimitedAtDeadline")
    expect(counters.rateLimitedAtDeadline).toBe(1)
    expect(counters.rateLimited).toBe(0)
    // The unfinished step stays in total but does not raise the error rate.
    expect(counters.total).toBe(5)
    expect(errorRateOf(counters)).toEqual({ errorCount: 0, errorRate: 0 })
  })

  /** A retry whose run has ended (shouldStop) and whose block wait always succeeds; counts the waits. */
  const retryAfterDeadline = (overrides: Partial<RateLimitRetry> = {}) => {
    const seen = { waits: 0 }
    const retry: RateLimitRetry = {
      stopOnRateLimit: false,
      maxRetries: 10,
      shouldStop: () => true,
      readHeight: noHeight,
      waitForNextBlock: async () => {
        seen.waits++
        return true
      },
      onRetry: () => {},
      ...overrides,
    }
    return { retry, seen }
  }

  it("a cap 429 after the run deadline with a retry still allowed is cut off by the deadline", async () => {
    const { retry, seen } = retryAfterDeadline()
    let attempts = 0
    const error = await retryOnRateLimit(async () => {
      attempts++
      throw http429()
    }, retry).catch((caught: unknown) => caught)
    expect(attempts).toBe(1)
    expect(seen.waits).toBe(0)
    expect(isCutOffAtDeadline(error)).toBe(true)
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    expect(countStepFailure(counters, error)).toBe("rateLimitedAtDeadline")
    expect(errorRateOf(counters)).toEqual({ errorCount: 0, errorRate: 0 })
  })

  it("with RATE_LIMIT_MAX_RETRIES=0, a cap 429 after the run deadline is an error", async () => {
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 0, settleTimeoutSec: 1, settlePollMs: 10 } as LoadgenConfig
    const retry = workerRateLimitRetry({
      rpcUrl: "http://unused:1",
      cfg,
      counters,
      sharedStop: { value: false },
      stopAtMs: Date.now() - 1,
      readBlockNumber: async () => {
        throw new Error("no retry is allowed, so no block is read")
      },
    })
    const error = await retryOnRateLimit(async () => {
      throw http429()
    }, retry).catch((caught: unknown) => caught)
    expect(isCutOffAtDeadline(error)).toBe(false)
    expect(countStepFailure(counters, error)).toBe("rateLimited")
    expect(counters.rateLimitedAtDeadline).toBe(0)
    expect(errorRateOf(counters)).toEqual({ errorCount: 1, errorRate: 0.5 })
  })

  it("with the retry budget used up, a cap 429 after the run deadline is an error", async () => {
    // The run ends while the last allowed retry is in flight; its 429 has no retry left.
    let attempts = 0
    let retries = 0
    const { retry, seen } = retryAfterDeadline({
      maxRetries: 1,
      shouldStop: () => attempts > 1,
      onRetry: () => {
        retries++
      },
    })
    const error = await retryOnRateLimit(async () => {
      attempts++
      throw http429()
    }, retry).catch((caught: unknown) => caught)
    expect(attempts).toBe(2)
    expect(seen.waits).toBe(1)
    expect(retries).toBe(1)
    expect(isCutOffAtDeadline(error)).toBe(false)
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    expect(countStepFailure(counters, error)).toBe("rateLimited")
    expect(errorRateOf(counters)).toEqual({ errorCount: 1, errorRate: 0.5 })
  })

  it("a 429 that ends a step before the run deadline is still an error", () => {
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    expect(countStepFailure(counters, http429())).toBe("rateLimited")
    expect(counters.rateLimited).toBe(1)
    expect(counters.rateLimitedAtDeadline).toBe(0)
    expect(errorRateOf(counters)).toEqual({ errorCount: 1, errorRate: 0.5 })
  })

  it("with stopOnRateLimit, a 429 at the run deadline is still an error", async () => {
    // No retries then, so the 429 refused the step, it did not just outlast the run.
    const { retry, seen } = retryAfterDeadline({ stopOnRateLimit: true })
    const error = await retryOnRateLimit(async () => {
      throw http429()
    }, retry).catch((caught: unknown) => caught)
    expect(seen.waits).toBe(0)
    expect(isCutOffAtDeadline(error)).toBe(false)
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    expect(countStepFailure(counters, error)).toBe("rateLimited")
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
      readHeight: noHeight,
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
      readHeight: () => fake.readBlock(fake.url),
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
    const { retry: afterDeadline } = retryAfterDeadline()
    const late = await retryOnRateLimit(() => addStep(demos, 1)(), afterDeadline).catch((caught: unknown) => caught)
    expect(normalizeLoadgenError(late).context).toMatchObject({ httpStatus: 429, limiter: "ip_block" })
    expect(isCutOffAtDeadline(late)).toBe(false)
    expect(countStepFailure(freshCounters(), late)).toBe("rateLimited")
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
      readHeight: () => fake.readBlock(fake.url),
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

  it("an 'IP blocked' error after the run deadline is still counted as rateLimited", async () => {
    const { retry } = retryAfterDeadline()
    const error = await retryOnRateLimit(async () => {
      throw ipBlocked()
    }, retry).catch((caught: unknown) => caught)
    expect(isCutOffAtDeadline(error)).toBe(false)
    const counters = freshCounters()
    counters.total = 2
    counters.ok = 1
    expect(countStepFailure(counters, error)).toBe("rateLimited")
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

  it.each([
    { label: "a start height", start: 100 },
    { label: "no start height", start: null },
  ])("waitForNextBlock ends by its timeout when the poll interval is longer, with $label", async ({ start }) => {
    const clock = fakeWaitClock()
    expect(await waitForNextBlock("http://unused:1", 30, 120, async () => 100, start, clock)).toBe(false)
    expect(clock.now()).toBeGreaterThan(0)
    expect(clock.now()).toBeLessThanOrEqual(30)
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(30)
  })

  it("waitForNextBlock ends by its timeout on the injected clock while a height read is still pending", async () => {
    const clock = fakeWaitClock()
    // The read shows a new block only after 1.5 s; the timeout is 1 s.
    const lateRead = () => clock.sleep(1500).then(() => 101)
    expect(await waitForNextBlock("http://unused:1", 1000, 120, lateRead, 100, clock)).toBe(false)
    expect(clock.now()).toBe(1000)
  })

  it("waitForNextBlock ends at its timeout while a height read is still pending", async () => {
    // The read shows a new block only after one second, like an RPC read that
    // its 8 s abort has not ended yet. The wait must end at its 30 ms timeout.
    const lateRead = () => new Promise<number>(resolve => setTimeout(() => resolve(101), 1000))
    expect(await waitForNextBlock("http://unused:1", 30, 120, lateRead, 100)).toBe(false)
  })

  /**
   * A worker's retry for a step refused once with the cap's 429. The height
   * reader gets the heights it returns from before (until the step is refused)
   * and after (from then on), and records each read.
   */
  function refusedOnce(params: { before: () => number | null; after: () => number | null; settlePollMs: number; settleTimeoutSec: number }) {
    let refused = false
    const reads: (number | null)[] = []
    const counters = freshCounters()
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 3, settleTimeoutSec: params.settleTimeoutSec, settlePollMs: params.settlePollMs, opTimeoutMs: 15000 } as LoadgenConfig
    const retry = workerRateLimitRetry({
      rpcUrl: "http://unused:1",
      cfg,
      counters,
      sharedStop: { value: false },
      stopAtMs: Date.now() + 600_000,
      readBlockNumber: async () => {
        const height = refused ? params.after() : params.before()
        reads.push(height)
        return height
      },
    })
    let attempts = 0
    const run = () =>
      retryOnRateLimit(async () => {
        attempts++
        if (attempts > 1) return "added"
        refused = true
        throw http429()
      }, retry)
    return { run, reads, counters, attempts: () => attempts }
  }

  it("retries at once when a block lands while the confirm is refused", async () => {
    // Height 100 before the attempt, 101 on every read after the 429. The poll
    // interval is far past the test's timeout, so a wait that sleeps before
    // its first read, or takes its baseline after the 429, fails the test.
    const { run, reads, counters, attempts } = refusedOnce({ before: () => 100, after: () => 101, settlePollMs: 600_000, settleTimeoutSec: 600 })
    expect(await run()).toBe("added")
    expect(attempts()).toBe(2)
    expect(counters.rateLimitRetries).toBe(1)
    // Before the first attempt, the wait's one read, before the second attempt.
    expect(reads).toEqual([100, 101, 101])
  })

  it("with a failed height read before the attempt, waits for a block past the first good read after the 429", async () => {
    const after = [null, 101, 101, 102]
    let next = 0
    const { run, reads, counters, attempts } = refusedOnce({
      before: () => null,
      after: () => (next < after.length ? after[next++] : 102),
      settlePollMs: 1,
      settleTimeoutSec: 5,
    })
    expect(await run()).toBe("added")
    expect(attempts()).toBe(2)
    expect(counters.rateLimitRetries).toBe(1)
    // The failed read before the attempt; the wait: a failed read, 101 as the
    // baseline, 101 again, then 102; the read before the second attempt.
    expect(reads).toEqual([null, null, 101, 101, 102, 102])
  })

  it.each([
    { label: "RATE_LIMIT_MAX_RETRIES=0", stopOnRateLimit: false, rateLimitMaxRetries: 0 },
    { label: "STOP_ON_RATE_LIMIT=true", stopOnRateLimit: true, rateLimitMaxRetries: 10 },
  ])("reads no height before the attempt with $label", async ({ stopOnRateLimit, rateLimitMaxRetries }) => {
    let reads = 0
    const cfg = { stopOnRateLimit, rateLimitMaxRetries, settleTimeoutSec: 1, settlePollMs: 10 } as LoadgenConfig
    const retry = workerRateLimitRetry({
      rpcUrl: "http://unused:1",
      cfg,
      counters: freshCounters(),
      sharedStop: { value: false },
      stopAtMs: Date.now() + 600_000,
      readBlockNumber: async () => {
        reads++
        return 1
      },
    })
    expect(await retryOnRateLimit(async () => "added", retry)).toBe("added")
    const error = await retryOnRateLimit(async () => {
      throw http429()
    }, retry).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RateLimitError)
    expect(reads).toBe(0)
  })

  it("sends the confirm once a height read before it does not answer within opTimeoutMs, and a later 429 still waits for a new block", async () => {
    const clock = fakeWaitClock()
    const counters = freshCounters()
    const cfg = { stopOnRateLimit: false, rateLimitMaxRetries: 3, settleTimeoutSec: 5, settlePollMs: 100, opTimeoutMs: 1000 } as LoadgenConfig
    // Before the 429 the height read never answers. After it, the reads give
    // 101, 101, then 102 from then on.
    let refused = false
    const after = [101, 101]
    const readsAfter: number[] = []
    const retry = workerRateLimitRetry({
      rpcUrl: "http://unused:1",
      cfg,
      counters,
      sharedStop: { value: false },
      stopAtMs: Date.now() + 600_000,
      clock,
      readBlockNumber: () => {
        if (!refused) return new Promise<number | null>(() => {})
        const height = after.shift() ?? 102
        readsAfter.push(height)
        return Promise.resolve(height)
      },
    })
    const sentAt: number[] = []
    const run = retryOnRateLimit(async () => {
      sentAt.push(clock.now())
      if (sentAt.length > 1) return "added"
      refused = true
      throw http429()
    }, retry)

    // Without the bound, the step is never sent and the run hangs.
    expect(await Promise.race([run, Bun.sleep(2000).then(() => "the confirm was never sent")])).toBe("added")
    // The first confirm went out when the hung read timed out, at 1 s.
    expect(sentAt[0]).toBe(1000)
    // Its 429 took the first good read after it (101) as the baseline and was
    // retried only once 102 showed up, two 100 ms polls later.
    expect(sentAt[1]).toBe(1200)
    expect(readsAfter).toEqual([101, 101, 102, 102])
    expect(counters.rateLimitRetries).toBe(1)
  })
})

describe("CI", () => {
  it("lists this file in test:consensus, so CI runs it", () => {
    const script = join(import.meta.dir, "../../../../../scripts/test-consensus.sh")
    const files = execFileSync("bash", [script, "--list"], { encoding: "utf8" }).trim().split("\n")
    expect(files).toContain("testing/loadgen/src/features/gcr/gcr_identity_loadgen.test.ts")
  })
})

describe("waitForIdentityPresence", () => {
  const removed = identity(9)
  const settle = (clock: WaitClock, readIdentities: () => Promise<Set<string>>, pollMs: number) => {
    let endedAtMs = -1
    const wait = waitForIdentityPresence({
      rpcUrl: "http://unused:1",
      ownerAddress: OWNER,
      algorithm: "falcon",
      identityAddress: removed,
      expectPresent: false,
      timeoutSec: 1,
      pollMs,
      readIdentities,
      clock,
    }).then(
      () => {
        endedAtMs = clock.now()
      },
      error => {
        endedAtMs = clock.now()
        throw error
      },
    )
    return { wait, endedAtMs: () => endedAtMs }
  }

  it("ends by its timeout with ConvergenceError while a read is still pending", async () => {
    const clock = fakeWaitClock()
    // The read would show the remove, but only after 1.5 s; the timeout is 1 s.
    const { wait, endedAtMs } = settle(clock, () => clock.sleep(1500).then(() => new Set<string>()), 200)
    await expect(wait).rejects.toBeInstanceOf(ConvergenceError)
    expect(endedAtMs()).toBe(1000)
  })

  it("sleeps at most the time left when the poll interval is far above the timeout", async () => {
    const clock = fakeWaitClock()
    const { wait, endedAtMs } = settle(clock, async () => new Set([removed]), 60_000)
    await expect(wait).rejects.toBeInstanceOf(ConvergenceError)
    expect(endedAtMs()).toBe(1000)
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(1000)
  })

  it("returns once a read in time shows the expected state", async () => {
    const clock = fakeWaitClock()
    let reads = 0
    const { wait, endedAtMs } = settle(clock, async () => (++reads === 1 ? new Set([removed]) : new Set<string>()), 200)
    await wait
    expect(endedAtMs()).toBe(200)
    expect(reads).toBe(2)
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

describe("runWithTimeseries", () => {
  const pointCounters = [
    "ok",
    "total",
    "confirmError",
    "broadcastError",
    "validationError",
    "networkError",
    "rateLimited",
    "rateLimitedAtDeadline",
  ] as const
  /** Each counter summed over the timeseries points. */
  const sumOverPoints = (points: TimeseriesPoint[]) =>
    Object.fromEntries(pointCounters.map(key => [key, points.reduce((sum, point) => sum + point[key], 0)]))
  /** The same counters as the summary reports them. */
  const summaryTotals = (counters: LoadgenCounters) => Object.fromEntries(pointCounters.map(key => [key, counters[key]]))

  /**
   * A run on a fake clock (no real waits): the timeseries loop's one-second
   * sleep moves the clock on. loopDone resolves once the loop has written its
   * point at the deadline, which is its last.
   */
  const timeseriesRun = (stopAtMs: number) => {
    const clock = { ms: 0 }
    const points: TimeseriesPoint[] = []
    let markLoopDone!: () => void
    const loopDone = new Promise<void>(resolve => {
      markLoopDone = resolve
    })
    const run = <T>(counters: LoadgenCounters, workers: Promise<T>, emitTimeseries = true) =>
      runWithTimeseries({
        counters,
        cfg: { emitTimeseries },
        stopAtMs,
        timeseriesSampler: new ReservoirSampler(10),
        workers,
        writePoint: point => {
          points.push(point)
          if (clock.ms >= stopAtMs) markLoopDone()
        },
        now: () => clock.ms,
        sleep: async ms => {
          clock.ms += ms
        },
      })
    return { clock, points, loopDone, run }
  }

  it("writes a final point carrying a 429 the deadline cut off after the loop's last point", async () => {
    const stopAtMs = 3000
    const { clock, points, loopDone, run } = timeseriesRun(stopAtMs)
    const counters = freshCounters()
    // One worker: a step that succeeds during the run, then one refused with
    // the cap's 429. Its block wait outlasts the loop: the next block shows up
    // only after the loop has written its last point, so the run has ended,
    // the step is not sent again, and the 429 counts in rateLimitedAtDeadline.
    const workers = (async () => {
      counters.total++
      counters.ok++
      counters.total++
      const error = await retryOnRateLimit(
        async () => {
          throw http429()
        },
        {
          stopOnRateLimit: false,
          maxRetries: 10,
          shouldStop: () => clock.ms >= stopAtMs,
          readHeight: noHeight,
          waitForNextBlock: async () => {
            await loopDone
            clock.ms += 500
            return true
          },
          onRetry: () => {
            counters.rateLimitRetries++
          },
        },
      ).catch((caught: unknown) => caught)
      return countStepFailure(counters, error)
    })()

    expect(await run(counters, workers)).toBe("rateLimitedAtDeadline")
    expect(counters).toMatchObject({ total: 2, ok: 1, rateLimited: 0, rateLimitedAtDeadline: 1, rateLimitRetries: 0 })
    // The loop's points (one a second up to the deadline) miss the 429; a
    // final point after the workers have settled carries it.
    expect(points.map(point => point.tSec)).toEqual([1, 2, 3, 3.5])
    expect(points.slice(0, 3).map(point => point.rateLimitedAtDeadline)).toEqual([0, 0, 0])
    expect(points[3]).toMatchObject({ ok: 0, total: 0, rateLimited: 0, rateLimitedAtDeadline: 1 })
    expect(sumOverPoints(points)).toEqual(summaryTotals(counters))
  })

  it("writes no final point when nothing was counted after the loop's last point", async () => {
    const { points, loopDone, run } = timeseriesRun(3000)
    const counters = freshCounters()
    const workers = (async () => {
      counters.total += 3
      counters.ok += 2
      counters.rateLimited++
      // The worker ends with the run, counting nothing more.
      await loopDone
    })()

    await run(counters, workers)
    expect(points.map(point => point.tSec)).toEqual([1, 2, 3])
    expect(sumOverPoints(points)).toEqual(summaryTotals(counters))
  })

  it("writes no points, not even a final one, when EMIT_TIMESERIES is off", async () => {
    const { points, run } = timeseriesRun(3000)
    const counters = freshCounters()
    const workers = (async () => {
      counters.total++
      counters.rateLimitedAtDeadline++
    })()

    await run(counters, workers, false)
    expect(points).toEqual([])
  })
})

describe("runVerdict", () => {
  const verdict = (counters: LoadgenCounters) =>
    runVerdict({ counters, maxErrorRate: 0.05, leakedIdentityCount: 0, sampleCodeCounts: {} })

  it("fails a run with no successful step, even when every step ended in a 429 at the deadline", () => {
    // A node that answers 429 for the whole run: no step succeeds, and every
    // step is cut off at the deadline. No step finished, so there is no error,
    // and with nothing to divide by the error rate is 1.
    const counters = { ...freshCounters(), total: 4, rateLimitedAtDeadline: 4 }
    expect(errorRateOf(counters)).toEqual({ errorCount: 0, errorRate: 1 })

    const result = verdict(counters)
    expect(result.ok).toBe(false)
    expect(result.primaryIssues).toContain("rate_limit")
  })

  it("passes a run with successful steps and a few 429s at the deadline", () => {
    const counters = { ...freshCounters(), total: 24, ok: 20, rateLimitedAtDeadline: 4 }
    expect(verdict(counters)).toEqual({ ok: true, primaryIssues: ["rate_limit"] })
  })

  it("leaves steps cut off at the deadline out of the error rate's denominator", () => {
    const strict = (counters: LoadgenCounters) =>
      runVerdict({ counters, maxErrorRate: 0.1, leakedIdentityCount: 0, sampleCodeCounts: {} })
    // 8 finished steps, 1 of them an error: 0.125, above 0.1.
    const finished = { ...freshCounters(), total: 8, ok: 7, confirmError: 1 }
    expect(errorRateOf(finished)).toEqual({ errorCount: 1, errorRate: 0.125 })
    expect(strict(finished).ok).toBe(false)

    // The same run with 4 more steps cut off at the deadline: they did not
    // finish, so they do not bring the rate under MAX_ERROR_RATE.
    const withCutOff = { ...finished, total: 12, rateLimitedAtDeadline: 4 }
    expect(errorRateOf(withCutOff)).toEqual({ errorCount: 1, errorRate: 0.125 })
    expect(strict(withCutOff)).toEqual({ ok: false, primaryIssues: ["rate_limit", "tx_pipeline"] })
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
