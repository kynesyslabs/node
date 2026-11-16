/**
 * The ServerHandlers facade must not carry a web2 forwarder. A web2 payload
 * reaches the proxy through the web2ProxyRequest RPC case (rpcDispatch.ts) and
 * the web2Request tx case (endpointExecution.ts), which pass the fetch caller
 * and apply the gates. A facade method that went straight to
 * handleWeb2ProxyRequest had no caller and passed none.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(import.meta.dir, "endpointHandlers.ts"), "utf8")

describe("ServerHandlers web2 surface", () => {
    it("does not define handleWeb2Request", () => {
        expect(source).not.toMatch(/handleWeb2Request\s*\(/)
    })

    it("does not import the web2 proxy handler or the raw payload parser", () => {
        expect(source).not.toMatch(/handleWeb2ProxyRequest/)
        expect(source).not.toMatch(/parseWeb2ProxyRequest/)
    })
})
