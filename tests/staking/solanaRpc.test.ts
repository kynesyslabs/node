import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
const identity = { solanaRpc: "https://a.example,https://b.example", heliusApiKey: "" }
jest.mock("src/config", () => ({
    __esModule: true,
    Config: { getInstance: () => ({ identity }) },
}))

import type { Connection } from "@solana/web3.js"
import {
    SOLANA_MAX_CONCURRENT_READS,
    SOLANA_MAX_QUEUED_READS,
    SOLANA_RPC_TIMEOUT_MS,
    SOLANA_SHARED_RESULT_MS,
    SolanaAbsentError,
    SolanaNotFoundError,
    SolanaUnreachableError,
    resetSolanaConnectionsForTesting,
    resolveSolanaEndpoints,
    sharedSolanaRead,
    solanaReadLoadForTesting,
    withSolana,
} from "@/features/staking/solanaRpc"

const never = () => new Promise<never>(() => {})

describe("withSolana", () => {
    beforeEach(() => {
        jest.useFakeTimers()
        resetSolanaConnectionsForTesting()
    })

    it("takes the first endpoint that answers while another hangs", async () => {
        const read = (c: Connection) => (c.rpcEndpoint.startsWith("https://a.") ? never() : Promise.resolve("b"))
        await expect(withSolana("read", read)).resolves.toBe("b")
    })

    it("ignores an endpoint that fails while another answers", async () => {
        const read = (c: Connection) =>
            c.rpcEndpoint.startsWith("https://a.") ? Promise.reject(new Error("not found")) : Promise.resolve("b")
        await expect(withSolana("read", read)).resolves.toBe("b")
    })

    it("is unreachable after one timeout when every endpoint hangs, naming each", async () => {
        const pending = withSolana("read", never)
        const settled = pending.then(
            () => "answered",
            e => e,
        )
        jest.advanceTimersByTime(SOLANA_RPC_TIMEOUT_MS)
        const e = await settled
        expect(e).toBeInstanceOf(SolanaUnreachableError)
        expect(String((e as Error).message)).toContain("a.example")
        expect(String((e as Error).message)).toContain("b.example")
    })
})

describe("the Solana read limit", () => {
    beforeEach(() => {
        jest.useFakeTimers()
        resetSolanaConnectionsForTesting()
    })

    it("runs a bounded number of reads at once, queues a bounded number, and refuses the rest at once", async () => {
        const gates: Array<() => void> = []
        let started = 0
        const held = () => {
            started++
            return new Promise<string>(resolve => gates.push(() => resolve("ok")))
        }
        // Each read asks every endpoint, so a read that runs starts one call per endpoint.
        const perRead = resolveSolanaEndpoints().length
        const running = Array.from({ length: SOLANA_MAX_CONCURRENT_READS }, () => withSolana("read", held))
        const queued = Array.from({ length: SOLANA_MAX_QUEUED_READS }, () => withSolana("read", held))
        // Reads still hanging when the test ends time out under a later test's clock.
        for (const p of [...running, ...queued]) p.catch(() => {})
        await Promise.resolve()
        expect(solanaReadLoadForTesting()).toEqual({ running: SOLANA_MAX_CONCURRENT_READS, queued: SOLANA_MAX_QUEUED_READS })
        expect(started).toBe(SOLANA_MAX_CONCURRENT_READS * perRead)

        const over = await withSolana("read", held).then(() => "answered", e => e)
        expect(over).toBeInstanceOf(SolanaUnreachableError)
        expect(String((over as Error).message)).toContain("read limit reached")
        expect(started).toBe(SOLANA_MAX_CONCURRENT_READS * perRead)

        // A finished read hands its slot to the next queued one.
        gates.slice(0, perRead).forEach(open => open())
        await running[0]
        for (let i = 0; i < 5; i++) await Promise.resolve()
        expect(started).toBe(SOLANA_MAX_CONCURRENT_READS * perRead + perRead)
        gates.forEach(open => open())
    })

    it("gives up on a queued read that gets no slot within the read timeout", async () => {
        const never2 = () => new Promise<never>(() => {})
        // Every slot hangs, and as many queued reads will take them when they time out.
        for (let i = 0; i < 2 * SOLANA_MAX_CONCURRENT_READS; i++) void withSolana("hang", never2).catch(() => {})
        const waiting = withSolana("late", () => Promise.resolve("x")).then(() => "answered", e => e)
        expect(solanaReadLoadForTesting()).toEqual({ running: SOLANA_MAX_CONCURRENT_READS, queued: SOLANA_MAX_CONCURRENT_READS + 1 })
        jest.advanceTimersByTime(SOLANA_RPC_TIMEOUT_MS)
        const e = await waiting
        expect(e).toBeInstanceOf(SolanaUnreachableError)
        expect(String((e as Error).message)).toContain("no Solana read slot")
    })
})

describe("withSolana not-found", () => {
    beforeEach(() => resetSolanaConnectionsForTesting())

    it("is SolanaNotFoundError only when every endpoint answered without the record", async () => {
        const absent = await withSolana("read", () => Promise.reject(new SolanaAbsentError("not found"))).then(
            () => "answered",
            e => e,
        )
        expect(absent).toBeInstanceOf(SolanaNotFoundError)
        expect(absent).toBeInstanceOf(SolanaUnreachableError)

        const mixed = await withSolana("read", (c: Connection) =>
            Promise.reject(c.rpcEndpoint.startsWith("https://a.") ? new SolanaAbsentError("not found") : new Error("429")),
        ).then(() => "answered", e => e)
        expect(mixed).toBeInstanceOf(SolanaUnreachableError)
        expect(mixed).not.toBeInstanceOf(SolanaNotFoundError)
    })
})

describe("sharedSolanaRead", () => {
    beforeEach(() => resetSolanaConnectionsForTesting())

    it("runs one read for every caller of the same key while it is in flight", async () => {
        let release: (v: string) => void = () => {}
        const read = jest.fn(() => new Promise<string>(resolve => (release = resolve)))
        const a = sharedSolanaRead("k", read)
        const b = sharedSolanaRead("k", read)
        release("v")
        expect(await Promise.all([a, b])).toEqual(["v", "v"])
        expect(read).toHaveBeenCalledTimes(1)
    })

    it("shares an answer and a not-found for about one round, then reads again", async () => {
        const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000)
        const answer = jest.fn(async () => "v")
        await sharedSolanaRead("answer", answer)
        await sharedSolanaRead("answer", answer)
        const missing = jest.fn(async () => {
            throw new SolanaNotFoundError("not found")
        })
        await expect(sharedSolanaRead("missing", missing)).rejects.toBeInstanceOf(SolanaNotFoundError)
        await expect(sharedSolanaRead("missing", missing)).rejects.toBeInstanceOf(SolanaNotFoundError)
        expect(answer).toHaveBeenCalledTimes(1)
        expect(missing).toHaveBeenCalledTimes(1)

        now.mockReturnValue(1_000_000 + SOLANA_SHARED_RESULT_MS)
        await sharedSolanaRead("answer", answer)
        await expect(sharedSolanaRead("missing", missing)).rejects.toBeInstanceOf(SolanaNotFoundError)
        expect(answer).toHaveBeenCalledTimes(2)
        expect(missing).toHaveBeenCalledTimes(2)
        now.mockRestore()
    })

    it("does not share a transport failure past the read", async () => {
        const read = jest.fn(async () => {
            throw new SolanaUnreachableError("timed out")
        })
        await expect(sharedSolanaRead("down", read)).rejects.toBeInstanceOf(SolanaUnreachableError)
        await expect(sharedSolanaRead("down", read)).rejects.toBeInstanceOf(SolanaUnreachableError)
        expect(read).toHaveBeenCalledTimes(2)
    })
})
