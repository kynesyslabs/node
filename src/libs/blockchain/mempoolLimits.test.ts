import { afterEach, describe, expect, it, mock } from "bun:test"

mock.module("src/features/metrics/MetricsService", () => ({
    getMetricsService: () => ({
        createCounter: () => undefined,
        incrementCounter: () => undefined,
    }),
}))

const limitsModule = await import("./mempoolLimits")
const {
    __resetMempoolLimits,
    __setMempoolLimits,
    capMergeReply,
    checkTxAge,
    chooseVictims,
    getMempoolLimits,
    splitMergeBatches,
    txStoredBytes,
    txTotalFee,
    txWireBytes,
} = limitsModule
const { MessageFramer } = await import(
    "@/libs/omniprotocol/transport/MessageFramer"
)

afterEach(() => __resetMempoolLimits())

describe("mempool limits", () => {
    it("defaults to the shared constants", () => {
        expect(getMempoolLimits()).toEqual({
            maxTxs: 10_000,
            maxBytes: 8 * 1024 * 1024,
            maxPerSender: 64,
            ttlMs: 10 * 60 * 1000,
            maxFutureSkewMs: 5 * 60 * 1000,
            mergeMaxBytes: 12 * 1024 * 1024,
        })
    })
})

describe("txStoredBytes", () => {
    it("counts the stored columns the way the pool total does", () => {
        const tx = {
            hash: "0xabcd",
            content: { a: 1 },
            signature: { type: "ed25519", data: "ff" },
            ed25519_signature: "sig",
            extra: { k: "v" },
        } as never
        const expected =
            Buffer.byteLength(JSON.stringify({ a: 1 })) +
            Buffer.byteLength(JSON.stringify({ type: "ed25519", data: "ff" })) +
            Buffer.byteLength(JSON.stringify({ k: "v" })) +
            3 +
            6
        expect(txStoredBytes(tx)).toBe(expected)
    })

    it("counts multi-byte characters as bytes, not characters", () => {
        const plain = txStoredBytes({ hash: "h", content: { s: "ab" }, signature: {} } as never)
        const wide = txStoredBytes({ hash: "h", content: { s: "é€" }, signature: {} } as never)
        expect(wide - plain).toBe(3)
    })
})

describe("txTotalFee", () => {
    it("reports OS: a DEM number is scaled, an OS string or bigint is taken as is", () => {
        expect(txTotalFee({ network_fee: 1, rpc_fee: 1, additional_fee: 0 })).toBe(2_000_000_000n)
        expect(
            txTotalFee({ network_fee: "1000000000", rpc_fee: 1000000000n, additional_fee: 0 }),
        ).toBe(2_000_000_000n)
        expect(txTotalFee({ network_fee: 1 })).toBe(txTotalFee({ network_fee: "1000000000" }))
    })

    it("reads missing or malformed fields as zero", () => {
        expect(txTotalFee(undefined)).toBe(0n)
        expect(txTotalFee({ network_fee: "abc", rpc_fee: -4, additional_fee: null })).toBe(0n)
    })
})

describe("checkTxAge", () => {
    const now = 10_000_000
    const at = (ts: unknown) => ({ content: { timestamp: ts } }) as never

    it("accepts a tx inside its lifetime", () => {
        expect(checkTxAge(at(now - 5 * 60 * 1000), now)).toBeNull()
        expect(checkTxAge(at(now + 60 * 1000), now)).toBeNull()
    })

    it("expires a tx signed more than the lifetime ago", () => {
        expect(checkTxAge(at(now - 10 * 60 * 1000 - 1), now)).toBe("expired")
    })

    it("refuses a timestamp too far ahead, which would never expire", () => {
        expect(checkTxAge(at(now + 5 * 60 * 1000 + 1), now)).toBe("future_dated")
    })

    it("rejects a missing, non-numeric, fractional, negative or zero timestamp", () => {
        for (const bad of [undefined, null, "soon", "1700000000000", 1.5, now + 0.5, -now, 0, NaN, Infinity, 1e16]) {
            expect(checkTxAge(at(bad), now)).toBe("bad_timestamp")
        }
        expect(checkTxAge({} as never, now)).toBe("bad_timestamp")
    })

    it("follows overridden limits", () => {
        __setMempoolLimits({ ttlMs: 1000 })
        expect(checkTxAge(at(now - 1001), now)).toBe("expired")
    })
})

describe("chooseVictims", () => {
    const cand = (hash: string, fee: number, timestamp: number, bytes = 100) => ({
        hash,
        fee: BigInt(fee),
        timestamp,
        bytes,
    })
    const limits = {
        maxTxs: 4,
        maxBytes: 1_000_000,
        maxPerSender: 64,
        ttlMs: 1,
        maxFutureSkewMs: 1,
        mergeMaxBytes: 1_000_000,
    }

    it("evicts the lowest fee first, and the oldest among equals", () => {
        const pool = [
            cand("high", 9, 1),
            cand("low-new", 1, 50),
            cand("low-old", 1, 10),
            cand("mid", 5, 2),
        ]
        const victims = chooseVictims(pool, { fee: 10n, bytes: 100 }, { count: 4, bytes: 400 }, limits)
        expect(victims?.map(v => v.hash)).toEqual(["low-old"])
    })

    it("evicts more than one when the byte cap needs the room", () => {
        const pool = [cand("a", 1, 1, 400), cand("b", 2, 2, 400), cand("c", 9, 3, 100)]
        const victims = chooseVictims(
            pool,
            { fee: 5n, bytes: 700 },
            { count: 3, bytes: 900 },
            { ...limits, maxBytes: 1000 },
        )
        expect(victims?.map(v => v.hash)).toEqual(["a", "b"])
    })

    it("turns away a tx that does not pay more than the cheapest held tx", () => {
        const pool = [cand("a", 3, 1), cand("b", 3, 2), cand("c", 3, 3), cand("d", 3, 4)]
        expect(
            chooseVictims(pool, { fee: 3n, bytes: 100 }, { count: 4, bytes: 400 }, limits),
        ).toBeNull()
    })

    it("evicts nothing when even every cheaper tx would not free enough room", () => {
        const pool = [cand("cheap", 1, 1, 50), cand("dear", 9, 2, 900)]
        expect(
            chooseVictims(
                pool,
                { fee: 5n, bytes: 900 },
                { count: 2, bytes: 950 },
                { ...limits, maxBytes: 1000 },
            ),
        ).toBeNull()
    })

    it("needs no victims while there is room", () => {
        expect(
            chooseVictims([cand("a", 1, 1)], { fee: 1n, bytes: 100 }, { count: 1, bytes: 100 }, limits),
        ).toEqual([])
    })
})

describe("splitMergeBatches", () => {
    const tx = (hash: string, pad = 0) =>
        ({ hash, content: { pad: "x".repeat(pad) }, signature: {} }) as never

    it("keeps a pool within the caps as one request", () => {
        const pool = [tx("a"), tx("b"), tx("c")]
        expect(splitMergeBatches(pool)).toEqual([pool])
    })

    it("still sends one empty request for an empty pool", () => {
        expect(splitMergeBatches([])).toEqual([[]])
    })

    it("never lets a request exceed the count cap and keeps order", () => {
        __setMempoolLimits({ maxTxs: 2 })
        const pool = [tx("a"), tx("b"), tx("c"), tx("d"), tx("e")]
        const batches = splitMergeBatches(pool)
        expect(batches.map(b => b.length)).toEqual([2, 2, 1])
        expect(batches.flat()).toEqual(pool)
    })

    it("accepts a pool one over the cap, as an own relay tx makes it", () => {
        __setMempoolLimits({ maxTxs: 3 })
        const batches = splitMergeBatches([tx("a"), tx("b"), tx("c"), tx("d")])
        expect(batches.map(b => b.length)).toEqual([3, 1])
    })

    it("never lets a request exceed the byte cap, and ships an oversized tx alone", () => {
        const one = txWireBytes(tx("a", 100))
        __setMempoolLimits({ mergeMaxBytes: one * 2 + 5 })
        const batches = splitMergeBatches([tx("a", 100), tx("b", 100), tx("c", 100), tx("big", 5000)])
        expect(batches.map(b => b.length)).toEqual([2, 1, 1])
    })

    it("keeps every request of a pool larger than a frame inside one frame", () => {
        // 20 MiB of txs, far under the count cap: one request at the old
        // byte cap, which no Omni frame can carry.
        const pool = Array.from({ length: 200 }, (_, i) => tx(`0x${i}`, 100 * 1024))
        const batches = splitMergeBatches(pool)
        expect(batches.length).toBeGreaterThan(1)
        expect(batches.flat()).toEqual(pool)
        for (const batch of batches) {
            const request = JSON.stringify({ txs: batch, peerlist: [], blockRef: 1 })
            expect(Buffer.byteLength(request)).toBeLessThan(MessageFramer.MAX_PAYLOAD_SIZE)
        }
    })
})

describe("a full pool in one merge exchange", () => {
    // A pool row as getMempool returns it, every column at its widest.
    const row = (i: number, pad: number) => ({
        hash: "0x" + i.toString(16).padStart(64, "0"),
        content: { type: "native", from: "0x" + "a".repeat(64), pad: "x".repeat(pad) },
        signature: { type: "ed25519", data: "f".repeat(128) },
        ed25519_signature: null,
        status: "pending",
        blockNumber: 2_147_483_647,
        extra: null,
        nonce: "9007199254740991",
        reference_block: 2_147_483_647,
        timestamp: "999999999999999",
    })

    it("fits one request and one Omni frame at both pool caps", () => {
        const { maxTxs, maxBytes, mergeMaxBytes } = getMempoolLimits()
        const base = txStoredBytes(row(0, 0) as never)
        const pad = Math.floor(maxBytes / maxTxs) - base
        expect(pad).toBeGreaterThan(0)
        const pool = Array.from({ length: maxTxs }, (_, i) => row(i, pad))
        const stored = pool.reduce((sum, r) => sum + txStoredBytes(r as never), 0)
        expect(stored).toBeLessThanOrEqual(maxBytes)

        expect(splitMergeBatches(pool)).toHaveLength(1)
        expect(capMergeReply(pool)).toHaveLength(maxTxs)
        const wire = Buffer.byteLength(JSON.stringify({ txs: pool, peerlist: [] }))
        expect(wire).toBeLessThanOrEqual(mergeMaxBytes + 1024)
        expect(mergeMaxBytes).toBeLessThan(MessageFramer.MAX_PAYLOAD_SIZE - 1024 * 1024)
    })
})

describe("capMergeReply", () => {
    const tx = (hash: string, pad = 0) =>
        ({ hash, content: { pad: "x".repeat(pad) }, signature: {} }) as never

    it("returns the leading txs that fit one request, in order", () => {
        const one = txWireBytes(tx("a", 100))
        __setMempoolLimits({ mergeMaxBytes: one * 2 + 5 })
        expect(capMergeReply([tx("a", 100), tx("b", 100), tx("c", 100)])).toEqual([
            tx("a", 100),
            tx("b", 100),
        ])
    })

    it("returns the whole list when it fits", () => {
        const pool = [tx("a"), tx("b")]
        expect(capMergeReply(pool)).toEqual(pool)
    })
})
