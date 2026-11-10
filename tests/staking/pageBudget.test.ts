import { describe, expect, it } from "@jest/globals"

import {
    HourlyBudget,
    checkRelayRequest,
    injectPageConfig,
} from "@/features/staking/pageBudget"

describe("checkRelayRequest", () => {
    it("accepts one call to a listed method", () => {
        expect(checkRelayRequest({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] })).toEqual({
            ok: true,
            method: "getLatestBlockhash",
        })
    })

    it("refuses batches, other methods and malformed bodies", () => {
        const refused = (body: unknown) => {
            const r = checkRelayRequest(body)
            expect(r.ok).toBe(false)
            return r.ok ? "" : r.reason
        }
        expect(refused([{ jsonrpc: "2.0", method: "getBlockHeight" }])).toMatch(/batch/)
        expect(refused({ jsonrpc: "2.0", method: "sendTransaction" })).toMatch(/not relayed/)
        expect(refused({ jsonrpc: "2.0", method: "getProgramAccounts" })).toMatch(/not relayed/)
        expect(refused({ jsonrpc: "1.0", method: "getBlockHeight" })).toMatch(/jsonrpc/)
        expect(refused({ jsonrpc: "2.0" })).toMatch(/method/)
        expect(refused("getBlockHeight")).toMatch(/object/)
        expect(refused(null)).toMatch(/object/)
    })
})

describe("HourlyBudget", () => {
    it("spends units and refuses once the hour's budget is gone, with the time left", () => {
        let now = 1_000_000
        const budget = new HourlyBudget(2, () => now)
        expect(budget.take()).toEqual({ ok: true, remaining: 1 })
        expect(budget.take()).toEqual({ ok: true, remaining: 0 })
        now += 600_000
        expect(budget.take()).toEqual({ ok: false, retryAfterSeconds: 3000 })
    })

    it("resets when the window has passed", () => {
        let now = 0
        const budget = new HourlyBudget(1, () => now)
        expect(budget.take().ok).toBe(true)
        expect(budget.take().ok).toBe(false)
        now = 3_600_000
        expect(budget.take()).toEqual({ ok: true, remaining: 0 })
    })

    it("refuses everything with a zero budget", () => {
        const budget = new HourlyBudget(0, () => 5)
        const r = budget.take()
        expect(r.ok).toBe(false)
    })
})

describe("injectPageConfig", () => {
    const config = { demosAddress: "0x" + "ab".repeat(32), rpcUrl: "http://n/staking/validation/rpc", submitUrl: "http://n/staking/validation/submit" }

    it("adds the JSON block before </head>", () => {
        const html = injectPageConfig("<html><head><title>t</title></head><body></body></html>", config)
        const match = html.match(/<script id="node-config" type="application\/json">(.*?)<\/script>\n<\/head>/)
        expect(match).not.toBeNull()
        expect(JSON.parse(match![1])).toEqual(config)
    })

    it("escapes a closing tag inside the values", () => {
        const html = injectPageConfig("<head></head>", { ...config, demosAddress: "</script><b>" })
        expect(html).not.toContain("</script><b>")
        expect(html).toContain("\\u003c/script>")
    })
})
