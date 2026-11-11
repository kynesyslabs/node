import { expect, it } from "bun:test"
import { registerClient } from "./im_shared"

for (const reply of ["silent", "error", "close", "register timeout"] as const) {
  it(`closes the socket when registration gets a ${reply} response`, async () => {
    let didClose!: () => void
    const closed = new Promise<void>(resolve => { didClose = resolve })
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return
        return new Response("WebSocket required", { status: 426 })
      },
      websocket: {
        message(ws, message) {
          if (JSON.parse(String(message)).type !== "register_challenge") return
          if (reply === "error") ws.send(JSON.stringify({ type: "error", payload: { details: "INVALID_MESSAGE" } }))
          if (reply === "close") ws.close()
          if (reply === "register timeout") ws.send(JSON.stringify({ type: "register_challenge", payload: { challenge: "test-challenge" } }))
        },
        close() { didClose() },
      },
    })

    try {
      let failure: unknown
      try {
        await registerClient({
          wsUrl: `ws://127.0.0.1:${server.port}`,
          clientId: "loadgen-client",
          instanceId: `im-register-${reply.replace(" ", "-")}-test`,
          timeoutSec: 1,
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      const expected = reply === "error" ? "INVALID_MESSAGE"
        : reply === "close" ? "WebSocket closed"
          : reply === "register timeout" ? "Register timeout" : "challenge timeout"
      expect(String(failure)).toContain(expected)
      expect(await Promise.race([closed.then(() => true), Bun.sleep(1500).then(() => false)])).toBe(true)
    } finally {
      server.stop(true)
    }
  }, 5000)
}
