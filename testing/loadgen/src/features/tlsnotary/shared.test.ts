/**
 * fetchTlsNotaryJson falls back to json: null for a body that is not JSON and
 * logs the parse error once per target and route. Bun's JSON.parse error quotes the offending body
 * character, so control characters the node sends must reach the log escaped,
 * on one line (#708).
 *
 * Run this file in its own `bun test` process.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { fetchTlsNotaryJson } from "./shared"

describe("tlsnotary fetchTlsNotaryJson", () => {
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
  })

  afterEach(() => {
    errorSpy.mockRestore()
    fetchSpy.mockRestore()
  })

  it("keeps the null fallback and logs a non-JSON body as one escaped line", async () => {
    const body = "\u001b[2J\n[loadgen] Non-critical error in tlsnotary.requestJson: ok"
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(body, { status: 200 })) as any)

    const res = await fetchTlsNotaryJson("http://node-a.invalid:53551", "/tlsnotary/health", { method: "GET" })

    expect(res.json).toBeNull()
    expect(res.text).toBe(body)
    expect(errors).toHaveLength(1)
    expect(errors[0].split(/\r|\n/)).toHaveLength(1)
    expect(errors[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]/u)
    expect(errors[0]).toContain("Non-critical error in tlsnotary.requestJson: JSON Parse error: Unrecognized token '\\u001b'")
    expect(errors[0]).toContain(`"rpcUrl":"http://node-a.invalid:53551","route":"/tlsnotary/health","status":200`)
  })

  it("logs the first non-JSON body of each target and route once", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("busy", { status: 503 })) as any)
    const targets = ["http://node-b.invalid:53553/", "http://node-c.invalid:53555/"]
    const routes = ["/tlsnotary/health", "/tlsnotary/info", "/tlsnotary/verify"]

    for (let round = 0; round < 2; round++) {
      for (const rpcUrl of targets) {
        for (const route of routes) {
          expect((await fetchTlsNotaryJson(rpcUrl, route, { method: "GET" })).json).toBeNull()
        }
      }
    }

    // One line per target and route, from the first round; the second round logs nothing.
    expect(errors).toHaveLength(6)
    for (const rpcUrl of targets) {
      for (const route of routes) {
        const tag = `"rpcUrl":"${rpcUrl}","route":"${route}","status":503`
        expect(errors.filter(line => line.includes(tag))).toHaveLength(1)
      }
    }
  })
})
