/**
 * When connection.close() rejects in the omni scenarios or the l2ps helper, the
 * log line must name the target, so two targets that fail with the same generic
 * error can be told apart (#708).
 *
 * Run this file in its own `bun test` process. Bun's mock.module lasts for the
 * whole process: the PeerConnection mock below would reach later files, and after
 * another loadgen test file has mocked @kynesyslabs/demosdk/websdk (e.g.
 * gcr_points_smoke.test.ts) loading the scenarios below fails with
 * "Export named '_required' not found".
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("../../../../../src/libs/omniprotocol/transport/PeerConnection", () => ({
  PeerConnection: class {
    async connect() {}
    async send(): Promise<Buffer> {
      throw new Error("request timed out")
    }
    async close() {
      throw new Error("socket hang up")
    }
    getState() {
      return 0
    }
  },
}))

const { probeTarget: probeConnection } = await import("./omni_connection_smoke")
const { probeTarget: probeRoundtrip } = await import("./omni_message_roundtrip")
const { probeTarget: probeReconnection } = await import("./omni_reconnection")
const { worker } = await import("./omni_throughput")
const { probeOmniParticipation } = await import("../l2ps/shared")

const targets = ["tcp://node-a.invalid:53561", "tcp://node-b.invalid:53563"]

function runWorker(target: string) {
  return worker({
    workerId: 1,
    target,
    stopAtMs: 0,
    connectTimeoutMs: 10,
    requestTimeoutMs: 10,
    minPeers: 1,
    minLoopDelayMs: 0,
    counters: { startedAtMs: 0, endedAtMs: 0, total: 0, ok: 0, error: 0 },
    sampler: { add: () => {} } as any,
    sharedStop: { value: false },
    errorSamples: [],
    errorSampleLimit: 0,
  })
}

const cases: Array<[string, (target: string) => Promise<unknown>]> = [
  ["omni_connection_smoke.close", target => probeConnection(target, 10, 10)],
  ["omni_message_roundtrip.close", target => probeRoundtrip(target, 10, 10)],
  ["omni_reconnection.close", target => probeReconnection(target, 10, 10, 1)],
  ["omni_throughput.close", runWorker],
  ["l2ps.probeOmniParticipation.close", target => probeOmniParticipation(target, "uid")],
]

describe("omni close error logs", () => {
  let errors: string[]
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  for (const [context, probe] of cases) {
    it(`${context} names the target when close() rejects`, async () => {
      for (const target of targets) await probe(target)

      const lines = errors.filter(line => line.includes(`Non-critical error in ${context}: socket hang up`))
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain(targets[0])
      expect(lines[1]).toContain(targets[1])
    })
  }
})
