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
  resolveWorkerCount,
  retryOnRateLimit,
  submitPqcTx,
  waitForNextBlock,
  type RateLimitRetry,
} from "./gcr_identity_loadgen"

describe("resolveWorkerCount", () => {
  it("defaults to 4 workers per target", () => {
    expect(IDENTITY_CONFIRMS_PER_BLOCK).toBe(4)
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 4 })).toEqual({ workers: 4, cap: 4, warning: null })
    expect(resolveWorkerCount({ requested: "", targetCount: 2, walletCount: 8 })).toEqual({ workers: 8, cap: 8, warning: null })
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 10 }).workers).toBe(4)
  })

  it("does not default to more workers than wallets", () => {
    expect(resolveWorkerCount({ requested: undefined, targetCount: 3, walletCount: 4 }).workers).toBe(4)
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 2 }).workers).toBe(2)
    expect(resolveWorkerCount({ requested: undefined, targetCount: 1, walletCount: 0 }).workers).toBe(1)
  })

  it("lets an explicit CONCURRENCY win, with a warning above the cap", () => {
    const over = resolveWorkerCount({ requested: "6", targetCount: 1, walletCount: 4 })
    expect(over.workers).toBe(6)
    expect(over.cap).toBe(4)
    expect(over.warning).toContain("CONCURRENCY=6 is above 4")

    expect(resolveWorkerCount({ requested: "8", targetCount: 2, walletCount: 4 })).toEqual({ workers: 8, cap: 8, warning: null })
    expect(resolveWorkerCount({ requested: "1", targetCount: 1, walletCount: 4 })).toEqual({ workers: 1, cap: 4, warning: null })
    expect(resolveWorkerCount({ requested: "0", targetCount: 1, walletCount: 4 }).workers).toBe(1)
  })

  it("ignores a CONCURRENCY that is not a number", () => {
    expect(resolveWorkerCount({ requested: "many", targetCount: 1, walletCount: 4 })).toEqual({ workers: 4, cap: 4, warning: null })
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

  it("waitForNextBlock returns once the block moves, and false when it does not", async () => {
    node = startFakeNode()
    const fake = node
    expect(await waitForNextBlock(fake.url, 100, 10)).toBe(false)
    setTimeout(() => fake.nextBlock(), 30)
    expect(await waitForNextBlock(fake.url, 2000, 10)).toBe(true)
  })
})
