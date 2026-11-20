/**
 * A reply whose body is not JSON used to be read as `null` with no trace of the
 * parse error (#708). The shared `rpcPost`, the zk `fetchJson` reads and the
 * peersync identity read now log the parse error once per target (and method for
 * `rpcPost`, route for zk) and still return the same `null` result.
 *
 * Run this file in its own `bun test` process: the log keys are once per process.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { getNodeIdentity } from "../features/peersync/shared"
import { getMerkleRoot, getNullifierStatus } from "../features/zk/shared"
import { loggedNonCriticalKeyCount } from "./common"
import { rpcPost } from "./rpc"

async function notJsonParseError(): Promise<string> {
  const message = await new Response("not json").json().then(
    () => "",
    (error: unknown) => (error as Error).message,
  )
  expect(message).not.toBe("")
  return message
}

describe("malformed JSON replies", () => {
  let errors: string[]
  let fetchUrls: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  const linesFor = (context: string) => errors.filter(line => line.includes(`Non-critical error in ${context}:`))

  beforeEach(() => {
    errors = []
    fetchUrls = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      fetchUrls.push(String(input))
      return new Response("not json", { status: 200, headers: { "content-type": "application/json" } })
    }) as any)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    fetchSpy.mockRestore()
  })

  it("rpc.rpcPost returns json null and logs once per target and method, with the parse error", async () => {
    const parseError = await notJsonParseError()
    const target = "http://node-a.invalid:53550"
    const body = { method: "nodeCall", params: [{ message: "getLastBlockNumber", data: {}, muid: "test" }] }
    const keysBefore = loggedNonCriticalKeyCount()

    for (let round = 0; round < 3; round++) {
      expect(await rpcPost(target, body)).toEqual({ ok: true, status: 200, json: null })
    }
    expect(fetchUrls).toEqual([`${target}/`, `${target}/`, `${target}/`])

    const lines = linesFor("rpc.rpcPost")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`Non-critical error in rpc.rpcPost: ${parseError}`)
    expect(lines[0]).toContain(`"rpcUrl":"${target}/"`)
    expect(lines[0]).toContain("\"method\":\"nodeCall\"")
    expect(lines[0]).toContain("\"status\":200")
    // The body text is not logged, only the parse error.
    expect(lines[0]).not.toContain("getLastBlockNumber")
    expect(loggedNonCriticalKeyCount()).toBe(keysBefore + 1)

    // Another method on the same target has its own key; a body without a string
    // method is keyed by the target alone.
    for (let round = 0; round < 2; round++) {
      expect(await rpcPost(target, { method: "ping" })).toEqual({ ok: true, status: 200, json: null })
      expect(await rpcPost(target, { params: [] })).toEqual({ ok: true, status: 200, json: null })
    }
    const all = linesFor("rpc.rpcPost")
    expect(all).toHaveLength(3)
    expect(all[1]).toContain("\"method\":\"ping\"")
    expect(all[2]).toContain("\"method\":null")
    expect(loggedNonCriticalKeyCount()).toBe(keysBefore + 3)
  })

  it("zk.fetchJson returns json null and logs once per target and route, not per request", async () => {
    const parseError = await notJsonParseError()
    const target = "http://node-b.invalid:53550"
    const keysBefore = loggedNonCriticalKeyCount()

    for (let round = 0; round < 3; round++) {
      expect(await getMerkleRoot(target)).toEqual({ status: 200, ok: true, json: null })
    }
    let lines = linesFor("zk.fetchJson")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`Non-critical error in zk.fetchJson: ${parseError}`)
    expect(lines[0]).toContain(`"rpcUrl":"${target}/zk/merkle-root"`)
    expect(lines[0]).toContain("\"status\":200")
    expect(loggedNonCriticalKeyCount()).toBe(keysBefore + 1)

    // Each request names a different nullifier; the route is still logged once.
    const hashes = ["0x01", "0x02", "0x03"]
    for (const hash of hashes) {
      expect(await getNullifierStatus(target, hash)).toEqual({ status: 200, ok: true, json: null })
    }
    expect(fetchUrls.slice(-3)).toEqual(hashes.map(hash => `${target}/zk/nullifier/${hash}`))
    lines = linesFor("zk.fetchJson")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(`"rpcUrl":"${target}/zk/nullifier/0x01"`)
    expect(loggedNonCriticalKeyCount()).toBe(keysBefore + 2)
  })

  it("peersync.getNodeIdentity returns null and logs once per target, with the parse error", async () => {
    const parseError = await notJsonParseError()
    const target = "http://node-c.invalid:53550"
    const keysBefore = loggedNonCriticalKeyCount()

    for (let round = 0; round < 3; round++) {
      expect(await getNodeIdentity(target)).toBeNull()
    }
    expect(fetchUrls).toEqual([`${target}/info`, `${target}/info`, `${target}/info`])

    const lines = linesFor("peersync.getNodeIdentity")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`Non-critical error in peersync.getNodeIdentity: ${parseError}`)
    expect(lines[0]).toContain(`"rpcUrl":"${target}"`)
    expect(lines[0]).toContain("\"status\":200")
    expect(loggedNonCriticalKeyCount()).toBe(keysBefore + 1)
  })
})
