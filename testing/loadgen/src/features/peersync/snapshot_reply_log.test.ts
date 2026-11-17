/**
 * nodeCall does not reject on an HTTP error status or a failed fetch: it resolves
 * with the reply body, or with the result 599 reply that rpcPost builds. getNodeSnapshot
 * must log those replies as well, once per node and read, and keep the values the
 * reads return (#708).
 *
 * Runs the real nodeCall and the real reads; only fetch and console.error are mocked.
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
      expect(lines[0]).toContain(`{"error":"Service busy","message":"Too many requests"}`)
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
      expect(lines[0]).toContain(`"result":599`)
      expect(lines[0]).toContain("rpcPost failed: connect ECONNREFUSED 10.0.0.2:53550")
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
