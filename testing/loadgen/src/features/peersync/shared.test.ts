/**
 * getNodeSnapshot falls back to null / [] when a read rejects. The fallbacks
 * must stay the same, and the rejection must show up in the log once per node
 * and call (#708).
 *
 * Run this file in its own `bun test` process.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("../../framework/rpc", () => ({
  NO_FALLBACKS: {},
  nodeCall: async (_rpcUrl: string, message: string) => {
    throw new Error(`${message} rejected`)
  },
}))

mock.module("../consensus/shared", () => ({
  getConsensusTargets: () => [],
  waitForConsensusTargets: async () => {},
  getLastBlockNumber: async () => {
    throw new Error("getLastBlockNumber rejected")
  },
}))

const { getNodeSnapshot } = await import("./shared")

describe("peersync getNodeSnapshot", () => {
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("ECONNREFUSED")
    }) as any)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    fetchSpy.mockRestore()
  })

  it("keeps the fallbacks and logs each rejected read once per node", async () => {
    const rpcUrl = "http://node-a.invalid:53550"
    const snapshot = await getNodeSnapshot(rpcUrl)

    expect(snapshot.ok).toBe(false)
    expect(snapshot.identity).toBeNull()
    expect(snapshot.peerCount).toBe(0)
    expect(snapshot.blockNumber).toBeNull()
    expect(snapshot.blockHash).toBeNull()

    const snapshotLines = () => errors.filter(line => line.includes("peersync.getNodeSnapshot."))
    expect(snapshotLines()).toHaveLength(3)
    for (const call of ["getPeerlist", "getLastBlockNumber", "getLastBlockHash"]) {
      const line = snapshotLines().find(l => l.includes(`peersync.getNodeSnapshot.${call}:`))
      expect(line).toContain(`${call} rejected`)
      expect(line).toContain(rpcUrl)
    }

    await getNodeSnapshot(rpcUrl)
    expect(snapshotLines()).toHaveLength(3)

    await getNodeSnapshot("http://node-b.invalid:53550")
    expect(snapshotLines()).toHaveLength(6)
  })

  it("leaves the identity read to its own log, once per failure", async () => {
    const rpcUrl = "http://node-c.invalid:53550"
    const identityLines = () => errors.filter(line => line.includes("peersync.getNodeIdentity") && line.includes(rpcUrl))

    expect((await getNodeSnapshot(rpcUrl)).identity).toBeNull()
    expect(identityLines()).toHaveLength(1)
    expect(identityLines()[0]).toContain("Non-critical error in peersync.getNodeIdentity: ECONNREFUSED")

    await getNodeSnapshot(rpcUrl)
    expect(identityLines()).toHaveLength(2)
    expect(errors.some(line => line.includes("peersync.getNodeSnapshot.getNodeIdentity"))).toBe(false)
  })
})
