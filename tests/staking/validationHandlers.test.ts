import { beforeEach, describe, expect, it, jest } from "@jest/globals"
import { Keypair } from "@solana/web3.js"
import bs58 from "bs58"

import { HourlyBudget } from "@/features/staking/pageBudget"
import { associatedTokenAddress, buildProofTransaction } from "@/features/staking/proofBytes"
import {
    AnchorUnreachableError,
    STAKING_RELAY_PATH,
    STAKING_SUBMIT_PATH,
    createValidationHandlers,
    type ValidationDeps,
} from "@/features/staking/validationHandlers"

const OWN = "0x" + "ab".repeat(32)
const OTHER = "0x" + "cd".repeat(32)
const owner = Keypair.generate()
const mint = Keypair.generate().publicKey
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 9))

function signedProof(demosAddress = OWN): Uint8Array {
    const tx = buildProofTransaction({
        owner: owner.publicKey,
        mint,
        tokenAccount: associatedTokenAddress(owner.publicKey, mint),
        demosAddress,
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 10,
    })
    tx.sign(owner)
    return tx.serialize()
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
    const text = typeof body === "string" ? body : JSON.stringify(body)
    return new Request(`http://node${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)), ...headers },
        body: text,
    })
}

const body = async (res: Response) => JSON.parse(await res.text()) as Record<string, unknown>

type Deps = ValidationDeps & {
    nodeHoldsSeat: jest.Mock<() => Promise<boolean>>
    mintHolder: jest.Mock<(mint: string) => Promise<string | null>>
    recordProof: jest.Mock<ValidationDeps["recordProof"]>
    fetch: jest.Mock<typeof fetch>
}

function deps(over: Partial<ValidationDeps> = {}): Deps {
    return {
        pageHtml: () => "<html><head><title>t</title></head><body>page</body></html>",
        ownAddress: () => OWN,
        solanaRpcUrl: () => "https://helius.example/?api-key=secret",
        budget: new HourlyBudget(3, () => 0),
        nodeHoldsSeat: jest.fn(async () => false),
        mintHolder: jest.fn(async () => null),
        isAllowlistedMint: () => true,
        recordProof: jest.fn(async () => ({ accepted: true, demosTxHash: "0xdemos", message: "ok" })),
        fetch: jest.fn(async () => new Response("{\"jsonrpc\":\"2.0\",\"result\":42,\"id\":1}", { status: 200 })),
        ...over,
    } as Deps
}

describe("staking page", () => {
    beforeEach(() => jest.clearAllMocks())

    it("serves the page with the node address and relay paths injected", async () => {
        const h = createValidationHandlers(deps())
        const res = await h.page(new Request("http://node/staking"))
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toMatch(/text\/html/)
        const html = await res.text()
        const cfg = JSON.parse(html.match(/<script id="node-config" type="application\/json">(.*?)<\/script>/)![1])
        expect(cfg).toEqual({ demosAddress: OWN, rpcUrl: STAKING_RELAY_PATH, submitUrl: STAKING_SUBMIT_PATH })
        expect(html).toContain("page")
    })

    it("is a 404 on every route once the node holds a seat", async () => {
        const h = createValidationHandlers(deps({ nodeHoldsSeat: jest.fn(async () => true) }))
        expect((await h.page(new Request("http://node/staking"))).status).toBe(404)
        expect((await h.relay(post(STAKING_RELAY_PATH, { jsonrpc: "2.0", id: 1, method: "getBlockHeight" }))).status).toBe(404)
        expect((await h.submit(post(STAKING_SUBMIT_PATH, { transaction: "AA==" }))).status).toBe(404)
    })

    it("answers 503 when the anchor cannot be asked", async () => {
        const h = createValidationHandlers(
            deps({ nodeHoldsSeat: jest.fn(async () => { throw new AnchorUnreachableError("timeout") }) }),
        )
        const res = await h.page(new Request("http://node/staking"))
        expect(res.status).toBe(503)
        expect((await body(res)).error).toMatch(/anchor node unreachable: timeout/)
    })
})

describe("Solana relay", () => {
    beforeEach(() => jest.clearAllMocks())

    it("forwards an allowed call to the keyed endpoint and returns its answer", async () => {
        const d = deps()
        const h = createValidationHandlers(d)
        const call = { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "finalized" }] }
        const res = await h.relay(post(STAKING_RELAY_PATH, call))
        expect(res.status).toBe(200)
        expect(await body(res)).toEqual({ jsonrpc: "2.0", result: 42, id: 1 })
        const [url, init] = d.fetch.mock.calls[0] as [string, RequestInit]
        expect(url).toBe("https://helius.example/?api-key=secret")
        expect(init.method).toBe("POST")
        expect(JSON.parse(init.body as string)).toEqual(call)
    })

    it("refuses other methods, batches and bad JSON without touching the endpoint", async () => {
        const d = deps()
        const h = createValidationHandlers(d)
        for (const payload of [
            { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] },
            [{ jsonrpc: "2.0", id: 1, method: "getBlockHeight" }],
            "not json",
        ]) {
            const res = await h.relay(post(STAKING_RELAY_PATH, payload))
            expect(res.status).toBe(400)
        }
        expect(d.fetch).not.toHaveBeenCalled()
    })

    it("refuses an oversized body", async () => {
        const d = deps()
        const h = createValidationHandlers(d)
        const res = await h.relay(post(STAKING_RELAY_PATH, { jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: ["x".repeat(5000)] }))
        expect(res.status).toBe(413)
        expect(d.fetch).not.toHaveBeenCalled()
    })

    it("spends the shared hourly budget and answers 429 with Retry-After when it is gone", async () => {
        const d = deps({ budget: new HourlyBudget(2, () => 0) })
        const h = createValidationHandlers(d)
        const call = { jsonrpc: "2.0", id: 1, method: "getBlockHeight" }
        expect((await h.relay(post(STAKING_RELAY_PATH, call))).status).toBe(200)
        expect((await h.relay(post(STAKING_RELAY_PATH, call))).status).toBe(200)
        const res = await h.relay(post(STAKING_RELAY_PATH, call))
        expect(res.status).toBe(429)
        expect(res.headers.get("retry-after")).toBe("3600")
        expect(d.fetch).toHaveBeenCalledTimes(2)
    })

    it("retries a stalled upstream call once, charging the budget once", async () => {
        const abort = new DOMException("The operation was aborted.", "AbortError")
        const d = deps({
            fetch: jest.fn()
                .mockRejectedValueOnce(abort)
                .mockResolvedValueOnce(new Response("{\"jsonrpc\":\"2.0\",\"result\":7,\"id\":1}", { status: 200 })) as never,
        })
        const call = { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" }
        const res = await createValidationHandlers(d).relay(post(STAKING_RELAY_PATH, call))
        expect(res.status).toBe(200)
        expect(d.fetch).toHaveBeenCalledTimes(2)
        expect(d.budget.take()).toMatchObject({ ok: true, remaining: 1 })
    })

    it("answers 502 when the endpoint fails and 503 when none is configured", async () => {
        const failing = deps({ fetch: jest.fn(async () => { throw new Error("ECONNRESET") }) as never })
        const call = { jsonrpc: "2.0", id: 1, method: "getBlockHeight" }
        let res = await createValidationHandlers(failing).relay(post(STAKING_RELAY_PATH, call))
        expect(res.status).toBe(502)
        expect((await body(res)).error).toMatch(/after 2 attempts: ECONNRESET/)
        expect(failing.fetch).toHaveBeenCalledTimes(2)
        res = await createValidationHandlers(deps({ solanaRpcUrl: () => null })).relay(post(STAKING_RELAY_PATH, call))
        expect(res.status).toBe(503)
    })
})

describe("proof submission", () => {
    beforeEach(() => jest.clearAllMocks())

    const submit = (h: ReturnType<typeof createValidationHandlers>, bytes: Uint8Array) =>
        h.submit(post(STAKING_SUBMIT_PATH, { transaction: Buffer.from(bytes).toString("base64") }))

    it("records a valid proof for this node and returns both hashes", async () => {
        const d = deps()
        const h = createValidationHandlers(d)
        const bytes = signedProof()
        const res = await submit(h, bytes)
        expect(res.status).toBe(200)
        const out = await body(res)
        expect(out.demosTxHash).toBe("0xdemos")
        expect(out.owner).toBe(owner.publicKey.toBase58())
        expect(out.mint).toBe(mint.toBase58())
        expect(typeof out.solanaSignature).toBe("string")
        expect(d.mintHolder).toHaveBeenCalledWith(mint.toBase58())
        expect(Buffer.from(d.recordProof.mock.calls[0][0] as Uint8Array)).toEqual(Buffer.from(bytes))
    })

    it("refuses a proof for another node's address", async () => {
        const d = deps()
        const res = await submit(createValidationHandlers(d), signedProof(OTHER))
        expect(res.status).toBe(400)
        expect((await body(res)).error).toMatch(new RegExp(`names ${OTHER}, not this node's address ${OWN}`))
        expect(d.recordProof).not.toHaveBeenCalled()
    })

    it("refuses tampered bytes, non-base64 and bodies without a transaction", async () => {
        const d = deps()
        const h = createValidationHandlers(d)
        const bytes = Uint8Array.from(signedProof())
        bytes[bytes.length - 1] ^= 1
        expect((await submit(h, bytes)).status).toBe(400)
        expect((await h.submit(post(STAKING_SUBMIT_PATH, { transaction: "not base64!" }))).status).toBe(400)
        expect((await h.submit(post(STAKING_SUBMIT_PATH, {}))).status).toBe(400)
        expect((await h.submit(post(STAKING_SUBMIT_PATH, "{"))).status).toBe(400)
        expect(d.mintHolder).not.toHaveBeenCalled()
        expect(d.recordProof).not.toHaveBeenCalled()
    })

    it("refuses a mint off the allowlist before asking the anchor", async () => {
        const d = deps({ isAllowlistedMint: () => false })
        const res = await submit(createValidationHandlers(d), signedProof())
        expect(res.status).toBe(400)
        expect((await body(res)).error).toMatch(/not an eligible node NFT/)
        expect(d.mintHolder).not.toHaveBeenCalled()
    })

    it("records a proof for a mint backing another seat and names the seat it evicts", async () => {
        const d = deps({ mintHolder: jest.fn(async () => OTHER) })
        const res = await submit(createValidationHandlers(d), signedProof())
        expect(res.status).toBe(200)
        expect((await body(res)).evicts).toBe(OTHER)
        expect(d.recordProof).toHaveBeenCalledTimes(1)
    })

    it("answers 503 when the anchor cannot answer the mint lookup", async () => {
        const d = deps({ mintHolder: jest.fn(async () => { throw new AnchorUnreachableError("down") }) })
        const res = await submit(createValidationHandlers(d), signedProof())
        expect(res.status).toBe(503)
    })

    it("passes a refused Demos transaction back as 502 with the reason", async () => {
        const d = deps({
            recordProof: jest.fn(async () => ({ accepted: false, demosTxHash: "0xdead", message: "Solana send failed: blockhash not found" })),
        })
        const res = await submit(createValidationHandlers(d), signedProof())
        expect(res.status).toBe(502)
        expect(await body(res)).toEqual({ error: "Solana send failed: blockhash not found", demosTxHash: "0xdead" })
    })

    it("counts a submission against the hourly budget", async () => {
        const d = deps({ budget: new HourlyBudget(1, () => 0) })
        const h = createValidationHandlers(d)
        expect((await submit(h, signedProof())).status).toBe(200)
        expect((await submit(h, signedProof())).status).toBe(429)
        expect(d.recordProof).toHaveBeenCalledTimes(1)
    })
})
