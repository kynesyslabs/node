/**
 * A sudo call names the node it is for, and every other node refuses it.
 * The smoke test posts awardPoints to its first target, so the headers must
 * name that node, not whichever node SUDO_RPC_URL points at.
 */

import { afterAll, describe, expect, it, mock } from "bun:test"

const KEYS: Record<string, string> = {
  "http://node-1:53551": "11".repeat(32),
  "http://node-2:53551": "22".repeat(32),
}

mock.module("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class {
    async connect() {}
    async connectWallet() {}
    crypto = {
      getIdentity: async () => ({ publicKey: new Uint8Array(32).fill(5) }),
      sign: async () => ({ signature: new Uint8Array(64) }),
    }
  },
}))

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any) => {
  const url = new URL(String(input))
  const node = `${url.protocol}//${url.host}`
  const body = url.pathname === "/publickey" ? JSON.stringify(KEYS[node]) : JSON.stringify({ hash: "ab".repeat(32) })
  return new Response(body, { status: 200 })
}) as typeof fetch
process.env.SUDO_MNEMONIC = "test mnemonic"
process.env.SUDO_RPC_URL = "http://node-1:53551"

const { buildSudoHeaders } = await import("./gcr_points_smoke")

afterAll(() => {
  globalThis.fetch = realFetch
  delete process.env.SUDO_MNEMONIC
  delete process.env.SUDO_RPC_URL
})

describe("gcr_points_smoke sudo headers", () => {
  it("name the node the request is posted to", async () => {
    const headers = await buildSudoHeaders("{}", "http://node-2:53551")
    expect(headers?.audience).toBe(KEYS["http://node-2:53551"])
  })
})
