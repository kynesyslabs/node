/**
 * nodeCall does not reject on an HTTP error status or a failed fetch: it resolves
 * with the reply body, or with the result 599 reply that rpcPost builds. getNodeSnapshot
 * must log those replies as well, once per node and read, and keep the values the
 * reads return (#708). A reply's response has no size limit, so only its result code
 * and a bounded preview of its response are logged; the reply is never serialized.
 *
 * Runs the real nodeCall and the real reads; only fetch and console.error are mocked.
 *
 * Run this file in its own `bun test` process.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { getNodeSnapshot } from "./shared"

const JSON_HEADERS = { "content-type": "application/json" }
const READS = ["getPeerlist", "getLastBlockNumber", "getLastBlockHash"]

type RpcReply = (message: string) => Promise<Response>

describe("peersync getNodeSnapshot with failed RPC replies", () => {
  let errors: string[]
  let rpcMessages: string[]
  let rpcReply: RpcReply
  let errorSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  const snapshotLines = (rpcUrl: string) =>
    errors.filter(line => line.includes("peersync.getNodeSnapshot.") && line.includes(rpcUrl))

  beforeEach(() => {
    errors = []
    rpcMessages = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return new Response(JSON.stringify({ identity: "0xnode" }), { status: 200, headers: JSON_HEADERS })
      }
      const message = JSON.parse(String(init.body)).params[0].message
      rpcMessages.push(message)
      return rpcReply(message)
    }) as any)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    fetchSpy.mockRestore()
  })

  it("logs each read that gets an HTTP 503 JSON reply once per node and keeps the fallbacks", async () => {
    rpcReply = async () =>
      new Response(JSON.stringify({ error: "Service busy", message: "Too many requests" }), {
        status: 503,
        headers: JSON_HEADERS,
      })
    const rpcUrl = "http://node-a.invalid:53550"

    const snapshot = await getNodeSnapshot(rpcUrl)

    expect(rpcMessages.sort()).toEqual([...READS].sort())
    expect(snapshot.identity).toBe("0xnode")
    expect(snapshot.peerCount).toBe(0)
    expect(snapshot.peerIdentities).toEqual([])
    expect(snapshot.blockNumber).toBeNull()
    expect(snapshot.blockHash).toBeNull()
    expect(snapshot.ok).toBe(false)

    expect(snapshotLines(rpcUrl)).toHaveLength(3)
    for (const call of READS) {
      const lines = snapshotLines(rpcUrl).filter(line =>
        line.includes(`Non-critical error in peersync.getNodeSnapshot.${call}: reply without result 200:`))
      expect(lines).toHaveLength(1)
      // The 503 body has neither result nor response; only those two bounded fields are logged.
      expect(lines[0]).toContain("reply without result 200: {\"result\":\"undefined\",\"response\":\"undefined\"}")
      expect(lines[0]).toContain(`{"rpcUrl":"${rpcUrl}"}`)
    }

    await getNodeSnapshot(rpcUrl)
    expect(snapshotLines(rpcUrl)).toHaveLength(3)
  })

  it("logs the result 599 reply that rpcPost returns for a failed fetch", async () => {
    rpcReply = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.2:53550")
    }
    const rpcUrl = "http://node-b.invalid:53550"

    const snapshot = await getNodeSnapshot(rpcUrl)

    expect(snapshot.peerCount).toBe(0)
    expect(snapshot.blockNumber).toBeNull()
    expect(snapshotLines(rpcUrl)).toHaveLength(3)
    for (const call of READS) {
      const lines = snapshotLines(rpcUrl).filter(line => line.includes(`peersync.getNodeSnapshot.${call}: `))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("\"result\":599")
      expect(lines[0]).toContain("rpcPost failed: connect ECONNREFUSED 10.0.0.2:53550")
    }
  })

  it("logs the result code and a bounded preview of a large response without serializing the reply", async () => {
    const preview = "a".repeat(200)
    const response = `${preview}${"z".repeat(4_000_000)}`
    let toJsonCalls = 0
    const reply = {
      result: 500,
      response,
      toJSON() {
        toJsonCalls++
        return { result: 500, response }
      },
    }
    rpcReply = async () => ({ ok: false, status: 500, json: async () => reply }) as unknown as Response
    const rpcUrl = "http://node-d.invalid:53550"

    const snapshot = await getNodeSnapshot(rpcUrl)

    expect(snapshot.peerCount).toBe(0)
    expect(snapshot.blockHash).toBe(response)
    expect(toJsonCalls).toBe(0)
    expect(snapshotLines(rpcUrl)).toHaveLength(3)
    for (const call of READS) {
      const lines = snapshotLines(rpcUrl).filter(line => line.includes(`peersync.getNodeSnapshot.${call}: `))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(
        `reply without result 200: {"result":500,"responseLength":4000200,"response":"${preview}"}`)
      expect(lines[0].length).toBeLessThan(1_000)
    }
  })

  it("keeps the result code and the response length when the logger cuts the preview", async () => {
    // Each ESC in the 200-character preview is written as the 6-character JSON escape
    // \u001b, so the message passes the logger's 1,000-character cut. The cut may only
    // shorten the preview: the result code and the length come before it.
    const response = `${"\u001b".repeat(200)}TAIL`
    const reply = { result: 500, response }
    rpcReply = async () => ({ ok: false, status: 500, json: async () => reply }) as unknown as Response
    const rpcUrl = "http://node-e.invalid:53550"

    const snapshot = await getNodeSnapshot(rpcUrl)

    expect(snapshot.blockHash).toBe(response)
    expect(snapshotLines(rpcUrl)).toHaveLength(3)
    for (const call of READS) {
      const lines = snapshotLines(rpcUrl).filter(line => line.includes(`peersync.getNodeSnapshot.${call}: `))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("reply without result 200: {\"result\":500,\"responseLength\":204,\"response\":\"\\u001b")
      expect(lines[0]).toContain("\"responseLength\":204")
      // The message was cut: its marker is in the line and the end of the preview is not.
      expect(lines[0]).toMatch(/…\(\d+ chars\) \{"rpcUrl":/)
      expect(lines[0]).not.toContain(String.raw`\u001b"}`)
      expect(lines[0]).not.toContain("\u001b")
    }
  })

  it("logs only the type of a reply that is not an object", async () => {
    const replies: Array<[string, unknown]> = [["null", null], ["string", "z".repeat(4_000_000)]]
    for (const [type, reply] of replies) {
      rpcReply = async () => ({ ok: false, status: 500, json: async () => reply }) as unknown as Response
      const rpcUrl = `http://node-${type}.invalid:53550`

      await getNodeSnapshot(rpcUrl)

      const lines = snapshotLines(rpcUrl)
      expect(lines).toHaveLength(3)
      for (const line of lines) {
        expect(line).toContain(`reply without result 200: ${type} {"rpcUrl":"${rpcUrl}"}`)
      }
    }
  })

  it("does not log replies with result 200", async () => {
    const responses: Record<string, unknown> = {
      getPeerlist: [{ identity: "0xpeer" }, { identity: "0xnode" }],
      getLastBlockNumber: 42,
      getLastBlockHash: "0xblockhash",
    }
    rpcReply = async message =>
      new Response(JSON.stringify({ result: 200, response: responses[message] }), { status: 200, headers: JSON_HEADERS })
    const rpcUrl = "http://node-c.invalid:53550"

    const snapshot = await getNodeSnapshot(rpcUrl)

    expect(snapshot.ok).toBe(true)
    expect(snapshot.peerIdentities).toEqual(["0xnode", "0xpeer"])
    expect(snapshot.blockNumber).toBe(42)
    expect(snapshot.blockHash).toBe("0xblockhash")
    expect(snapshotLines(rpcUrl)).toHaveLength(0)
  })
})
