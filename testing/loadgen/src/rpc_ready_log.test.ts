/**
 * rpc_loadgen and transfer_loadgen wait for every target in parallel. When two
 * targets fail in different ways, each target's first failure must be logged,
 * not only the first failure in the process (#708).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
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
