/**
 * rpc_loadgen and transfer_loadgen wait for every target in parallel. When two
 * targets fail in different ways, each target's first failure must be logged,
 * not only the first failure in the process (#708). A 200 reply whose body is
 * not JSON is logged the same way, instead of being read as `null`.
 *
 * Run this file in its own `bun test` process.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { loggedNonCriticalKeyCount } from "./framework/common"
import { isRpcReady as rpcLoadgenIsRpcReady } from "./rpc_loadgen"
import { isRpcReady as transferLoadgenIsRpcReady } from "./transfer_loadgen"

const failures: Record<string, string> = {
  "http://node-a.invalid:53550": "connect ECONNREFUSED 127.0.0.1:53550",
  "http://node-b.invalid:53550": "read ECONNRESET",
}
const targets = Object.keys(failures)

const probes: Array<[string, (target: string) => Promise<boolean>]> = [
  ["rpc_loadgen.isRpcReady", target => rpcLoadgenIsRpcReady(target, "/")],
  ["transfer_loadgen.isRpcReady", target => transferLoadgenIsRpcReady(target)],
]

describe("readiness probe logs", () => {
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      const target = targets.find(t => String(input).startsWith(`${t}/`))
      throw new Error(target ? failures[target] : `unexpected url ${String(input)}`)
    }) as any)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    fetchSpy.mockRestore()
  })

  for (const [context, probe] of probes) {
    it(`${context} logs each target's own error once`, async () => {
      const lines = () => errors.filter(line => line.includes(`Non-critical error in ${context}:`))

      for (let round = 0; round < 3; round++) {
        const ready = await Promise.all(targets.map(target => probe(target)))
        expect(ready).toEqual([false, false])
      }

      expect(lines()).toHaveLength(2)
      for (const target of targets) {
        const own = lines().filter(line => line.includes(target))
        expect(own).toHaveLength(1)
        expect(own[0]).toContain(failures[target])
        for (const other of targets.filter(t => t !== target)) {
          expect(own[0]).not.toContain(failures[other])
        }
      }
    })
  }
})

describe("readiness probe logs a malformed ping reply", () => {
  // Not one of the targets above, so its per-target log keys are still unused.
  const target = "http://node-c.invalid:53550"
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } })) as any)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    fetchSpy.mockRestore()
  })

  for (const [context, probe] of probes) {
    it(`${context} logs a 200 reply that is not JSON once, with the parse error`, async () => {
      const parseError = await new Response("not json").json().then(
        () => "",
        (error: unknown) => (error as Error).message,
      )
      expect(parseError).not.toBe("")
      const keysBefore = loggedNonCriticalKeyCount()

      for (let round = 0; round < 3; round++) {
        expect(await probe(target)).toBe(false)
      }

      const lines = errors.filter(line => line.includes(`Non-critical error in ${context}:`))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(`Non-critical error in ${context}: ${parseError}`)
      expect(lines[0]).toContain(target)
      // One new key: the per-target key, used once for all three rounds.
      expect(loggedNonCriticalKeyCount()).toBe(keysBefore + 1)
    })
  }
})
