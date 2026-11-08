import { expect, test } from "bun:test"
import { block, fork, signerWindow, validatorLabel, Watcher } from "./index"

const reply = (response: unknown, result = 200) => Response.json({ result, response })
const stored = (number: number, hash = `hash-${number}`, signers = ["a", ...(number % 2 ? [] : ["b"])], previousHash = `hash-${number - 1}`) => ({
    number, hash, content: { timestamp: 1_800_000_000_000, previousHash },
    validation_data: { signatures: Object.fromEntries(signers.map(v => [v, "signature"])) },
})
function stub(options: { heads?: Record<string, number>; sets?: unknown; change?: (host: string, message: string, data: any) => Response | undefined } = {}) {
    const calls: { host: string; message: string; data: any }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
        const host = new URL(url).host
        const { message, data } = init?.method === "POST" ? JSON.parse(String(init.body)).params[0] : { message: "genesis", data: {} }
        calls.push({ host, message, data })
        const changed = options.change?.(host, message, data)
        if (changed) return changed
        if (message === "genesis") return Response.json({ properties: { shardSize: 10 } })
        if (message === "getLastBlockNumber") return reply(options.heads?.[host] ?? 30)
        if (message === "getBlockByNumber") return reply(stored(data.blockNumber))
        if (message === "getValidatorSet" && options.sets !== undefined) return reply(options.sets)
        return reply({ error: "Unknown message" }, 404)
    }
    return { calls, fetcher }
}
const line = (w: Watcher, name: string) => w.metrics().split("\n").find(s => s.startsWith(`demos_watch_${name} `))

test("block parser validates height, timestamp, hash and signatures; handles milliseconds and genesis", () => {
    expect(block(stored(10), 10).timestamp).toBe(1_800_000_000)
    expect(block({ number: 0, hash: "genesis" }, 0).signers).toEqual([])
    for (const value of [null, {}, stored(9), { ...stored(10), hash: "" }, { ...stored(10), content: { timestamp: "bad" } },
        { ...stored(10), validation_data: { signatures: { a: null } } }]) expect(() => block(value, 10)).toThrow()
})
test("fork comparison requires different hashes at equal heights", () => {
    expect(fork([block(stored(10), 10), block(stored(11), 11)])).toBe(0)
    expect(fork([block(stored(10), 10), block(stored(10, "other"), 10)])).toBe(1)
    expect(fork([])).toBe(0)
})
test("signer window uses union fallback, counts each height, includes silent RPC members", () => {
    const blocks = [block(stored(10), 10), block(stored(9), 9)]
    expect([...signerWindow(blocks)]).toEqual([["a", { count: 2, last: 10 }], ["b", { count: 1, last: 10 }]])
    expect(signerWindow(blocks, ["a", "c"]).get("c")).toEqual({ count: 0, last: 0 })
})
test("poll compares min head minus two despite propagation lag, with signer fallback", async () => {
    const { calls, fetcher } = stub({ heads: { "one.test": 30, "two.test": 29 } })
    const w = new Watcher(["https://one.test/path?secret=hidden", "https://two.test"], 3, fetcher)
    await w.poll(1000)
    expect(line(w, "fork_detected")).toEndWith(" 0")
    expect(calls.filter(c => c.message === "getBlockByNumber" && c.data.blockNumber === 27).map(c => c.host)).toEqual(["one.test", "two.test"])
    expect(w.metrics()).toContain('validator_set_source{source="signers"} 1')
    expect(w.metrics()).toContain('validator_signed_in_window{validator="a"} 3')
    expect(line(w, "signature_threshold")).toEndWith(" 7")
    expect(w.metrics()).not.toContain("secret")
    await w.poll(1200)
    expect(w.lastAdvance).toBe(1000)
    expect(calls.filter(c => c.message === "getFinalizedHead")).toHaveLength(2)
    expect(w.endpoints[0]!.errors).toBe(2) // Both unsupported capabilities counted once.
})
test("conflicting hashes at the comparison height flag a fork", async () => {
    const { fetcher } = stub({ change: (host, method, data) => host === "two.test" && method === "getBlockByNumber"
        ? reply(stored(data.blockNumber, "other-chain")) : undefined })
    const w = new Watcher(["https://one.test", "https://two.test"], 3, fetcher)
    await w.poll()
    expect(line(w, "fork_detected")).toEndWith(" 1")
})
test("RPC validator set filters inactive and future entries and exports silent validators", async () => {
    const { fetcher } = stub({ sets: { blockNumber: 28, validators: [
        { identity: "a", status: "2", validAt: 0 }, { identity: "silent", status: "2", validAt: 1 },
        { identity: "inactive", status: "0", validAt: 0 }, { identity: "future", status: "2", validAt: 100 },
    ] } })
    const w = new Watcher(["https://one.test"], 3, fetcher)
    await w.poll()
    expect(w.metrics()).toContain('validator_set_source{source="rpc"} 1')
    expect(w.metrics()).toContain('validator_signed_in_window{validator="silent"} 0')
    expect(line(w, "validator_set_size")).toEndWith(" 2")
})
test("malformed validator set counts an error and uses signers", async () => {
    const { fetcher } = stub({ sets: { blockNumber: 28, validators: [null] } })
    const w = new Watcher(["https://one.test"], 3, fetcher)
    await w.poll()
    expect(w.metrics()).toContain('validator_set_source{source="signers"} 1')
    expect(w.endpoints[0]!.errors).toBe(2)
})
for (const bad of ["json", "http", "envelope", "head", "block", "declared size", "body size"]) test(`bad ${bad} reply leaves other endpoint working`, async () => {
    const { fetcher } = stub({ change: (host, method) => {
        if (host !== "bad.test") return
        if (bad === "json") return new Response("{")
        if (bad === "http") return new Response("unavailable", { status: 503 })
        if (bad === "declared size" && method === "getLastBlockNumber") return new Response('{"result":200,"response":30}', { headers: { "content-length": String(4 * 1024 * 1024 + 1) } })
        if (bad === "body size" && method === "getLastBlockNumber") return Response.json({ result: 200, response: 30, pad: "x".repeat(4 * 1024 * 1024) })
        if (bad === "envelope") return Response.json(null)
        if (bad === "head" && method === "getLastBlockNumber") return reply("30")
        if (bad === "block" && method === "getBlockByNumber") return reply({ number: 30 })
    } })
    const w = new Watcher(["https://bad.test", "https://good.test"], 3, fetcher)
    await w.poll(1000)
    expect(w.endpoints[0]!.up).toBe(0)
    expect(w.endpoints[0]!.errors).toBeGreaterThan(0)
    expect(w.endpoints[1]!.up).toBe(1)
    expect(line(w, "head_max")).toEndWith(" 30")
})
test("an undeclared chunked body over 4 MiB is cancelled while streaming, not buffered whole", async () => {
    let sent = 0, cancelled = false
    const chunked = () => new Response(new ReadableStream({
        pull(c) { if (sent >= 32 << 20) return c.close(); sent += 1 << 20; c.enqueue(new Uint8Array(1 << 20)) },
        cancel() { cancelled = true },
    }))
    const { fetcher } = stub({ change: (host, method) => host === "bad.test" && method === "getLastBlockNumber" ? chunked() : undefined })
    const w = new Watcher(["https://bad.test", "https://good.test"], 3, fetcher)
    await w.poll(1000)
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThanOrEqual(6 << 20)
    expect(w.endpoints[0]!.up).toBe(0)
    expect(w.endpoints[1]!.up).toBe(1)
})
test("request abort deadline contains a hanging endpoint", async () => {
    const { fetcher } = stub()
    const w = new Watcher(["https://hang.test", "https://good.test"], 3, async (url, init) => {
        if (new URL(url).host !== "hang.test") return fetcher(url, init)
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(Error("timeout"))))
    }, 10)
    await w.poll()
    expect(w.endpoints[0]!.up).toBe(0)
    expect(w.endpoints[1]!.up).toBe(1)
})
test("a partial signer window is never exported as complete; another endpoint supplies it", async () => {
    const { fetcher } = stub({ change: (host, method, data) => host === "bad.test" && method === "getBlockByNumber" && data.blockNumber === 27
        ? reply(null) : undefined })
    const w = new Watcher(["https://bad.test", "https://good.test"], 3, fetcher)
    await w.poll()
    expect(w.endpoints[0]!.errors).toBeGreaterThan(1)
    expect(w.metrics()).toContain('validator_signed_in_window{validator="a"} 3')
})
test("all endpoints failing preserves advance time, drops old signer observations, and recovers", async () => {
    let down = false
    const { fetcher } = stub()
    const w = new Watcher(["https://one.test"], 3, (url, init) => down ? Promise.reject(Error("down")) : fetcher(url, init))
    await w.poll(1000)
    down = true
    await w.poll(1400)
    expect(w.lastAdvance).toBe(1000)
    expect(w.metrics()).not.toContain("demos_watch_block_signers")
    down = false
    await w.poll(1500)
    expect(w.endpoints[0]!.up).toBe(1)
    expect(w.lastAdvance).toBe(1000)
})
test("missing genesis quorum is omitted rather than inferred from validator pool", async () => {
    const { fetcher } = stub({ change: (_, method) => method === "genesis" ? Response.json({}) : undefined })
    const w = new Watcher(["https://one.test"], 3, fetcher)
    await w.poll()
    expect(w.metrics()).not.toContain("demos_watch_signature_threshold")
    expect(w.endpoints[0]!.errors).toBe(3)
})
test("long validator labels use full digests and hosts must be distinct", () => {
    expect(validatorLabel("a".repeat(1000))).not.toBe(validatorLabel("a".repeat(999) + "b"))
    expect(validatorLabel("short")).toBe("short")
    expect(() => new Watcher([])).toThrow()
    expect(() => new Watcher(["https://one.test/a", "https://one.test/b"])).toThrow()
})

test("startup failures start the stall timer once, and new heads advance it", async () => {
    let number = 30
    let down = true
    const { fetcher } = stub({ change: (_, method) => method === "getLastBlockNumber" ? reply(number) : undefined })
    const w = new Watcher(["https://one.test"], 3, (url, init) => down ? Promise.reject(Error("down")) : fetcher(url, init))
    await w.poll(1000)
    await w.poll(1400)
    expect(w.lastAdvance).toBe(1000)
    down = false
    await w.poll(1500)
    expect(w.lastAdvance).toBe(1500)
    number++
    await w.poll(1600)
    expect(w.lastAdvance).toBe(1600)
    expect(line(w, "head_max")).toEndWith(" 31")
})
test("scrapes retain the previous complete poll while the next poll is pending", async () => {
    const { fetcher } = stub()
    let release: (() => void) | undefined
    let pending: Promise<void> | undefined
    const w = new Watcher(["https://one.test"], 3, async (url, init) => {
        if (pending) await pending
        return fetcher(url, init)
    })
    await w.poll(1000)
    const before = w.metrics()
    pending = new Promise(resolve => { release = resolve })
    const poll = w.poll(1200)
    expect(w.metrics()).toBe(before)
    release!()
    await poll
})
test("one inflated head or a chain reset does not latch the stall timer", async () => {
    const heads: Record<string, number> = { "one.test": 9_000_000, "two.test": 100 }
    const w = new Watcher(["https://one.test", "https://two.test"], 3, stub({ heads }).fetcher)
    await w.poll(1000)
    heads["one.test"] = heads["two.test"] = 105
    await w.poll(1100)
    heads["two.test"] = 110
    await w.poll(1200)
    expect(w.lastAdvance).toBe(1200)
    const reset: Record<string, number> = { "one.test": 500 }
    const r = new Watcher(["https://one.test"], 3, stub({ heads: reset }).fetcher)
    await r.poll(1000)
    reset["one.test"] = 5
    await r.poll(1100)
    expect(r.lastAdvance).toBe(1000)
    reset["one.test"] = 35
    await r.poll(1200)
    expect(r.lastAdvance).toBe(1200)
})
test("oversized signature maps, validator lists and signer unions are rejected and counted", async () => {
    const many = (n: number, prefix = "v") => Array.from({ length: n }, (_, k) => `${prefix}${k}`)
    expect(block(stored(10, "h", many(1000)), 10).signers).toHaveLength(1000)
    expect(() => block(stored(10, "h", many(1001)), 10)).toThrow()
    const sets = { blockNumber: 28, validators: many(1001).map(identity => ({ identity, status: "2", validAt: 0 })) }
    const listed = new Watcher(["https://one.test"], 3, stub({ sets }).fetcher)
    await listed.poll()
    expect(listed.metrics()).toContain('validator_set_source{source="signers"} 1')
    expect(listed.endpoints[0]!.errors).toBe(2)
    const union = new Watcher(["https://one.test"], 3, stub({ change: (_, method, data) => method === "getBlockByNumber"
        ? reply(stored(data.blockNumber, undefined, many(1000, `${data.blockNumber}-`))) : undefined }).fetcher)
    await union.poll()
    expect(union.metrics()).not.toContain("validator_signed_in_window")
    expect(union.endpoints[0]!.errors).toBe(3)
})
test("window blocks are reused while their hash chain links; a replaced chain is refetched", async () => {
    let head = 30
    let chain = "hash"
    const { calls, fetcher } = stub({ change: (_, method, data) => {
        if (method === "getLastBlockNumber") return reply(head)
        if (method === "getBlockByNumber") return reply(stored(data.blockNumber, `${chain}-${data.blockNumber}`, undefined, `${chain}-${data.blockNumber - 1}`))
    } })
    const reads = () => calls.splice(0).filter(c => c.message === "getBlockByNumber").map(c => c.data.blockNumber)
    const w = new Watcher(["https://one.test"], 3, fetcher)
    await w.poll(1000)
    expect(reads()).toEqual([30, 28, 27, 26])
    head = 31
    await w.poll(1100)
    expect(reads()).toEqual([31, 29])
    expect(w.metrics()).toContain('validator_signed_in_window{validator="a"} 3')
    chain = "new"
    await w.poll(1200)
    expect(reads()).toEqual([31, 29])
    expect(w.metrics()).not.toContain("validator_signed_in_window")
    expect(w.endpoints[0]!.errors).toBe(3)
    await w.poll(1300)
    expect(reads()).toEqual([31, 29, 28, 27])
    expect(w.metrics()).toContain('validator_signed_in_window{validator="a"} 3')
})
test("an unsupported RPC is retried after ten minutes", async () => {
    let supported = false
    const { calls, fetcher } = stub({ change: (_, method) => method !== "getValidatorSet" ? undefined : supported
        ? reply({ blockNumber: 28, validators: [{ identity: "a", status: "2", validAt: 0 }] }) : reply({ error: "Unknown message" }, 404) })
    const w = new Watcher(["https://one.test"], 3, fetcher)
    const asked = () => calls.filter(c => c.message === "getValidatorSet").length
    await w.poll(1000)
    supported = true
    await w.poll(1599)
    expect(asked()).toBe(1)
    expect(w.metrics()).toContain('validator_set_source{source="signers"} 1')
    await w.poll(1600)
    expect(asked()).toBe(2)
    expect(w.metrics()).toContain('validator_set_source{source="rpc"} 1')
})
test("genesis is read under the configured URL path, keeping its query", async () => {
    const urls: string[] = []
    const { fetcher } = stub()
    const w = new Watcher(["https://one.test/rpc?key=k"], 3, (url, init) => { if (!init?.method) urls.push(url); return fetcher(url, init) })
    await w.poll()
    expect(urls).toEqual(["https://one.test/rpc/genesis?key=k"])
    expect(line(w, "signature_threshold")).toEndWith(" 7")
})
